// AvaShop: a IA vendendo produto físico 24h sem humano. Fotos no WhatsApp, variações e estoque,
// frete (Melhor Envio, entrega própria, retirada), pedido com pagamento, etiqueta, rastreio e avisos.
import crypto from 'node:crypto';
import express from 'express';
import { db, logActivity } from './db.js';
import { getPlan } from './plans.js';
import { criarCobranca, publicUrl } from './payments.js';
import { garantirLead, agendarEm, enviarAoCliente, avisarResponsavel, cancelarJobsDoContato } from './vendas.js';
import { aoConfirmarPagamento, HANDLERS } from './ganchos.js';
import { pagina, esc, brl } from './report.js';
import { pode } from './auth.js';
import { efetivoDoContato } from './agents.js';

// ======================= Banco =======================
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
const pCols = cols('products');
for (const [c, d] of [['estoque', 'INTEGER'], ['variacoes', 'TEXT'], ['peso_g', 'INTEGER'], ['altura_cm', 'REAL'], ['largura_cm', 'REAL'], ['comprimento_cm', 'REAL'],
  ['categoria', 'TEXT'], ['atributos', 'TEXT'], ['preco_promocional', 'REAL'], ['sku', 'TEXT']]) if (!pCols.includes(c)) db.exec(`ALTER TABLE products ADD COLUMN ${c} ${d}`);
const tCols = cols('tenants');
for (const [c, d] of [['loja_ativa', 'INTEGER NOT NULL DEFAULT 0'], ['loja_slug', 'TEXT'], ['loja_descricao', 'TEXT'], ['cep_origem', 'TEXT'],
  ['melhorenvio_token', 'TEXT'], ['melhorenvio_sandbox', 'INTEGER NOT NULL DEFAULT 0'], ['entrega_local', 'TEXT'], ['retirada_endereco', 'TEXT'],
  ['frete_gratis_acima', 'REAL'], ['etiqueta_automatica', 'INTEGER NOT NULL DEFAULT 0'], ['remetente', 'TEXT']])
  if (!tCols.includes(c)) db.exec(`ALTER TABLE tenants ADD COLUMN ${c} ${d}`);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_loja_slug ON tenants(loja_slug)');
if (!cols('charges').includes('order_id')) db.exec('ALTER TABLE charges ADD COLUMN order_id INTEGER');
db.exec(`
CREATE TABLE IF NOT EXISTS product_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL,
  mime TEXT NOT NULL,
  dados BLOB NOT NULL,
  ordem INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pimg ON product_images(product_id, ordem);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  numero INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'aguardando_pagamento', -- aguardando_pagamento | pago | separando | enviado | entregue | cancelado
  itens TEXT NOT NULL,
  subtotal REAL NOT NULL, frete REAL NOT NULL DEFAULT 0, total REAL NOT NULL,
  entrega TEXT,                 -- JSON {codigo, tipo, nome, prazo, me_service}
  cliente_nome TEXT, cliente_doc TEXT, endereco TEXT,   -- endereco JSON
  charge_id INTEGER, me_order_id TEXT, rastreio TEXT, rastreio_url TEXT, observacoes TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')), pago_em TEXT, enviado_em TEXT, entregue_em TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders ON orders(tenant_id, status);
`);

// ======================= Utilitários =======================
const r2 = (v) => Math.round(v * 100) / 100;
const json = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const cepOk = (c) => /^\d{8}$/.test(String(c || '').replace(/\D/g, ''));
const soCep = (c) => String(c || '').replace(/\D/g, '');
const primeiroNome = (c) => (c?.nome || '').trim().split(/\s+/)[0] || '';
export const fotoUrl = (id) => `${publicUrl()}/img/p/${id}`;
export const fotosDoProduto = (pid) => db.prepare('SELECT id FROM product_images WHERE product_id = ? ORDER BY ordem, id').all(pid).map((f) => f.id);
const produtosLoja = (tid) => db.prepare('SELECT * FROM products WHERE tenant_id = ? AND ativo = 1 ORDER BY categoria, nome').all(tid);

export function slugify(s) {
  return String(s || 'loja').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'loja';
}
export function garantirSlug(t) {
  if (t.loja_slug) return t.loja_slug;
  let base = slugify(t.nome), slug = base, i = 2;
  while (db.prepare('SELECT 1 FROM tenants WHERE loja_slug = ?').get(slug)) slug = `${base}-${i++}`;
  db.prepare('UPDATE tenants SET loja_slug = ? WHERE id = ?').run(slug, t.id);
  return slug;
}

function acharProduto(tid, ref) {
  const ps = produtosLoja(tid);
  const n = Number(ref);
  if (Number.isInteger(n) && n > 0) { const p = ps.find((x) => x.id === n); if (p) return p; }
  const s = String(ref || '').toLowerCase().trim();
  return ps.find((p) => p.nome.toLowerCase() === s) || ps.find((p) => p.nome.toLowerCase().includes(s) || s.includes(p.nome.toLowerCase())) || null;
}
// Variações: atributos (ex.: Cor, Tamanho, Modelo) e combinações, cada uma com preço, promoção, estoque, SKU, peso e foto próprios.
// Formato de cada combinação: { nome: 'Azul / M', opcoes: { Cor: 'Azul', Tamanho: 'M' }, preco, preco_promocional, estoque, sku, peso_g, foto_id, ativo }
export const todasVariacoes = (p) => json(p.variacoes, []).filter((v) => v && v.nome);
const variacoesDe = (p) => todasVariacoes(p).filter((v) => v.ativo !== false);
export const atributosDe = (p) => json(p.atributos, []).filter((a) => a?.nome && a.opcoes?.length);
const norm = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** Encontra a combinação pelo texto do cliente ("azul M", "M azul", "Azul / M", "modelo pro"). */
export function casarVariacao(p, texto) {
  const vs = variacoesDe(p); const t = norm(texto);
  if (!t || !vs.length) return null;
  const exata = vs.find((v) => norm(v.nome) === t); if (exata) return exata;
  const toks = new Set(t.split(' '));
  const valores = (v) => (v.opcoes && Object.keys(v.opcoes).length ? Object.values(v.opcoes) : String(v.nome).split(/\s*[\/|,;]\s*/));
  const todas = vs.filter((v) => valores(v).every((val) => norm(val).split(' ').every((w) => toks.has(w))));
  if (todas.length === 1) return todas[0];
  const contem = vs.filter((v) => norm(v.nome).includes(t));
  return contem.length === 1 ? contem[0] : null;
}
const precoBase = (p) => Number(p.preco_promocional || p.preco);
export const precoVar = (p, v) => Number(v ? (v.preco_promocional || v.preco || precoBase(p)) : precoBase(p));
export function faixaPreco(p) {
  const vs = variacoesDe(p); if (!vs.length) return { min: precoBase(p), max: precoBase(p) };
  const ps = vs.map((v) => precoVar(p, v)); return { min: Math.min(...ps), max: Math.max(...ps) };
}
const estoqueDe = (p, v) => (v ? (v.estoque == null || v.estoque === '' ? Infinity : Number(v.estoque)) : (p.estoque == null ? Infinity : Number(p.estoque)));
function opcoesTexto(p) {
  const at = atributosDe(p);
  if (at.length) return at.map((a) => `${a.nome}: ${a.opcoes.join(', ')}`).join('; ');
  return variacoesDe(p).map((v) => v.nome).join(', ');
}

/** Valida os itens do pedido contra catálogo, variações e estoque. Lança Error com mensagem para a IA. */
export function montarItens(tid, itens) {
  if (!Array.isArray(itens) || !itens.length) throw new Error('Informe os produtos e as quantidades.');
  return itens.map((it) => {
    const p = acharProduto(tid, it.produto);
    if (!p) throw new Error(`"${it.produto}" não está no catálogo. Ofereça um produto do catálogo.`);
    const qtd = Math.max(1, Math.floor(Number(it.quantidade || 1)));
    const vs = variacoesDe(p);
    let v = null;
    if (vs.length) {
      if (!it.variacao) throw new Error(`Pergunte qual opção de ${p.nome} o cliente quer (${opcoesTexto(p)}).`);
      v = casarVariacao(p, it.variacao);
      if (!v) throw new Error(`Não encontrei "${it.variacao}" em ${p.nome}. Opções: ${opcoesTexto(p)}. Confirme com o cliente.`);
    }
    const disp = estoqueDe(p, v);
    if (disp < qtd) throw new Error(disp <= 0 ? `${p.nome}${v ? ' ' + v.nome : ''} está esgotado. Ofereça outra opção.` : `Só temos ${disp} unidade(s) de ${p.nome}${v ? ' ' + v.nome : ''}.`);
    const preco = precoVar(p, v);
    return { produto_id: p.id, nome: p.nome, variacao: v ? v.nome : null, sku: v?.sku || p.sku || null, quantidade: qtd, preco, total: r2(preco * qtd),
      peso_g: Number(v?.peso_g || p.peso_g || 300), altura_cm: p.altura_cm || 5, largura_cm: p.largura_cm || 11, comprimento_cm: p.comprimento_cm || 16 };
  });
}

// ======================= Frete =======================
const meBase = (t) => (t.melhorenvio_sandbox ? 'https://sandbox.melhorenvio.com.br' : 'https://melhorenvio.com.br');
async function me(t, path, body) {
  const res = await fetch(meBase(t) + '/api/v2' + path, {
    method: body ? 'POST' : 'GET',
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${t.melhorenvio_token}`, 'user-agent': 'AVA Connect (contato@grupoavantte.com.br)' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `Melhor Envio ${res.status}`);
  return data;
}

/** Opções de entrega para o CEP. Retorna [{codigo, tipo, nome, preco, prazo, me_service}]. */
export async function cotarFrete(t, cep, itens) {
  cep = soCep(cep);
  if (!cepOk(cep)) throw new Error('CEP inválido. Peça o CEP com 8 números.');
  const subtotal = itens.reduce((s, i) => s + i.total, 0);
  const gratis = t.frete_gratis_acima && subtotal >= Number(t.frete_gratis_acima);
  const ops = [];
  const local = json(t.entrega_local, null);
  if (local?.ceps && String(local.ceps).split(/[,\s;]+/).filter(Boolean).some((pre) => cep.startsWith(soCep(pre))))
    ops.push({ codigo: 'local', tipo: 'local', nome: local.nome || 'Entrega própria', preco: gratis ? 0 : Number(local.taxa || 0), prazo: local.prazo || 'combinar' });
  if (t.retirada_endereco) ops.push({ codigo: 'retirada', tipo: 'retirada', nome: `Retirar em: ${t.retirada_endereco}`, preco: 0, prazo: 'após a confirmação do pagamento' });
  if (t.melhorenvio_token && t.cep_origem) {
    try {
      const r = await me(t, '/me/shipment/calculate', {
        from: { postal_code: soCep(t.cep_origem) }, to: { postal_code: cep },
        products: itens.map((i, k) => ({ id: String(k + 1), width: i.largura_cm, height: i.altura_cm, length: i.comprimento_cm, weight: i.peso_g / 1000,
          insurance_value: i.preco, quantity: i.quantidade })),
      });
      const validas = (Array.isArray(r) ? r : []).filter((s) => !s.error && s.price).sort((a, b) => Number(a.price) - Number(b.price)).slice(0, 4);
      validas.forEach((s, k) => ops.push({ codigo: `me_${s.id}`, tipo: 'melhorenvio', nome: `${s.name} (${s.company?.name || ''})`.replace(' ()', ''),
        preco: gratis && k === 0 ? 0 : r2(Number(s.custom_price || s.price)), prazo: `${s.custom_delivery_time || s.delivery_time} dia(s) útil(eis)`, me_service: s.id }));
    } catch (e) { console.error('[loja] cotação', e.message); }
  }
  if (!ops.length) throw new Error('Não há entrega configurada para esse CEP. Passe para um atendente para combinar a entrega.');
  return ops;
}

// ======================= Pedido =======================
const getPedido = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const STATUS_NOME = { aguardando_pagamento: 'aguardando pagamento', pago: 'pago, em separação', separando: 'em separação', enviado: 'enviado', entregue: 'entregue', cancelado: 'cancelado' };

function resumoPedido(o) {
  const itens = json(o.itens, []); const ent = json(o.entrega, {});
  return itens.map((i) => `• ${i.quantidade}x ${i.nome}${i.variacao ? ` (${i.variacao})` : ''}: ${brl(i.total)}`).join('\n') +
    `\nEntrega: ${ent.nome} — ${o.frete > 0 ? brl(o.frete) : 'grátis'} (${ent.prazo})\n*Total: ${brl(o.total)}*`;
}

/** ctx = { tenant, contact, conv, enviar } */
export async function criarPedido(ctx, input) {
  const { tenant: t, contact, conv } = ctx;
  const itens = montarItens(t.id, input.itens);
  const cep = soCep(input.cep);
  const ops = await cotarFrete(t, cep, itens);
  const op = ops.find((o) => o.codigo === input.entrega) || (ops.length === 1 ? ops[0] : null);
  if (!op) return `Confirme a forma de entrega com o cliente. Opções: ${ops.map((o) => `[${o.codigo}] ${o.nome} ${o.preco ? brl(o.preco) : 'grátis'} (${o.prazo})`).join('; ')}.`;
  const end = input.endereco || {};
  if (op.tipo !== 'retirada' && (!end.rua || !end.numero || !end.bairro || !end.cidade))
    return 'Peça o endereço completo de entrega (rua, número, complemento, bairro, cidade e UF) antes de criar o pedido.';
  if (!input.nome) return 'Peça o nome completo de quem vai receber.';
  if (op.tipo === 'melhorenvio' && !/^\d{11}$|^\d{14}$/.test(String(input.cpf || '').replace(/\D/g, ''))) return 'Para envio pela transportadora, peça o CPF de quem vai receber (vai na etiqueta).';

  const subtotal = r2(itens.reduce((s, i) => s + i.total, 0));
  const total = r2(subtotal + op.preco);
  db.prepare("UPDATE orders SET status = 'cancelado', observacoes = 'Substituído por novo pedido' WHERE contact_id = ? AND status = 'aguardando_pagamento'").run(contact.id);
  const numero = db.prepare('SELECT COALESCE(MAX(numero), 1000) + 1 n FROM orders WHERE tenant_id = ?').get(t.id).n;
  const token = 'ped_' + crypto.randomBytes(12).toString('hex');
  const r = db.prepare(`INSERT INTO orders (tenant_id, contact_id, numero, token, itens, subtotal, frete, total, entrega, cliente_nome, cliente_doc, endereco)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(t.id, contact.id, numero, token, JSON.stringify(itens), subtotal, op.preco, total, JSON.stringify(op),
    input.nome, String(input.cpf || '').replace(/\D/g, '') || null, JSON.stringify({ ...end, cep }));
  const o = getPedido(r.lastInsertRowid);
  if (input.nome && !contact.nome) db.prepare('UPDATE contacts SET nome = ? WHERE id = ?').run(input.nome, contact.id);

  // Cobrança na conta Asaas da própria loja.
  const forma = ['pix', 'boleto', 'cartao'].includes(input.forma) ? input.forma : 'livre';
  const parcelas = forma === 'cartao' ? Math.max(1, Math.min(Number(input.parcelas) || 1, Number(t.parcelas_max) || 1)) : 1;
  const ctoken = 'cob_' + crypto.randomBytes(14).toString('hex');
  const descricao = `Pedido nº ${numero} — ${t.nome}`;
  let url;
  let pix = null;
  try { ({ url } = await criarCobranca(t, { token: ctoken, valor: total, descricao, forma, parcelas, vencimentoDias: 1,
    cliente: { nome: input.nome || contact.nome, telefone: contact.telefone } }).then((x) => {
    const c = db.prepare(`INSERT INTO charges (tenant_id, contact_id, token, descricao, valor, forma, parcelas, pagamento_ref, pagamento_url, order_id, gateway, pix_copia_cola) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(t.id, contact.id, ctoken, descricao, total, forma, parcelas, x.ref, x.url, o.id, x.gateway || null, x.pix || null);
    pix = x.pix || null;
    db.prepare('UPDATE orders SET charge_id = ? WHERE id = ?').run(c.lastInsertRowid, o.id);
    return x;
  })); } catch (e) {
    console.error('[loja] cobrança', e.message);
    const lead = garantirLead(t, contact, conv);
    logActivity(t.id, lead.id, `Enviar link de pagamento do pedido nº ${numero} (${brl(total)}) — o sistema não conseguiu gerar: ${e.message}`, { tipo: 'tarefa', autor: 'sistema', vence_em: new Date().toISOString().slice(0, 10) });
    return `Pedido nº ${numero} registrado (${brl(total)}), mas não foi possível gerar o link de pagamento agora. Avise que a equipe envia o link em instantes.`;
  }
  const lead = garantirLead(t, contact, conv);
  db.prepare("UPDATE leads SET etapa = 'proposta', valor_estimado = ?, interesse = COALESCE(interesse, ?), atualizado_em = datetime('now') WHERE id = ?").run(total, `Pedido nº ${numero}`, lead.id);
  logActivity(t.id, lead.id, `🛒 Pedido nº ${numero} criado pela IA: ${brl(total)}`, { autor: 'ia' });
  cancelarJobsDoContato(contact.id, ['reengajar', 'carrinho_parado']);
  if (t.cadencia_ativa) {
    const ch = db.prepare('SELECT id FROM charges WHERE order_id = ?').get(o.id);
    [180, 1440].forEach((min, i) => agendarEm('lembrete_pagamento', { charge_id: ch.id, contact_id: contact.id, tentativa: i + 1 }, new Date(Date.now() + min * 60000)));
  }
  if (pix) {
    await ctx.enviar(`🛒 *Pedido nº ${numero} — ${t.nome}*\n${resumoPedido(getPedido(o.id))}\n\n` +
      `Pague pelo Pix copia e cola (próxima mensagem) ou pelo QR Code: ${url}\nDepois de pagar, me envie o comprovante por aqui.\n\n` +
      'Você pode desistir da compra em até 7 dias após receber, conforme o Código de Defesa do Consumidor.');
    await ctx.enviar(pix);
    return `Pedido nº ${numero} enviado com o Pix copia e cola (total ${brl(total)}). É Pix direto na conta da loja: a confirmação é manual. Peça o comprovante e nunca diga que o pagamento foi confirmado; a equipe confirma no painel.`;
  }
  await ctx.enviar(`🛒 *Pedido nº ${numero} — ${t.nome}*\n${resumoPedido(getPedido(o.id))}\n\n` +
    `Pague com segurança (${forma === 'livre' ? 'Pix, boleto ou cartão' : forma === 'cartao' ? `cartão${parcelas > 1 ? ` em até ${parcelas}x` : ''}` : forma === 'pix' ? 'Pix' : 'boleto'}):\n${url}\n\n` +
    'Você pode desistir da compra em até 7 dias após receber, conforme o Código de Defesa do Consumidor.');
  return `Pedido nº ${numero} enviado ao cliente com o resumo e o link de pagamento (total ${brl(total)}). Não repita valores nem o link. Diga, em uma frase, que assim que o pagamento cair você confirma e avisa o envio.`;
}

async function enviarMelhorEnvio(t, o) {
  const rem = json(t.remetente, {});
  const end = json(o.endereco, {}); const ent = json(o.entrega, {}); const itens = json(o.itens, []);
  const pacote = { weight: itens.reduce((s, i) => s + (i.peso_g * i.quantidade), 0) / 1000,
    width: Math.max(...itens.map((i) => i.largura_cm)), height: itens.reduce((s, i) => s + i.altura_cm * i.quantidade, 0), length: Math.max(...itens.map((i) => i.comprimento_cm)) };
  const cart = await me(t, '/me/cart', {
    service: ent.me_service,
    from: { name: rem.nome || t.nome, phone: rem.telefone || t.telefone_responsavel, document: rem.cpf || undefined, company_document: rem.cnpj || t.cpf_cnpj || undefined,
      address: rem.rua, number: rem.numero, complement: rem.complemento, district: rem.bairro, city: rem.cidade, state_abbr: rem.uf, postal_code: soCep(t.cep_origem) },
    to: { name: o.cliente_nome, phone: db.prepare('SELECT telefone FROM contacts WHERE id = ?').get(o.contact_id).telefone, document: o.cliente_doc,
      address: end.rua, number: end.numero, complement: end.complemento, district: end.bairro, city: end.cidade, state_abbr: end.uf, postal_code: end.cep },
    products: itens.map((i) => ({ name: i.nome + (i.variacao ? ` ${i.variacao}` : ''), quantity: i.quantidade, unitary_value: i.preco })),
    volumes: [pacote], options: { insurance_value: o.subtotal, receipt: false, own_hand: false, non_commercial: true, platform: 'AVA Connect', tags: [{ tag: `Pedido ${o.numero}` }] },
  });
  db.prepare('UPDATE orders SET me_order_id = ? WHERE id = ?').run(cart.id, o.id);
  if (t.etiqueta_automatica) {
    await me(t, '/me/shipment/checkout', { orders: [cart.id] });
    await me(t, '/me/shipment/generate', { orders: [cart.id] });
  }
  return cart.id;
}

// Pagamento confirmado: baixa de estoque, confirmação ao cliente, aviso à loja, etiqueta e rastreio.
aoConfirmarPagamento.push(async (charge) => {
  if (!charge.order_id) return;
  const o = getPedido(charge.order_id);
  if (!o || o.status !== 'aguardando_pagamento') return;
  db.prepare("UPDATE orders SET status = 'pago', pago_em = datetime('now') WHERE id = ?").run(o.id);
  for (const i of json(o.itens, [])) {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(i.produto_id); if (!p) continue;
    if (i.variacao) {
      const vs = todasVariacoes(p).map((v) => (v.nome === i.variacao && v.estoque != null && v.estoque !== '' ? { ...v, estoque: Math.max(0, Number(v.estoque) - i.quantidade) } : v));
      db.prepare('UPDATE products SET variacoes = ? WHERE id = ?').run(JSON.stringify(vs), p.id);
    } else if (p.estoque != null) db.prepare('UPDATE products SET estoque = MAX(0, estoque - ?) WHERE id = ?').run(i.quantidade, p.id);
  }
  const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(o.tenant_id);
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(o.contact_id);
  const ent = json(o.entrega, {});
  await enviarAoCliente(t, contact, `✅ Pagamento do pedido nº ${o.numero} confirmado! Obrigado${primeiroNome(contact) ? ', ' + primeiroNome(contact) : ''}.\n\n` +
    (ent.tipo === 'retirada' ? `Seu pedido fica pronto para retirada em: ${t.retirada_endereco}. Eu te aviso quando estiver separado.`
      : `Entrega: ${ent.nome} (${ent.prazo}). Assim que for despachado, te mando o código de rastreio aqui.`), { motivoTarefa: `Confirmar pedido nº ${o.numero}`,
      modelo: { chave: 'shop_pagamento_confirmado', params: [primeiroNome(contact) || 'tudo bem', o.numero] } });
  await avisarResponsavel(t, `🛒 Pedido nº ${o.numero} pago (${brl(o.total)}) — ${o.cliente_nome || contact.telefone}. Separar e enviar: ${ent.nome}.`);
  const lead = garantirLead(t, contact, null);
  logActivity(t.id, lead.id, `Separar e enviar o pedido nº ${o.numero}`, { tipo: 'tarefa', autor: 'sistema', vence_em: new Date().toISOString().slice(0, 10) });
  if (ent.tipo === 'melhorenvio' && t.melhorenvio_token) {
    try { await enviarMelhorEnvio(t, getPedido(o.id)); agendarEm('rastrear_pedido', { order_id: o.id, contact_id: o.contact_id, n: 1 }, new Date(Date.now() + 6 * 3600e3)); }
    catch (e) { logActivity(t.id, lead.id, `Gerar a etiqueta do pedido nº ${o.numero} no Melhor Envio (automático falhou: ${e.message})`, { tipo: 'tarefa', autor: 'sistema', vence_em: new Date().toISOString().slice(0, 10) }); }
  }
});

/** Muda o status do pedido e avisa o cliente. */
export async function atualizarPedido(o, status, { rastreio, rastreio_url } = {}) {
  if (!STATUS_NOME[status]) throw new Error('Status inválido');
  const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(o.tenant_id);
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(o.contact_id);
  const col = { enviado: 'enviado_em', entregue: 'entregue_em' }[status];
  db.prepare(`UPDATE orders SET status = ?, rastreio = COALESCE(?, rastreio), rastreio_url = COALESCE(?, rastreio_url)${col ? `, ${col} = datetime('now')` : ''} WHERE id = ?`)
    .run(status, rastreio || null, rastreio_url || null, o.id);
  const x = getPedido(o.id); const ent = json(x.entrega, {});
  const nome = primeiroNome(contact);
  const msg = {
    separando: ent.tipo === 'retirada' ? `${nome ? nome + ', s' : 'S'}eu pedido nº ${x.numero} está pronto para retirada em: ${t.retirada_endereco}.` : null,
    enviado: `📦 ${nome ? nome + ', s' : 'S'}eu pedido nº ${x.numero} foi enviado!` + (x.rastreio ? `\nCódigo de rastreio: ${x.rastreio}` : '') +
      (x.rastreio_url || x.rastreio ? `\nAcompanhe: ${x.rastreio_url || `https://www.melhorrastreio.com.br/rastreio/${x.rastreio}`}` : ''),
    entregue: `🎉 Pedido nº ${x.numero} entregue! Espero que goste${nome ? ', ' + nome : ''}. Qualquer coisa, é só me chamar aqui.`,
    cancelado: `O pedido nº ${x.numero} foi cancelado. Se quiser, posso montar um novo para você.`,
  }[status];
  const n = nome || 'tudo bem';
  const modelo = { separando: ent.tipo === 'retirada' ? { chave: 'shop_pronto_retirada', params: [n, x.numero, t.retirada_endereco] } : null,
    enviado: { chave: 'shop_pedido_enviado', params: [n, x.numero, x.rastreio || 'informado em breve'] },
    entregue: { chave: 'shop_pedido_entregue', params: [n, x.numero] }, cancelado: { chave: 'shop_pedido_cancelado', params: [n, x.numero] } }[status];
  if (msg) await enviarAoCliente(t, contact, msg, { motivoTarefa: `Avisar pedido nº ${x.numero} ${STATUS_NOME[status]}`, modelo });
  return x;
}

// Cliente viu o frete e não fechou: retoma a venda (até 2 vezes, dentro da janela de 24h).
HANDLERS.carrinho_parado = async ({ contact_id, desde, ultima_msg = 0, resumo, tentativa }) => {
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact_id);
  const t = contact && db.prepare('SELECT * FROM tenants WHERE id = ?').get(contact.tenant_id);
  if (!t || t.status !== 'ativo' || !t.loja_ativa) return 'loja inativa';
  if (db.prepare('SELECT 1 FROM orders WHERE contact_id = ? AND criado_em >= ?').get(contact_id, desde)) return 'já fez o pedido';
  const conv = db.prepare('SELECT id, status FROM conversations WHERE contact_id = ? ORDER BY id DESC LIMIT 1').get(contact_id);
  if (conv?.status === 'humano') return 'com atendente';
  if (db.prepare("SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.contact_id = ? AND m.autor = 'cliente' AND m.id > ?").get(contact_id, ultima_msg)) return 'cliente respondeu';
  const nome = (contact.nome || '').split(' ')[0];
  const padrao = tentativa === 1
    ? `Oi${nome ? ', ' + nome : ''}! Ficou alguma dúvida sobre ${resumo} ou sobre a entrega? Se quiser, já deixo o pedido pronto: é só me confirmar a forma de entrega.`
    : `${nome ? nome + ', ' : ''}ainda tenho ${resumo} separado para você. Quer que eu finalize o pedido? Posso fazer no Pix, boleto ou cartão.`;
  let texto = padrao;
  try {
    const { gerarMensagem } = await import('./ai.js');
    const hist = db.prepare('SELECT m.autor, m.conteudo FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.contact_id = ? ORDER BY m.id DESC LIMIT 20').all(contact_id).reverse();
    texto = (await gerarMensagem(efetivoDoContato(t, contact_id),
      `O cliente consultou o frete de ${resumo} e parou de responder. Escreva uma mensagem curta e simpática para retomar a compra${tentativa > 1 ? ' (é a última tentativa, sem pressão)' : ''}, perguntando se pode finalizar o pedido. Não invente desconto.`, hist, contact.nome)) || padrao;
  } catch {}
  const r = await enviarAoCliente(t, contact, texto, { motivoTarefa: `Retomar compra parada: ${resumo}`,
    modelo: contact.optout ? null : { chave: 'shop_carrinho_parado', params: [nome || 'tudo bem', t.nome, resumo] } });
  cancelarJobsDoContato(contact_id, ['reengajar']);
  const lead = garantirLead(t, contact, null);
  logActivity(t.id, lead.id, `🛒 IA retomou a compra parada (${resumo}): ${r}`, { autor: 'ia' });
  return r;
};

HANDLERS.rastrear_pedido = async ({ order_id, n }) => {
  const o = getPedido(order_id);
  if (!o || !o.me_order_id || ['entregue', 'cancelado'].includes(o.status)) return 'nada a fazer';
  const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(o.tenant_id);
  try {
    const r = await me(t, '/me/shipment/tracking', { orders: [o.me_order_id] });
    const info = r?.[o.me_order_id] || Object.values(r || {})[0] || {};
    if (info.tracking && o.status !== 'enviado' && ['posted', 'delivered'].includes(info.status)) await atualizarPedido(o, 'enviado', { rastreio: info.tracking });
    if (info.status === 'delivered') { await atualizarPedido(getPedido(o.id), 'entregue'); return 'entregue'; }
  } catch (e) { console.error('[loja] rastreio', e.message); }
  if (n < 40) agendarEm('rastrear_pedido', { order_id, contact_id: o.contact_id, n: n + 1 }, new Date(Date.now() + 6 * 3600e3));
  return 'acompanhando';
};

// ======================= IA da loja =======================
export function ferramentasLoja(t) {
  if (!t.loja_ativa_efetiva) return [];
  return [
    { name: 'ver_produto', description: 'Envia ao cliente as fotos e os detalhes de um produto do catálogo (preços por opção, disponibilidade). Informe a variação para mostrar a foto e o preço daquela combinação.',
      input_schema: { type: 'object', properties: { produto: { type: 'string', description: 'Código [n] ou nome do produto' },
        variacao: { type: 'string', description: 'Opcional: combinação escolhida, ex.: "Azul / M"' } }, required: ['produto'] } },
    { name: 'calcular_frete', description: 'Calcula as opções de entrega e o frete para o CEP do cliente.',
      input_schema: { type: 'object', properties: { cep: { type: 'string' }, itens: { type: 'array', items: { type: 'object', properties: {
        produto: { type: 'string' }, variacao: { type: 'string' }, quantidade: { type: 'number' } }, required: ['produto'] } } }, required: ['cep', 'itens'] } },
    { name: 'criar_pedido', description: 'Cria o pedido e envia o link de pagamento. Use quando o cliente confirmar produtos, opção, entrega, endereço e forma de pagamento.',
      input_schema: { type: 'object', properties: {
        itens: { type: 'array', items: { type: 'object', properties: { produto: { type: 'string' }, variacao: { type: 'string' }, quantidade: { type: 'number' } }, required: ['produto', 'quantidade'] } },
        cep: { type: 'string' }, entrega: { type: 'string', description: 'Código da opção escolhida em calcular_frete (ex.: me_1, local, retirada)' },
        endereco: { type: 'object', properties: { rua: { type: 'string' }, numero: { type: 'string' }, complemento: { type: 'string' }, bairro: { type: 'string' }, cidade: { type: 'string' }, uf: { type: 'string' } } },
        nome: { type: 'string', description: 'Nome completo de quem recebe' }, cpf: { type: 'string', description: 'CPF de quem recebe (obrigatório para transportadora)' },
        forma: { type: 'string', enum: ['pix', 'boleto', 'cartao', 'livre'] }, parcelas: { type: 'number' } }, required: ['itens', 'cep', 'nome'] } },
    { name: 'consultar_pedido', description: 'Consulta a situação e o rastreio dos pedidos do cliente.',
      input_schema: { type: 'object', properties: { numero: { type: 'number' } }, required: [] } },
  ];
}

export async function executarFerramentaLoja(ctx, nome, input) {
  const { tenant: t, contact } = ctx;
  if (!ferramentasLoja(t).some((f) => f.name === nome)) return null;
  try {
    if (nome === 'ver_produto') {
      const p = acharProduto(t.id, input.produto);
      if (!p) return 'Produto não encontrado no catálogo. Ofereça os produtos disponíveis.';
      const vs = variacoesDe(p);
      const v = input.variacao ? casarVariacao(p, input.variacao) : null;
      const promo = (preco, de) => (de && de > preco ? `~${brl(de)}~ por *${brl(preco)}*` : `*${brl(preco)}*`);
      let legenda;
      if (v) {
        const est = estoqueDe(p, v);
        legenda = `*${p.nome}* — ${v.nome}\n${promo(precoVar(p, v), v.preco_promocional ? Number(v.preco || p.preco) : null)}${est <= 0 ? '\n(esgotado no momento)' : est < 5 ? `\nÚltimas ${est} unidades` : ''}`;
      } else {
        const f = faixaPreco(p);
        legenda = `*${p.nome}* — ${f.min !== f.max ? `a partir de *${brl(f.min)}*` : promo(f.min, !vs.length && p.preco_promocional ? Number(p.preco) : null)}${p.descricao ? `\n${p.descricao}` : ''}`;
        if (vs.length) {
          const linhas = vs.slice(0, 15).map((x) => `• ${x.nome}: ${brl(precoVar(p, x))}${estoqueDe(p, x) <= 0 ? ' (esgotado)' : ''}`);
          legenda += `\n${linhas.join('\n')}${vs.length > 15 ? `\n… e mais ${vs.length - 15} opções (${opcoesTexto(p)})` : ''}`;
        } else if (p.estoque != null && p.estoque <= 0) legenda += '\n(esgotado no momento)';
      }
      const todas = fotosDoProduto(p.id);
      const fotos = (v?.foto_id && todas.includes(Number(v.foto_id)) ? [Number(v.foto_id)] : todas).slice(0, v ? 1 : 3);
      if (fotos.length) for (const [i, f] of fotos.entries()) await ctx.enviarImagem(fotoUrl(f), i === 0 ? legenda : '');
      else await ctx.enviar(legenda);
      return `Detalhes${fotos.length ? ' e fotos' : ''} de ${p.nome}${v ? ' ' + v.nome : ''} enviados. Não repita preços e opções; pergunte o que o cliente achou${vs.length && !v ? ' e qual opção prefere' : ''}.`;
    }
    if (nome === 'calcular_frete') {
      const itens = montarItens(t.id, input.itens);
      const ops = await cotarFrete(t, input.cep, itens);
      // Recuperação: se o cliente sumir depois de ver o frete, a IA retoma a venda.
      if (t.cadencia_ativa) {
        cancelarJobsDoContato(contact.id, ['carrinho_parado']);
        const desde = new Date().toISOString().slice(0, 19).replace('T', ' ');
        const ultimaMsg = db.prepare('SELECT MAX(m.id) id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.contact_id = ?').get(contact.id).id || 0;
        const resumo = itens.map((i) => `${i.quantidade}x ${i.nome}${i.variacao ? ' ' + i.variacao : ''}`).join(', ');
        String(process.env.LOJA_RECUPERAR_MIN || '90,1200').split(',').map(Number).filter((n) => n > 0).forEach((min, i) =>
          agendarEm('carrinho_parado', { contact_id: contact.id, desde, ultima_msg: ultimaMsg, resumo, tentativa: i + 1 }, new Date(Date.now() + min * 60000)));
      }
      return `Opções de entrega para o CEP ${soCep(input.cep)}: ` + ops.map((o) => `[${o.codigo}] ${o.nome}: ${o.preco ? brl(o.preco) : 'grátis'}, prazo ${o.prazo}`).join('; ') +
        `. Subtotal dos produtos: ${brl(itens.reduce((s, i) => s + i.total, 0))}. Apresente as opções de forma curta e pergunte qual o cliente prefere.`;
    }
    if (nome === 'criar_pedido') return await criarPedido(ctx, input);
    if (nome === 'consultar_pedido') {
      const os = db.prepare(`SELECT * FROM orders WHERE contact_id = ? ${input.numero ? 'AND numero = ?' : ''} ORDER BY id DESC LIMIT 3`).all(...[contact.id, input.numero].filter(Boolean));
      if (!os.length) return 'Não há pedidos deste cliente.';
      return os.map((o) => `Pedido nº ${o.numero}: ${STATUS_NOME[o.status]}, total ${brl(o.total)}${o.rastreio ? `, rastreio ${o.rastreio}` : ''}`).join('; ');
    }
  } catch (e) { return e.message; }
  return null;
}

export function promptLoja(t) {
  if (!t.loja_ativa_efetiva) return '';
  const ps = produtosLoja(t.id);
  const cat = ps.map((p) => {
    const vs = variacoesDe(p); const f = faixaPreco(p);
    const preco = f.min !== f.max ? `de ${brl(f.min)} a ${brl(f.max)}` : brl(f.min) + (p.preco_promocional && !vs.length ? ` (promoção; de ${brl(Number(p.preco))})` : '');
    let linha = `- [${p.id}] ${p.nome}: ${preco}${p.categoria ? ` (${p.categoria})` : ''}${fotosDoProduto(p.id).length ? ' 📷' : ''}${p.descricao ? ` — ${p.descricao}` : ''}`;
    if (vs.length <= 20) linha += vs.map((v) => `\n    • ${v.nome}: ${brl(precoVar(p, v))}${v.preco_promocional ? ' (promoção)' : ''}${estoqueDe(p, v) === Infinity ? '' : estoqueDe(p, v) > 0 ? ` (${estoqueDe(p, v)} em estoque)` : ' (esgotado)'}`).join('');
    else linha += `\n    • ${vs.length} combinações (${opcoesTexto(p)}). Use ver_produto com a variação para ver preço e estoque de cada uma.`;
    if (!vs.length && p.estoque != null) linha += ` — estoque: ${p.estoque > 0 ? p.estoque : 'esgotado'}`;
    return linha;
  }).join('\n');
  return `
Você é também a VENDEDORA DA LOJA: vende produtos sozinha, 24 horas, do interesse ao pagamento, sem precisar de uma pessoa.
Catálogo da loja (preços, opções e estoque; produtos com 📷 têm foto):
${cat || '(catálogo vazio)'}
${t.frete_gratis_acima ? `Frete grátis em compras a partir de ${brl(Number(t.frete_gratis_acima))}.\n` : ''}Como vender na loja:
1. Entenda o que a pessoa procura e mostre o produto com ver_produto (envia a foto). Não descreva o que a foto já mostra.
2. Pergunte a opção (tamanho, cor, modelo) e a quantidade. Cada combinação pode ter preço diferente: informe o preço da combinação escolhida. Nunca venda combinação esgotada nem invente opção.
3. Peça o CEP e use calcular_frete. Apresente as opções de entrega com preço e prazo.
4. Peça nome completo, endereço completo (rua, número, complemento, bairro, cidade, UF), CPF quando for envio por transportadora, e a forma de pagamento.
5. Confirme o resumo com o cliente e chame criar_pedido. O link de pagamento vai automaticamente.
6. Para "cadê meu pedido?", use consultar_pedido. Trocas, devoluções e defeitos vão para um atendente.
- Informe sempre o preço total com frete e o prazo. O cliente pode desistir em até 7 dias após receber.`;
}

// ======================= Vitrine pública =======================
function paginaVitrine(t, ps, wa) {
  const card = (p) => { const vs = variacoesDe(p); const f = faixaPreco(p);
    const foto = fotosDoProduto(p.id)[0];
    const esgotado = vs.length ? vs.every((v) => estoqueDe(p, v) <= 0) : p.estoque != null && p.estoque <= 0;
    const preco = f.min !== f.max ? `<small>a partir de</small> ${brl(f.min)}` : (!vs.length && p.preco_promocional ? `<s>${brl(Number(p.preco))}</s> ${brl(f.min)}` : brl(f.min));
    const txt = encodeURIComponent(`Olá! Tenho interesse em: ${p.nome}`);
    return `<div class="pd">${foto ? `<img src="/img/p/${foto}" alt="${esc(p.nome)}" loading="lazy">` : '<div class="sem">sem foto</div>'}
      <div class="in"><b>${esc(p.nome)}</b>${p.descricao ? `<p>${esc(p.descricao)}</p>` : ''}${vs.length ? `<p class="op">${esc(opcoesTexto(p))}</p>` : ''}
      <div class="pr">${preco}</div>${esgotado ? '<span class="esg">Esgotado</span>' : wa ? `<a class="buy" href="https://wa.me/${wa}?text=${txt}" target="_blank" rel="noopener">Comprar pelo WhatsApp</a>` : ''}</div></div>`; };
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(t.nome)} — Loja</title>
<meta name="description" content="${esc(t.loja_descricao || `Produtos da ${t.nome}. Compre pelo WhatsApp.`)}">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Montserrat:wght@700;800&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box}body{margin:0;font:15px/1.5 Inter,system-ui,sans-serif;color:#1d2433;background:#f5f7fb}header{background:#06112a;color:#fff;padding:28px 0 34px}
.w{max-width:1100px;margin:0 auto;padding:0 18px}h1{font-family:Montserrat;margin:0;font-size:28px}header p{color:#c6d2e8;margin:6px 0 0}
.wa{display:inline-block;margin-top:14px;background:#25d366;color:#fff;text-decoration:none;font-weight:700;padding:10px 18px;border-radius:10px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px;margin:24px auto 40px}@media(min-width:700px){.grid{grid-template-columns:repeat(auto-fill,minmax(230px,1fr))}}
.pd{background:#fff;border:1px solid #e3e8f0;border-radius:14px;overflow:hidden;display:flex;flex-direction:column}.pd img,.sem{width:100%;aspect-ratio:1;object-fit:cover;background:#eef2f8}
.sem{display:grid;place-items:center;color:#93a0b8}.in{padding:14px;display:flex;flex-direction:column;gap:4px;flex:1}.in p{margin:0;color:#5b6780;font-size:13px}.op{font-size:12px!important}
.pr{font-family:Montserrat;font-weight:800;font-size:20px;margin-top:auto}.pr small{font:500 12px Inter;color:#5b6780}.pr s{font:500 13px Inter;color:#93a0b8}.buy{display:block;text-align:center;margin-top:8px;background:linear-gradient(90deg,#1f6fff,#12d8c4);color:#fff;text-decoration:none;font-weight:700;padding:10px;border-radius:10px}
.esg{display:block;text-align:center;margin-top:8px;color:#d64545;font-weight:600}footer{text-align:center;color:#93a0b8;font-size:12px;padding:0 0 30px}footer a{color:#5b6780}</style></head>
<body><header><div class="w"><h1>${esc(t.nome)}</h1><p>${esc(t.loja_descricao || 'Escolha seu produto e compre pelo WhatsApp. Atendimento 24 horas.')}</p>
${wa ? `<a class="wa" href="https://wa.me/${wa}?text=${encodeURIComponent('Olá! Vim pela vitrine.')}" target="_blank" rel="noopener">Falar no WhatsApp</a>` : ''}</div></header>
<main class="w"><div class="grid">${ps.map(card).join('') || '<p>Nenhum produto disponível no momento.</p>'}</div></main>
<footer>Vendas com <a href="/">AVA Connect</a></footer></body></html>`;
}

export function rotasPublicasLoja(app) {
  app.get('/img/p/:id', (req, res) => {
    const f = db.prepare('SELECT mime, dados FROM product_images WHERE id = ?').get(Number(req.params.id));
    if (!f) return res.sendStatus(404);
    res.type(f.mime).set('cache-control', 'public, max-age=604800').send(Buffer.from(f.dados));
  });
  app.get('/loja/:slug', (req, res) => {
    const t = db.prepare("SELECT * FROM tenants WHERE loja_slug = ? AND loja_ativa = 1 AND status = 'ativo'").get(req.params.slug);
    if (!t) return res.status(404).send(pagina('Loja não encontrada', '<div class="wrap"><div class="card" style="margin-top:40px;text-align:center">Loja não encontrada.</div></div>'));
    const num = db.prepare('SELECT telefone FROM whatsapp_numbers WHERE tenant_id = ? AND telefone IS NOT NULL ORDER BY principal DESC, id LIMIT 1').get(t.id);
    res.set('cache-control', 'public, max-age=120').send(paginaVitrine(t, produtosLoja(t.id), (num?.telefone || '').replace(/\D/g, '')));
  });
}

// ======================= API do painel =======================
export function lojaRouter(canSee) {
  const r = express.Router();
  const okT = (req, res, tid, acao) => { if (!canSee(req, tid)) { res.sendStatus(403); return false; } if (acao && !pode(req.user, acao)) { res.status(403).json({ erro: 'Sem permissão' }); return false; } return true; };
  const prod = (req, res) => { const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id); if (!p) { res.sendStatus(404); return null; } return p; };

  r.get('/products/:id/fotos', (req, res) => { const p = prod(req, res); if (!p || !okT(req, res, p.tenant_id)) return; res.json(fotosDoProduto(p.id).map((id) => ({ id, url: `/img/p/${id}` }))); });
  r.post('/products/:id/fotos', express.json({ limit: '4mb' }), (req, res) => {
    const p = prod(req, res); if (!p || !okT(req, res, p.tenant_id, 'configurar')) return;
    const m = String(req.body?.dados || '').match(/^data:(image\/(jpeg|png|webp));base64,(.+)$/);
    if (!m) return res.status(400).json({ erro: 'Envie uma imagem JPG, PNG ou WEBP' });
    const buf = Buffer.from(m[3], 'base64');
    if (buf.length > 1.5 * 1024 * 1024) return res.status(400).json({ erro: 'Imagem acima de 1,5 MB' });
    if (fotosDoProduto(p.id).length >= 6) return res.status(400).json({ erro: 'Máximo de 6 fotos por produto' });
    const x = db.prepare('INSERT INTO product_images (product_id, tenant_id, mime, dados, ordem) VALUES (?, ?, ?, ?, ?)').run(p.id, p.tenant_id, m[1], buf, fotosDoProduto(p.id).length);
    res.status(201).json({ id: Number(x.lastInsertRowid), url: `/img/p/${x.lastInsertRowid}` });
  });
  r.delete('/fotos/:id', (req, res) => {
    const f = db.prepare('SELECT * FROM product_images WHERE id = ?').get(req.params.id); if (!f) return res.sendStatus(404);
    if (!okT(req, res, f.tenant_id, 'configurar')) return;
    db.prepare('DELETE FROM product_images WHERE id = ?').run(f.id); res.json({ ok: true });
  });
  r.put('/products/:id/loja', (req, res) => {
    const p = prod(req, res); if (!p || !okT(req, res, p.tenant_id, 'configurar')) return;
    const b = req.body || {};
    const num = (v) => (v === '' || v == null ? null : Number(String(v).replace(',', '.')));
    let atributos = null, variacoes = null;
    if (b.atributos !== undefined) {
      if (!Array.isArray(b.atributos) || b.atributos.length > 3) return res.status(400).json({ erro: 'Use até 3 atributos (ex.: Cor, Tamanho, Modelo)' });
      atributos = b.atributos.map((a) => ({ nome: String(a.nome || '').trim(), opcoes: [...new Set((a.opcoes || []).map((o) => String(o).trim()).filter(Boolean))].slice(0, 40) }))
        .filter((a) => a.nome && a.opcoes.length);
    }
    if (b.variacoes !== undefined) {
      if (!Array.isArray(b.variacoes) || b.variacoes.length > 300) return res.status(400).json({ erro: 'Até 300 combinações por produto' });
      const fotos = fotosDoProduto(p.id);
      variacoes = b.variacoes.map((v) => {
        const opcoes = v.opcoes && typeof v.opcoes === 'object' ? Object.fromEntries(Object.entries(v.opcoes).map(([k, x]) => [String(k), String(x)])) : null;
        const nome = String(v.nome || (opcoes ? Object.values(opcoes).join(' / ') : '')).trim();
        return { nome, ...(opcoes ? { opcoes } : {}), preco: num(v.preco), preco_promocional: num(v.preco_promocional),
          estoque: v.estoque === '' || v.estoque == null ? null : Math.max(0, Math.floor(Number(v.estoque))), sku: v.sku ? String(v.sku).trim() : null,
          peso_g: num(v.peso_g), foto_id: fotos.includes(Number(v.foto_id)) ? Number(v.foto_id) : null, ativo: v.ativo !== false && v.ativo !== 0 };
      }).filter((v) => v.nome);
      const nomes = variacoes.map((v) => norm(v.nome));
      if (new Set(nomes).size !== nomes.length) return res.status(400).json({ erro: 'Há combinações com o mesmo nome' });
      if (variacoes.some((v) => (v.preco != null && !(v.preco > 0)) || (v.preco_promocional != null && !(v.preco_promocional > 0)))) return res.status(400).json({ erro: 'Preço inválido em alguma combinação' });
    }
    const pick = (k, f = (x) => x) => (b[k] === undefined ? p[k] : f(b[k]));
    db.prepare(`UPDATE products SET estoque = ?, variacoes = ?, atributos = ?, peso_g = ?, altura_cm = ?, largura_cm = ?, comprimento_cm = ?, categoria = ?, preco_promocional = ?, sku = ? WHERE id = ?`)
      .run(pick('estoque', num), variacoes ? JSON.stringify(variacoes) : p.variacoes, atributos ? JSON.stringify(atributos) : p.atributos,
        pick('peso_g', num), pick('altura_cm', num), pick('largura_cm', num), pick('comprimento_cm', num), pick('categoria', (x) => x || null),
        pick('preco_promocional', num), pick('sku', (x) => x || null), p.id);
    res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(p.id));
  });
  r.get('/tenants/:id/loja', (req, res) => {
    if (!okT(req, res, req.params.id)) return;
    const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
    res.json({ loja_ativa: t.loja_ativa, link: t.loja_slug ? `${publicUrl()}/loja/${t.loja_slug}` : null, loja_slug: t.loja_slug, loja_descricao: t.loja_descricao,
      cep_origem: t.cep_origem, melhorenvio_configurado: !!t.melhorenvio_token, melhorenvio_sandbox: t.melhorenvio_sandbox, entrega_local: json(t.entrega_local, {}),
      retirada_endereco: t.retirada_endereco, frete_gratis_acima: t.frete_gratis_acima, etiqueta_automatica: t.etiqueta_automatica, remetente: json(t.remetente, {}),
      plano_permite: !!getPlan(t.plano).vendas });
  });
  r.put('/tenants/:id/loja', (req, res) => {
    if (!okT(req, res, req.params.id, 'configurar')) return;
    const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id); const b = req.body || {};
    if (b.loja_ativa && !getPlan(t.plano).vendas) return res.status(400).json({ erro: 'O AvaShop faz parte dos planos Profissional e Premium.' });
    if (b.cep_origem && !cepOk(b.cep_origem)) return res.status(400).json({ erro: 'CEP de origem inválido' });
    if (b.melhorenvio_token && !pode(req.user, 'conexoes')) return res.status(403).json({ erro: 'Só o dono conecta o Melhor Envio' });
    if (b.loja_slug) {
      const s = slugify(b.loja_slug);
      if (db.prepare('SELECT 1 FROM tenants WHERE loja_slug = ? AND id != ?').get(s, t.id)) return res.status(409).json({ erro: 'Esse endereço de loja já está em uso' });
      db.prepare('UPDATE tenants SET loja_slug = ? WHERE id = ?').run(s, t.id);
    }
    const set = (c, v) => db.prepare(`UPDATE tenants SET ${c} = ? WHERE id = ?`).run(v, t.id);
    if (b.loja_ativa !== undefined) set('loja_ativa', b.loja_ativa ? 1 : 0);
    if (b.loja_descricao !== undefined) set('loja_descricao', b.loja_descricao || null);
    if (b.cep_origem !== undefined) set('cep_origem', soCep(b.cep_origem) || null);
    if (b.melhorenvio_token) set('melhorenvio_token', String(b.melhorenvio_token).trim());
    if (b.remover_melhorenvio) set('melhorenvio_token', null);
    if (b.melhorenvio_sandbox !== undefined) set('melhorenvio_sandbox', b.melhorenvio_sandbox ? 1 : 0);
    if (b.entrega_local !== undefined) set('entrega_local', b.entrega_local?.ceps ? JSON.stringify({ ceps: b.entrega_local.ceps, taxa: Number(b.entrega_local.taxa || 0), prazo: b.entrega_local.prazo || '', nome: b.entrega_local.nome || 'Entrega própria' }) : null);
    if (b.retirada_endereco !== undefined) set('retirada_endereco', b.retirada_endereco || null);
    if (b.frete_gratis_acima !== undefined) set('frete_gratis_acima', b.frete_gratis_acima === '' || b.frete_gratis_acima == null ? null : Number(b.frete_gratis_acima));
    if (b.etiqueta_automatica !== undefined) set('etiqueta_automatica', b.etiqueta_automatica ? 1 : 0);
    if (b.remetente !== undefined) set('remetente', JSON.stringify(b.remetente || {}));
    garantirSlug(db.prepare('SELECT * FROM tenants WHERE id = ?').get(t.id));
    res.json({ ok: true });
  });
  r.post('/tenants/:id/loja/frete-teste', async (req, res) => {
    if (!okT(req, res, req.params.id)) return;
    const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
    try { const p = produtosLoja(t.id)[0]; if (!p) throw new Error('Cadastre um produto primeiro');
      res.json(await cotarFrete(t, req.body?.cep, montarItens(t.id, [{ produto: String(p.id), quantidade: 1, variacao: variacoesDe(p).find((v) => estoqueDe(p, v) > 0)?.nome || variacoesDe(p)[0]?.nome }])));
    } catch (e) { res.status(400).json({ erro: e.message }); }
  });

  r.get('/tenants/:id/orders', (req, res) => {
    if (!okT(req, res, req.params.id)) return;
    res.json(db.prepare(`SELECT o.*, ct.nome contato_nome, ct.telefone, c.pagamento_url FROM orders o JOIN contacts ct ON ct.id = o.contact_id
      LEFT JOIN charges c ON c.id = o.charge_id WHERE o.tenant_id = ? ORDER BY o.id DESC LIMIT 300`).all(req.params.id)
      .map((o) => ({ ...o, itens: json(o.itens, []), entrega: json(o.entrega, {}), endereco: json(o.endereco, {}) })));
  });
  r.post('/orders/:id/status', async (req, res) => {
    const o = getPedido(req.params.id); if (!o) return res.sendStatus(404);
    if (!okT(req, res, o.tenant_id, 'vender')) return;
    try { res.json(await atualizarPedido(o, req.body?.status, req.body || {})); } catch (e) { res.status(400).json({ erro: e.message }); }
  });
  return r;
}

export const STATUS_PEDIDO = STATUS_NOME;
