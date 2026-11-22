// Agente de vendas do AVA Connect: catálogo, proposta, negociação com política, cobrança,
// agenda de reuniões e cadência automática de follow-up. Do primeiro contato ao pagamento.
import crypto from 'node:crypto';
import express from 'express';
import { db, logActivity } from './db.js';
import { sendText, sendTemplate } from './whatsapp.js';
import { enviarModelo, textoModelo, avisarEquipe } from './modelos.js';
import { sendEmail } from './email.js';
import { criarCobranca, publicUrl, modoPagamento } from './payments.js';
import { gerarMensagem } from './ai.js';
import { pagina, esc, brl } from './report.js';
import { efetivoDoContato } from './agents.js';
import { telefonesAprovadores } from './auth.js';

// ======================= Banco =======================
const tenantCols = db.prepare('PRAGMA table_info(tenants)').all().map((c) => c.name);
for (const [col, def] of [
  ['vendas_ativo', 'INTEGER NOT NULL DEFAULT 0'],
  ['desconto_max', 'REAL NOT NULL DEFAULT 5'],          // % que a IA pode conceder sozinha
  ['desconto_avista', 'REAL NOT NULL DEFAULT 0'],       // % extra para Pix/boleto/cartão 1x
  ['parcelas_max', 'INTEGER NOT NULL DEFAULT 1'],       // parcelas no cartão
  ['validade_proposta_dias', 'INTEGER NOT NULL DEFAULT 7'],
  ['condicoes_pagamento', 'TEXT'],
  ['frete_info', 'TEXT'],
  ['pos_venda_mensagem', 'TEXT'],
  ['email_remetente_nome', 'TEXT'],
  ['email_resposta', 'TEXT'],
  ['agenda_dias', "TEXT NOT NULL DEFAULT '1,2,3,4,5'"], // 0=dom ... 6=sáb
  ['agenda_inicio', "TEXT NOT NULL DEFAULT '09:00'"],
  ['agenda_fim', "TEXT NOT NULL DEFAULT '17:00'"],
  ['reuniao_minutos', 'INTEGER NOT NULL DEFAULT 30'],
  ['reuniao_local', 'TEXT'],                            // link do Meet/Zoom ou endereço
  ['cadencia_ativa', 'INTEGER NOT NULL DEFAULT 1'],
  ['wa_template_reengajar', 'TEXT'],                    // modelo Meta com {{1}} = primeiro nome
  ['asaas_api_key', 'TEXT'],
  ['asaas_webhook_token', 'TEXT'],
]) if (!tenantCols.includes(col)) db.exec(`ALTER TABLE tenants ADD COLUMN ${col} ${def}`);

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  descricao TEXT,
  preco REAL NOT NULL,
  preco_minimo REAL,                -- abaixo disso só com aprovação
  unidade TEXT NOT NULL DEFAULT 'un',
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  numero INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'enviada',   -- aguardando_aprovacao | enviada | aceita | paga | recusada | expirada | substituida
  itens TEXT NOT NULL DEFAULT '[]',
  subtotal REAL NOT NULL DEFAULT 0,          -- pelo preço de tabela
  desconto_percentual REAL NOT NULL DEFAULT 0, -- desconto efetivo sobre a tabela
  frete REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  condicao_pagamento TEXT,
  observacoes TEXT,
  email TEXT,
  validade TEXT,                              -- AAAA-MM-DD
  motivo_aprovacao TEXT,
  autor TEXT NOT NULL DEFAULT 'ia',
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  enviada_em TEXT,
  paga_em TEXT
);
CREATE INDEX IF NOT EXISTS idx_prop_contact ON proposals(contact_id, status);
CREATE TABLE IF NOT EXISTS charges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  proposal_id INTEGER REFERENCES proposals(id) ON DELETE SET NULL,
  token TEXT NOT NULL UNIQUE,
  descricao TEXT NOT NULL,
  valor REAL NOT NULL,
  forma TEXT NOT NULL DEFAULT 'livre',       -- pix | boleto | cartao | livre
  parcelas INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pendente',   -- pendente | pago | vencido | cancelado
  pagamento_ref TEXT,
  pagamento_url TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  pago_em TEXT
);
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  inicio TEXT NOT NULL,                      -- horário de Brasília 'AAAA-MM-DD HH:MM'
  fim TEXT NOT NULL,
  assunto TEXT,
  status TEXT NOT NULL DEFAULT 'agendada',   -- agendada | realizada | cancelada | faltou
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_appt ON appointments(tenant_id, inicio);
`);

// ======================= Utilitários =======================
const novoToken = (p) => p + crypto.randomBytes(14).toString('hex');
const r2 = (v) => Math.round(v * 100) / 100;
const TZ_OFFSET_MIN = -180; // Brasília (sem horário de verão desde 2019)
const agoraBR = () => new Date(Date.now() + TZ_OFFSET_MIN * 60000); // use getUTC* para ler a hora local
const localParaUTC = (local) => new Date(local.replace(' ', 'T') + ':00-03:00');
const fmtLocal = (d) => d.toISOString().slice(0, 16).replace('T', ' ');
const SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
export const rotuloHorario = (local) => {
  const d = new Date(local.replace(' ', 'T') + ':00Z');
  return `${SEMANA[d.getUTCDay()]} ${local.slice(8, 10)}/${local.slice(5, 7)} às ${local.slice(11, 16)}`;
};
const primeiroNome = (c) => (c?.nome || '').trim().split(/\s+/)[0] || '';

export function garantirLead(tenant, contact, conv) {
  let lead = db.prepare('SELECT * FROM leads WHERE tenant_id = ? AND contact_id = ?').get(tenant.id, contact.id);
  if (!lead) {
    db.prepare(`INSERT INTO leads (tenant_id, contact_id, conversation_id, nome, etapa, origem, criado_em) VALUES (?, ?, ?, ?, 'novo', ?, datetime('now'))`)
      .run(tenant.id, contact.id, conv?.id ?? null, contact.nome || null, conv?.canal === 'simulador' ? 'simulador' : 'whatsapp');
    lead = db.prepare('SELECT * FROM leads WHERE tenant_id = ? AND contact_id = ?').get(tenant.id, contact.id);
  }
  return lead;
}

function moverLead(lead, etapa, extra = {}) {
  const sets = ['etapa = ?', "atualizado_em = datetime('now')"]; const vals = [etapa];
  if (extra.valor != null) { sets.push('valor_estimado = ?'); vals.push(extra.valor); }
  if (extra.motivo_perda) { sets.push('motivo_perda = ?'); vals.push(extra.motivo_perda); }
  if (extra.email) { sets.push('email = COALESCE(email, ?)'); vals.push(extra.email); }
  sets.push(`fechado_em = ${['fechado', 'perdido'].includes(etapa) ? "datetime('now')" : 'NULL'}`);
  db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...vals, lead.id);
  if (lead.etapa !== etapa) logActivity(lead.tenant_id, lead.id, `Etapa: ${lead.etapa} → ${etapa}`, { autor: 'ia' });
}

function dentroDaJanela(contactId) {
  const t = db.prepare(`SELECT MAX(m.criado_em) t FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE c.contact_id = ? AND m.autor = 'cliente'`).get(contactId).t;
  return !!t && Date.now() - new Date(t.replace(' ', 'T') + 'Z') < 23.5 * 3600e3;
}
function ultimaMsgCliente(contactId) {
  return db.prepare(`SELECT MAX(m.criado_em) t FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE c.contact_id = ? AND m.autor = 'cliente'`).get(contactId).t;
}

/**
 * Envia uma mensagem por iniciativa do sistema (follow-up, cobrança, lembrete).
 * Dentro da janela de 24h: texto livre. Fora: modelo aprovado na Meta, se houver; senão cria tarefa para a equipe.
 * Retorna 'enviado' | 'modelo' | 'tarefa'.
 */
export async function enviarAoCliente(tenantBase, contact, texto, { motivoTarefa, modelo } = {}) {
  const tenant = tenantBase._numero_id !== undefined || tenantBase._agent_id !== undefined ? tenantBase : efetivoDoContato(tenantBase, contact.id);
  let conv = db.prepare(`SELECT * FROM conversations WHERE contact_id = ? ORDER BY id DESC LIMIT 1`).get(contact.id);
  const simulador = conv?.canal === 'simulador';
  const conectado = !!tenant.wa_phone_number_id;
  if (!simulador && conectado && !dentroDaJanela(contact.id)) {
    // Fora das 24h: modelo da fase (ex.: lembrete de pagamento) → modelo genérico de retomada → modelo legado → tarefa.
    const nome = primeiroNome(contact) || 'tudo bem';
    const tentativas = [modelo, { chave: 'ava_retomar_atendimento', params: [nome, tenant.nome_assistente || 'AVA', tenant.nome] }].filter(Boolean);
    let usado = null;
    for (const m of tentativas) if (await enviarModelo(tenant, contact.telefone, m.chave, m.params)) { usado = m; break; }
    if (usado) {
      texto = `[Modelo "${usado.chave}" enviado — fora da janela de 24h] ${textoModelo(usado.chave, usado.params)}`;
    } else if (tenant.wa_template_reengajar) {
      await sendTemplate(tenant, contact.telefone, tenant.wa_template_reengajar, [nome]);
      texto = `[Modelo "${tenant.wa_template_reengajar}" enviado — fora da janela de 24h] ${texto}`;
    } else {
      const lead = garantirLead(tenant, contact, conv);
      logActivity(tenant.id, lead.id, `${motivoTarefa || 'Contato automático'} — fora da janela de 24h do WhatsApp e sem modelo aprovado. Mensagem sugerida: "${texto}"`,
        { tipo: 'tarefa', autor: 'sistema', vence_em: fmtLocal(agoraBR()).slice(0, 10) });
      return 'tarefa';
    }
  } else if (!simulador) {
    await sendText(tenant, contact.telefone, texto);
  }
  if (!conv || conv.status === 'encerrada') {
    const r = db.prepare('INSERT INTO conversations (tenant_id, contact_id, canal, agent_id, numero_id) VALUES (?, ?, ?, ?, ?)')
      .run(tenant.id, contact.id, simulador ? 'simulador' : 'whatsapp', tenant._agent_id ?? null, tenant._numero_id ?? null);
    conv = { id: r.lastInsertRowid, status: 'ia' };
  }
  db.prepare('INSERT INTO messages (conversation_id, autor, conteudo) VALUES (?, ?, ?)').run(conv.id, 'ia', texto);
  db.prepare("UPDATE conversations SET ultima_mensagem_em = datetime('now') WHERE id = ?").run(conv.id);
  return texto.startsWith('[Modelo') ? 'modelo' : 'enviado';
}

// Avisa o responsável e os gestores (dono/gestor com telefone) pelo número principal da empresa.
export async function avisarResponsavel(tenant, texto) {
  const base = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenant.id) || tenant;
  for (const tel of [...new Set(telefonesAprovadores(base))]) await avisarEquipe(base, tel, `AVA Connect · ${base.nome}\n${texto}`);
}

// ======================= Jobs =======================
export function agendarEm(tipo, payload, quandoUTC) {
  db.prepare('INSERT INTO jobs (tipo, payload, executar_em) VALUES (?, ?, ?)')
    .run(tipo, JSON.stringify(payload), quandoUTC.toISOString().slice(0, 19).replace('T', ' '));
}
const minutosDaqui = (min) => new Date(Date.now() + min * 60000);
const lista = (env, padrao) => String(process.env[env] || padrao).split(',').map(Number).filter((n) => n >= 0);

export function cancelarJobsDoContato(contactId, tipos) {
  db.prepare(`UPDATE jobs SET status = 'cancelado' WHERE status = 'pendente'
    AND json_extract(payload, '$.contact_id') = ? ${tipos ? `AND tipo IN (${tipos.map(() => '?').join(',')})` : ''}`)
    .run(contactId, ...(tipos || []));
}

// ======================= Catálogo e política =======================
export const produtosAtivos = (tenantId) =>
  db.prepare('SELECT * FROM products WHERE tenant_id = ? AND ativo = 1 ORDER BY nome').all(tenantId);

export function textoCatalogo(tenant) {
  const ps = produtosAtivos(tenant.id);
  if (!ps.length) return '(sem catálogo cadastrado — use os preços da base de conhecimento)';
  return ps.map((p) => `- [${p.id}] ${p.nome}: ${brl(p.preco)} por ${p.unidade}${p.descricao ? ` — ${p.descricao}` : ''}`).join('\n');
}

function acharProduto(tenantId, ref) {
  if (ref == null) return null;
  const ps = produtosAtivos(tenantId);
  const n = Number(ref);
  if (Number.isInteger(n) && n > 0) { const p = ps.find((x) => x.id === n); if (p) return p; }
  const s = String(ref).toLowerCase().trim();
  return ps.find((p) => p.nome.toLowerCase() === s) || ps.find((p) => p.nome.toLowerCase().includes(s) || s.includes(p.nome.toLowerCase())) || null;
}

/** Monta e valida os itens e o desconto contra a política. Lança Error com mensagem para a IA se faltar dado. */
export function calcularProposta(tenant, input) {
  const itens = [];
  for (const it of input.itens || []) {
    const qtd = Number(it.quantidade || 1);
    if (!(qtd > 0)) throw new Error(`Quantidade inválida para "${it.produto}".`);
    const p = acharProduto(tenant.id, it.produto_id ?? it.produto);
    const tabela = p ? p.preco : Number(it.preco_unitario);
    if (!(tabela > 0)) throw new Error(`Produto "${it.produto}" não está no catálogo e não tem preço. Confirme com a equipe (transferir_humano) ou use um item do catálogo.`);
    const unit = it.preco_unitario != null && p ? Number(it.preco_unitario) : tabela;
    itens.push({ produto_id: p?.id ?? null, nome: p?.nome || String(it.produto), unidade: p?.unidade || 'un', quantidade: qtd,
      preco_tabela: tabela, preco_unitario: r2(unit), preco_minimo: p?.preco_minimo ?? null, total: r2(unit * qtd) });
  }
  if (!itens.length) throw new Error('Informe ao menos um item com quantidade.');
  const subtotal = r2(itens.reduce((s, i) => s + i.preco_tabela * i.quantidade, 0));
  const somaItens = itens.reduce((s, i) => s + i.total, 0);
  const pct = Math.max(0, Math.min(100, Number(input.desconto_percentual || 0)));
  const frete = r2(Math.max(0, Number(input.frete || 0)));
  const liquido = r2(somaItens * (1 - pct / 100));
  const descontoEfetivo = subtotal > 0 ? r2(100 * (1 - liquido / subtotal)) : 0;
  const motivos = [];
  if (descontoEfetivo > Number(tenant.desconto_max) + 0.01) motivos.push(`desconto de ${descontoEfetivo}% (limite da IA: ${tenant.desconto_max}%)`);
  for (const i of itens) {
    const unitLiquido = i.preco_unitario * (1 - pct / 100);
    if (i.preco_minimo != null && unitLiquido < i.preco_minimo - 0.005) motivos.push(`${i.nome} abaixo do preço mínimo (${brl(i.preco_minimo)})`);
  }
  return { itens, subtotal, desconto_percentual: Math.max(0, descontoEfetivo), frete, total: r2(liquido + frete), motivos };
}

// ======================= Proposta =======================
export const getProposta = (id) => db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
const propostaAberta = (contactId) => db.prepare(`SELECT * FROM proposals WHERE contact_id = ? AND status IN ('enviada','aceita','aguardando_aprovacao')
  ORDER BY id DESC LIMIT 1`).get(contactId);

function resumoProposta(p) {
  const itens = JSON.parse(p.itens);
  return itens.map((i) => `• ${i.quantidade} ${i.unidade} — ${i.nome}: ${brl(i.total)}`).join('\n') +
    (p.desconto_percentual > 0 ? `\nDesconto: ${p.desconto_percentual}%` : '') +
    (p.frete > 0 ? `\nFrete: ${brl(p.frete)}` : '') + `\n*Total: ${brl(p.total)}*`;
}

/** ctx = { tenant, contact, conv, enviar? } — enviar(texto) manda dentro da conversa atual. */
export async function criarProposta(ctx, input, autor = 'ia') {
  const { tenant, contact, conv } = ctx;
  if (!input.itens?.length) { // nova versão da proposta aberta (ex.: só mudou o desconto)
    const ant = propostaAberta(contact.id);
    if (ant) input = { ...input, itens: JSON.parse(ant.itens).map((i) => ({ produto: i.produto_id ? String(i.produto_id) : i.nome, quantidade: i.quantidade,
      ...(i.produto_id ? (i.preco_unitario !== i.preco_tabela ? { preco_unitario: i.preco_unitario } : {}) : { preco_unitario: i.preco_unitario }) })),
      frete: input.frete ?? ant.frete, email: input.email || ant.email, condicao_pagamento: input.condicao_pagamento || ant.condicao_pagamento,
      observacoes: input.observacoes || ant.observacoes };
  }
  const calc = calcularProposta(tenant, input);
  const lead = garantirLead(tenant, contact, conv);
  const email = (input.email || lead.email || '').trim() || null;
  if (input.nome || input.empresa || email) {
    db.prepare('UPDATE leads SET nome = COALESCE(?, nome), empresa = COALESCE(?, empresa), email = COALESCE(?, email) WHERE id = ?')
      .run(input.nome || null, input.empresa || null, email, lead.id);
    if (input.nome) db.prepare('UPDATE contacts SET nome = ? WHERE id = ?').run(input.nome, contact.id);
  }
  db.prepare("UPDATE proposals SET status = 'substituida' WHERE contact_id = ? AND status IN ('enviada','aguardando_aprovacao')").run(contact.id);
  cancelarJobsDoContato(contact.id, ['followup_proposta', 'expirar_proposta']);
  const numero = db.prepare('SELECT COALESCE(MAX(numero), 0) + 1 n FROM proposals WHERE tenant_id = ?').get(tenant.id).n;
  const validade = new Date(Date.now() + Number(tenant.validade_proposta_dias || 7) * 864e5 + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10);
  const precisaAprovacao = calc.motivos.length > 0;
  const r = db.prepare(`INSERT INTO proposals (tenant_id, contact_id, lead_id, conversation_id, numero, token, status, itens, subtotal, desconto_percentual,
      frete, total, condicao_pagamento, observacoes, email, validade, motivo_aprovacao, autor) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(tenant.id, contact.id, lead.id, conv?.id ?? null, numero, novoToken('prop_'), precisaAprovacao ? 'aguardando_aprovacao' : 'enviada',
      JSON.stringify(calc.itens), calc.subtotal, calc.desconto_percentual, calc.frete, calc.total,
      input.condicao_pagamento || tenant.condicoes_pagamento || null, input.observacoes || null, email, validade,
      precisaAprovacao ? calc.motivos.join('; ') : null, autor);
  const p = getProposta(r.lastInsertRowid);

  if (precisaAprovacao) {
    moverLead(lead, 'proposta', { valor: p.total });
    logActivity(tenant.id, lead.id, `Proposta #${p.numero} (${brl(p.total)}) aguardando aprovação: ${p.motivo_aprovacao}`,
      { tipo: 'tarefa', autor: 'sistema', vence_em: fmtLocal(agoraBR()).slice(0, 10) });
    await avisarResponsavel(tenant, `Aprovação pedida — proposta #${p.numero} para ${contact.nome || contact.telefone}\n${resumoProposta(p)}\nMotivo: ${p.motivo_aprovacao}\n\nResponda APROVAR ${p.numero} ou RECUSAR ${p.numero}.`);
    return `A condição pedida passa do limite que você pode conceder (${p.motivo_aprovacao}). A proposta #${p.numero} foi enviada para aprovação do gestor. ` +
      `Diga ao cliente, com naturalidade, que vai confirmar essa condição com o gestor e retorna em breve. Se ele preferir fechar agora, você pode oferecer até ${tenant.desconto_max}% de desconto.`;
  }
  const r2txt = await enviarProposta(ctx, p);
  return r2txt;
}

export async function enviarProposta(ctx, p) {
  const { tenant, contact } = ctx;
  db.prepare("UPDATE proposals SET status = 'enviada', enviada_em = datetime('now') WHERE id = ?").run(p.id);
  p = getProposta(p.id);
  const link = `${publicUrl()}/proposta/${p.token}`;
  const msg = `📄 *Proposta nº ${p.numero} — ${tenant.nome}*\n${resumoProposta(p)}\n` +
    (p.condicao_pagamento ? `Pagamento: ${p.condicao_pagamento}\n` : '') +
    `Válida até ${p.validade.split('-').reverse().join('/')}.\n\nVeja os detalhes e aprove por aqui:\n${link}`;
  if (ctx.enviar) await ctx.enviar(msg); else await enviarAoCliente(tenant, contact, msg, { motivoTarefa: `Enviar proposta #${p.numero}` });

  let emailInfo = '';
  if (p.email) {
    const res = await sendEmail(tenant, { to: p.email, subject: `Proposta nº ${p.numero} — ${tenant.nome}`, html: htmlEmailProposta(tenant, contact, p, link),
      text: `Proposta nº ${p.numero}\n${resumoProposta(p).replace(/\*/g, '')}\n\nDetalhes e aprovação: ${link}` });
    emailInfo = res.erro ? ` Não consegui enviar para o e-mail ${p.email} (${res.erro}).` : ` Também foi enviada para o e-mail ${p.email}.`;
  }
  const lead = garantirLead(tenant, contact, ctx.conv);
  moverLead(lead, 'proposta', { valor: p.total, email: p.email });
  logActivity(tenant.id, lead.id, `Proposta #${p.numero} enviada (${brl(p.total)})${p.email ? ' por WhatsApp e e-mail' : ' por WhatsApp'}`, { autor: 'ia' });

  if (tenant.cadencia_ativa) {
    lista('VENDAS_FOLLOWUP_MIN', '1440,4320,8640').forEach((min, i, arr) =>
      agendarEm('followup_proposta', { proposal_id: p.id, contact_id: contact.id, tentativa: i + 1, ultima: i === arr.length - 1 }, minutosDaqui(min)));
  }
  agendarEm('expirar_proposta', { proposal_id: p.id, contact_id: contact.id }, localParaUTC(`${p.validade} 23:59`));
  return `Proposta #${p.numero} enviada ao cliente no WhatsApp, com resumo e link (total ${brl(p.total)}).${emailInfo} ` +
    'Não repita os valores. Pergunte, em uma frase, se ficou alguma dúvida ou se podemos seguir com o pedido.';
}

export async function aprovarProposta(p, aprovado, por = 'gestor') {
  if (!p || p.status !== 'aguardando_aprovacao') return { erro: 'Proposta não está aguardando aprovação' };
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(p.tenant_id);
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(p.contact_id);
  const lead = garantirLead(tenant, contact, null);
  if (!aprovado) {
    db.prepare("UPDATE proposals SET status = 'recusada' WHERE id = ?").run(p.id);
    logActivity(tenant.id, lead.id, `Condição da proposta #${p.numero} recusada pelo ${por}`, { autor: 'sistema' });
    await enviarAoCliente(tenant, contact,
      `Olá${primeiroNome(contact) ? ', ' + primeiroNome(contact) : ''}! Conversei com o gestor e infelizmente não conseguimos essa condição. ` +
      `O melhor que consigo é ${tenant.desconto_max}% de desconto${tenant.desconto_avista > 0 ? `, e mais ${tenant.desconto_avista}% para pagamento à vista` : ''}. Quer que eu monte a proposta assim?`,
      { motivoTarefa: `Avisar cliente que a condição da proposta #${p.numero} foi recusada` });
    return { ok: true, status: 'recusada' };
  }
  logActivity(tenant.id, lead.id, `Proposta #${p.numero} aprovada pelo ${por}`, { autor: 'sistema' });
  db.prepare("UPDATE activities SET concluida = 1 WHERE lead_id = ? AND tipo = 'tarefa' AND descricao LIKE ?").run(lead.id, `Proposta #${p.numero} %aguardando aprovação%`);
  await enviarAoCliente(tenant, contact, `Boa notícia${primeiroNome(contact) ? ', ' + primeiroNome(contact) : ''}! O gestor aprovou a condição. 🎉`);
  await enviarProposta({ tenant, contact, conv: null }, p);
  return { ok: true, status: 'enviada' };
}

// ======================= Cobrança =======================
export const getCobranca = (token) => db.prepare('SELECT * FROM charges WHERE token = ?').get(String(token || ''));

/** Gera a cobrança da proposta aberta do contato. Retorna { charge } ou { erro }. */
export async function gerarCobranca(tenant, contact, p, { forma = 'livre', parcelas = 1 } = {}) {
  if (!p) return { erro: 'Não há proposta aberta para este cliente. Monte a proposta com criar_proposta antes.' };
  if (p.status === 'aguardando_aprovacao') return { erro: 'A proposta ainda aguarda aprovação do gestor.' };
  if (!['enviada', 'aceita'].includes(p.status)) return { erro: `A proposta está ${p.status}.` };
  if (p.validade < fmtLocal(agoraBR()).slice(0, 10)) {
    db.prepare("UPDATE proposals SET status = 'expirada' WHERE id = ?").run(p.id);
    return { erro: 'A proposta venceu. Monte uma nova com criar_proposta.' };
  }
  forma = ['pix', 'boleto', 'cartao'].includes(forma) ? forma : 'livre';
  parcelas = forma === 'cartao' ? Math.max(1, Math.min(Number(parcelas) || 1, Number(tenant.parcelas_max) || 1)) : 1;
  const avista = forma === 'pix' || forma === 'boleto' || (forma === 'cartao' && parcelas === 1);
  const descAvista = avista ? Number(tenant.desconto_avista || 0) : 0;
  const valor = r2((p.total - p.frete) * (1 - descAvista / 100) + p.frete);
  const aberta = db.prepare("SELECT * FROM charges WHERE proposal_id = ? AND status IN ('pendente','vencido') ORDER BY id DESC LIMIT 1").get(p.id);
  if (aberta && aberta.forma === forma && aberta.parcelas === parcelas && aberta.pagamento_url) return { charge: aberta, descAvista };
  if (aberta) db.prepare("UPDATE charges SET status = 'cancelado' WHERE id = ?").run(aberta.id);

  const token = novoToken('cob_');
  const descricao = `Proposta nº ${p.numero} — ${tenant.nome}`;
  let ref, url;
  let extra = {};
  try { ({ ref, url, ...extra } = await criarCobranca(tenant, { token, valor, descricao, forma, parcelas,
    cliente: { nome: contact.nome, telefone: contact.telefone, email: db.prepare('SELECT email FROM leads WHERE contact_id = ?').get(contact.id)?.email } })); }
  catch (e) {
    console.error('[vendas] cobrança', e.message);
    const lead = garantirLead(tenant, contact, null);
    logActivity(tenant.id, lead.id, `Gerar e enviar a cobrança da proposta #${p.numero} (${brl(valor)}, ${forma}${parcelas > 1 ? ' ' + parcelas + 'x' : ''}) — o sistema não conseguiu: ${e.message}`,
      { tipo: 'tarefa', autor: 'sistema', vence_em: fmtLocal(agoraBR()).slice(0, 10) });
    return { erro: 'Não foi possível gerar o link agora. A equipe vai enviar o link de pagamento. Avise o cliente.' };
  }
  const r = db.prepare(`INSERT INTO charges (tenant_id, contact_id, proposal_id, token, descricao, valor, forma, parcelas, pagamento_ref, pagamento_url)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(tenant.id, contact.id, p.id, token, descricao, valor, forma, parcelas, ref, url);
  db.prepare('UPDATE charges SET gateway = ?, pix_copia_cola = ? WHERE token = ?').run(extra.gateway || null, extra.pix || null, token);
  db.prepare("UPDATE proposals SET status = 'aceita' WHERE id = ?").run(p.id);
  cancelarJobsDoContato(contact.id, ['followup_proposta', 'reengajar']);
  const charge = db.prepare('SELECT * FROM charges WHERE id = ?').get(r.lastInsertRowid);
  const lead = garantirLead(tenant, contact, null);
  logActivity(tenant.id, lead.id, `Cliente aceitou a proposta #${p.numero}. Cobrança gerada: ${brl(valor)} (${forma}${parcelas > 1 ? ' em ' + parcelas + 'x' : ''})`, { autor: 'ia' });
  if (tenant.cadencia_ativa) lista('VENDAS_LEMBRETE_PGTO_MIN', '1440,4320').forEach((min, i) =>
    agendarEm('lembrete_pagamento', { charge_id: charge.id, contact_id: contact.id, tentativa: i + 1 }, minutosDaqui(min)));
  return { charge, descAvista };
}

const FORMAS = { pix: 'Pix', boleto: 'boleto', cartao: 'cartão', livre: 'Pix, boleto ou cartão' };
function textoCobranca(charge, descAvista) {
  if (charge.pix_copia_cola) return `💳 *Pagamento — ${charge.descricao}*\nValor: *${brl(charge.valor)}*` +
    (descAvista > 0 ? ` (já com ${descAvista}% de desconto à vista)` : '') +
    `\n\nPague pelo Pix copia e cola (vem na próxima mensagem) ou pelo QR Code:\n${charge.pagamento_url}\n\nDepois de pagar, me envie o comprovante por aqui.`;
  return `💳 *Pagamento — ${charge.descricao}*\nValor: *${brl(charge.valor)}*` +
    (charge.parcelas > 1 ? ` em até ${charge.parcelas}x no cartão` : '') +
    (descAvista > 0 ? ` (já com ${descAvista}% de desconto à vista)` : '') +
    `\nForma: ${FORMAS[charge.forma]}\n\nPague com segurança por este link:\n${charge.pagamento_url}\n\nAssim que o pagamento cair, eu te aviso aqui.`;
}

// Outros módulos podem reagir a um pagamento confirmado (ex.: ativar a conta de quem se cadastrou pelo site).
import { aoConfirmarPagamento } from './ganchos.js';
export { aoConfirmarPagamento };

export async function confirmarPagamentoCobranca(charge) {
  if (!charge || charge.status === 'pago') return { jaPago: true };
  db.prepare("UPDATE charges SET status = 'pago', pago_em = datetime('now') WHERE id = ?").run(charge.id);
  for (const fn of aoConfirmarPagamento) { try { await fn(charge); } catch (e) { console.error('[pagamento] gancho', e.message); } }
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(charge.tenant_id);
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(charge.contact_id);
  const p = charge.proposal_id ? getProposta(charge.proposal_id) : null;
  if (p) db.prepare("UPDATE proposals SET status = 'paga', paga_em = datetime('now') WHERE id = ?").run(p.id);
  const lead = garantirLead(tenant, contact, null);
  moverLead(lead, 'fechado', { valor: charge.valor });
  logActivity(tenant.id, lead.id, `💰 Pagamento confirmado: ${brl(charge.valor)}${p ? ` (proposta #${p.numero})` : ''}`, { autor: 'sistema' });
  cancelarJobsDoContato(contact.id, ['followup_proposta', 'lembrete_pagamento', 'reengajar', 'expirar_proposta']);
  if (charge.order_id) return { ok: true }; // pedido da loja: o AvaShop envia a confirmação com os dados da entrega
  await enviarAoCliente(tenant, contact,
    `✅ Pagamento confirmado! Obrigado pela confiança${primeiroNome(contact) ? ', ' + primeiroNome(contact) : ''}.\n\n` +
    (tenant.pos_venda_mensagem || 'Nossa equipe já foi avisada e vai dar andamento ao seu pedido. Qualquer dúvida, é só me chamar aqui.'),
    { motivoTarefa: 'Confirmar pagamento ao cliente', modelo: { chave: 'ava_pagamento_confirmado', params: [primeiroNome(contact) || 'tudo bem', brl(charge.valor), charge.descricao] } });
  await avisarResponsavel(tenant, `💰 Venda fechada: ${contact.nome || contact.telefone} pagou ${brl(charge.valor)}${p ? ` (proposta #${p.numero})` : ''}.`);
  logActivity(tenant.id, lead.id, 'Dar andamento ao pedido pago (entrega/implantação)', { tipo: 'tarefa', autor: 'sistema', vence_em: fmtLocal(agoraBR()).slice(0, 10) });
  return { ok: true };
}

export async function cobrancaVencida(charge) {
  if (!charge || charge.status !== 'pendente') return;
  db.prepare("UPDATE charges SET status = 'vencido' WHERE id = ?").run(charge.id);
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(charge.tenant_id);
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(charge.contact_id);
  await enviarAoCliente(tenant, contact,
    `Olá${primeiroNome(contact) ? ', ' + primeiroNome(contact) : ''}! O pagamento de ${brl(charge.valor)} (${charge.descricao}) venceu e ainda não identificamos. ` +
    'Aconteceu alguma coisa? Se quiser, gero um novo link ou mudo a forma de pagamento.', { motivoTarefa: 'Cobrar pagamento vencido',
      modelo: { chave: 'ava_lembrete_pagamento', params: [primeiroNome(contact) || 'tudo bem', brl(charge.valor), charge.descricao, charge.pagamento_url] } });
}

// ======================= Agenda =======================
export function horariosLivres(tenant, qtd = 6, minAntecedenciaMin = 120) {
  const dias = String(tenant.agenda_dias || '1,2,3,4,5').split(',').map(Number);
  const dur = Number(tenant.reuniao_minutos || 30);
  const [hi, mi] = String(tenant.agenda_inicio || '09:00').split(':').map(Number);
  const [hf, mf] = String(tenant.agenda_fim || '17:00').split(':').map(Number);
  const limite = fmtLocal(new Date(agoraBR().getTime() + minAntecedenciaMin * 60000));
  const ocupados = db.prepare("SELECT inicio, fim FROM appointments WHERE tenant_id = ? AND status = 'agendada' AND inicio >= ?")
    .all(tenant.id, limite.slice(0, 10));
  const out = [];
  const base = agoraBR(); base.setUTCHours(0, 0, 0, 0);
  for (let d = 0; d < 21 && out.length < qtd; d++) {
    const dia = new Date(base.getTime() + d * 864e5);
    if (!dias.includes(dia.getUTCDay())) continue;
    for (let m = hi * 60 + mi; m + dur <= hf * 60 + mf && out.length < qtd; m += dur) {
      const ini = fmtLocal(new Date(dia.getTime() + m * 60000));
      const fim = fmtLocal(new Date(dia.getTime() + (m + dur) * 60000));
      if (ini < limite) continue;
      if (ocupados.some((o) => ini < o.fim && fim > o.inicio)) continue;
      out.push(ini);
    }
  }
  return out;
}

export async function agendarReuniao(ctx, { data_hora, assunto }) {
  const { tenant, contact, conv } = ctx;
  const ini = String(data_hora || '').replace('T', ' ').slice(0, 16);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(ini)) return 'Formato de horário inválido. Use AAAA-MM-DDTHH:MM, escolhido de consultar_horarios.';
  if (!horariosLivres(tenant, 400, 60).includes(ini)) {
    return `Esse horário não está livre. Horários disponíveis: ${horariosLivres(tenant, 5).map(rotuloHorario).join('; ')}. Ofereça estas opções.`;
  }
  const fim = fmtLocal(new Date(new Date(ini.replace(' ', 'T') + ':00Z').getTime() + Number(tenant.reuniao_minutos || 30) * 60000));
  const lead = garantirLead(tenant, contact, conv);
  const r = db.prepare('INSERT INTO appointments (tenant_id, contact_id, lead_id, inicio, fim, assunto) VALUES (?,?,?,?,?,?)')
    .run(tenant.id, contact.id, lead.id, ini, fim, assunto || 'Reunião');
  logActivity(tenant.id, lead.id, `Reunião: ${assunto || ''} — ${rotuloHorario(ini)}`, { tipo: 'reuniao', autor: 'ia', vence_em: ini.replace(' ', 'T') });
  if (lead.etapa === 'novo') moverLead(lead, 'qualificado');
  cancelarJobsDoContato(contact.id, ['reengajar']);
  const inicioUTC = localParaUTC(ini);
  if (inicioUTC - Date.now() > 26 * 3600e3) agendarEm('lembrete_reuniao', { appointment_id: r.lastInsertRowid, contact_id: contact.id, quando: 'vespera' }, new Date(inicioUTC - 24 * 3600e3));
  if (inicioUTC - Date.now() > 2 * 3600e3) agendarEm('lembrete_reuniao', { appointment_id: r.lastInsertRowid, contact_id: contact.id, quando: '1h' }, new Date(inicioUTC - 3600e3));
  await avisarResponsavel(tenant, `📅 Reunião marcada pela AVA: ${contact.nome || contact.telefone} — ${rotuloHorario(ini)}${assunto ? ` (${assunto})` : ''}.`);
  return `Reunião confirmada para ${rotuloHorario(ini)} (horário de Brasília).` +
    (tenant.reuniao_local ? ` Local/link: ${tenant.reuniao_local}. Envie o local/link ao cliente.` : '') +
    ' Confirme ao cliente e diga que ele vai receber um lembrete antes.';
}

// ======================= Cadência (handlers dos jobs) =======================
async function textoFollowup(tenant, contact, instrucao, padrao) {
  try {
    const conv = db.prepare('SELECT id FROM conversations WHERE contact_id = ? ORDER BY id DESC LIMIT 1').get(contact.id);
    const hist = conv ? db.prepare('SELECT autor, conteudo FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 16').all(conv.id).reverse() : [];
    const t = await gerarMensagem(tenant, instrucao, hist, contact.nome);
    if (t) return t;
  } catch (e) { console.error('[vendas] follow-up IA', e.message); }
  return padrao;
}

const carregar = (contactId) => {
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);
  const tenant = contact && db.prepare('SELECT * FROM tenants WHERE id = ?').get(contact.tenant_id);
  return { contact, tenant };
};
const convComHumano = (contactId) => db.prepare('SELECT status FROM conversations WHERE contact_id = ? ORDER BY id DESC LIMIT 1').get(contactId)?.status === 'humano';
const clienteFalouDesde = (contactId, desdeISO) => { const t = ultimaMsgCliente(contactId); return t && t > desdeISO; };
const horasDesde = (sqlUTC) => (Date.now() - new Date(sqlUTC.replace(' ', 'T') + 'Z')) / 3600e3;

export const VENDAS_HANDLERS = {
  async followup_proposta({ proposal_id, tentativa, ultima }) {
    const p = getProposta(proposal_id);
    if (!p || p.status !== 'enviada') return 'proposta não está mais aberta';
    const { contact, tenant } = carregar(p.contact_id);
    if (!tenant || tenant.status !== 'ativo' || !tenant.vendas_ativo) return 'empresa inativa';
    if (convComHumano(contact.id)) return 'conversa com atendente humano';
    const ult = ultimaMsgCliente(contact.id);
    if (ult && horasDesde(ult) < 20) return 'cliente conversou recentemente';
    const nome = primeiroNome(contact);
    const padroes = [
      `Oi${nome ? ', ' + nome : ''}! Conseguiu dar uma olhada na proposta nº ${p.numero}? Se tiver qualquer dúvida sobre os itens ou o pagamento, me fala que eu resolvo.`,
      `${nome ? nome + ', ' : ''}passando para saber se posso ajudar a decidir sobre a proposta nº ${p.numero} (${brl(p.total)}). Quer que eu ajuste quantidade, prazo ou forma de pagamento?`,
      `${nome ? nome + ', ' : ''}não quero ser insistente 🙂 A proposta nº ${p.numero} vale até ${p.validade.split('-').reverse().join('/')}. Se o momento não for agora, me avisa que eu encerro por aqui. Se quiser seguir, é só responder.`,
    ];
    const instrucao = ultima
      ? `Último follow-up da proposta nº ${p.numero} (total ${brl(p.total)}, válida até ${p.validade.split('-').reverse().join('/')}). Escreva uma mensagem curta, educada, sem pressão, perguntando se pode encerrar ou se o cliente quer seguir.`
      : `Follow-up nº ${tentativa} da proposta nº ${p.numero} (total ${brl(p.total)}). O cliente não respondeu. Escreva uma mensagem curta e útil retomando a conversa a partir da necessidade dele, sem repetir a proposta inteira e sem oferecer desconto.`;
    const texto = await textoFollowup(tenant, contact, instrucao, padroes[Math.min(tentativa, 3) - 1]);
    const modelo = ultima
      ? { chave: 'ava_proposta_vencendo', params: [nome || 'tudo bem', p.numero, p.validade.split('-').reverse().join('/')] }
      : { chave: 'ava_followup_proposta', params: [nome || 'tudo bem', p.numero, tenant.nome, brl(p.total)] };
    const r = await enviarAoCliente(tenant, contact, texto, { motivoTarefa: `Follow-up ${tentativa} da proposta #${p.numero}`, modelo });
    const lead = garantirLead(tenant, contact, null);
    logActivity(tenant.id, lead.id, `Follow-up ${tentativa} da proposta #${p.numero}: ${r}`, { autor: 'ia' });
    return r;
  },

  async expirar_proposta({ proposal_id }) {
    const p = getProposta(proposal_id);
    if (!p || !['enviada', 'aguardando_aprovacao'].includes(p.status)) return 'nada a fazer';
    db.prepare("UPDATE proposals SET status = 'expirada' WHERE id = ?").run(p.id);
    const { contact, tenant } = carregar(p.contact_id);
    const lead = garantirLead(tenant, contact, null);
    if (lead.etapa === 'proposta') moverLead(lead, 'perdido', { motivo_perda: 'Proposta expirou sem resposta' });
    return 'expirada';
  },

  async reengajar({ contact_id, desde }) {
    const { contact, tenant } = carregar(contact_id);
    if (!tenant || tenant.status !== 'ativo' || !tenant.vendas_ativo || !tenant.cadencia_ativa) return 'inativo';
    if (convComHumano(contact_id)) return 'com humano';
    if (clienteFalouDesde(contact_id, desde)) return 'cliente respondeu';
    const lead = garantirLead(tenant, contact, null);
    if (!['novo', 'qualificado'].includes(lead.etapa)) return 'etapa não pede reengajamento';
    if (propostaAberta(contact_id)) return 'tem proposta aberta';
    const nome = primeiroNome(contact);
    const texto = await textoFollowup(tenant, contact,
      'O cliente parou de responder no meio do atendimento. Escreva UMA mensagem curta retomando exatamente de onde a conversa parou, com uma pergunta simples para ele continuar.',
      `Oi${nome ? ', ' + nome : ''}! Ficou alguma dúvida? Se quiser, sigo de onde paramos para te passar a melhor opção.`);
    const r = await enviarAoCliente(tenant, contact, texto, { motivoTarefa: 'Retomar conversa parada' });
    logActivity(tenant.id, lead.id, `IA retomou a conversa parada: ${r}`, { autor: 'ia' });
    return r;
  },

  async retorno_cliente({ contact_id, motivo, activity_id }) {
    const { contact, tenant } = carregar(contact_id);
    if (!tenant || tenant.status !== 'ativo' || !tenant.vendas_ativo) return 'inativo';
    if (convComHumano(contact_id)) return 'com humano';
    const nome = primeiroNome(contact);
    const texto = await textoFollowup(tenant, contact,
      `Hoje é o dia combinado de retornar ao cliente. Motivo do retorno: "${motivo}". Escreva uma mensagem curta retomando esse assunto.`,
      `Oi${nome ? ', ' + nome : ''}! Combinamos de retomar hoje: ${motivo}. Podemos seguir?`);
    const r = await enviarAoCliente(tenant, contact, texto, { motivoTarefa: `Retorno combinado: ${motivo}`, modelo: { chave: 'ava_retorno_combinado', params: [nome || 'tudo bem', motivo] } });
    if (r !== 'tarefa' && activity_id) db.prepare('UPDATE activities SET concluida = 1 WHERE id = ?').run(activity_id);
    return r;
  },

  async lembrete_pagamento({ charge_id, tentativa }) {
    const c = db.prepare('SELECT * FROM charges WHERE id = ?').get(charge_id);
    if (!c || c.status !== 'pendente') return 'cobrança não está pendente';
    const { contact, tenant } = carregar(c.contact_id);
    if (!tenant || tenant.status !== 'ativo') return 'inativo';
    const nome = primeiroNome(contact);
    const texto = tentativa === 1
      ? `Oi${nome ? ', ' + nome : ''}! Só lembrando do pagamento de ${brl(c.valor)} (${c.descricao}). O link é este:\n${c.pagamento_url}\nSe preferir outra forma de pagamento, me avisa.`
      : `${nome ? nome + ', ' : ''}ainda não identifiquei o pagamento de ${brl(c.valor)}. Teve algum problema com o link? Posso gerar outro ou trocar para Pix, boleto ou cartão.\n${c.pagamento_url}`;
    const ped = c.order_id && db.prepare('SELECT numero FROM orders WHERE id = ?').get(c.order_id);
    const modelo = ped ? { chave: 'shop_aguardando_pagamento', params: [nome || 'tudo bem', ped.numero, brl(c.valor), c.pagamento_url] }
      : { chave: 'ava_lembrete_pagamento', params: [nome || 'tudo bem', brl(c.valor), c.descricao, c.pagamento_url] };
    return enviarAoCliente(tenant, contact, texto, { motivoTarefa: `Lembrar pagamento de ${brl(c.valor)}`, modelo });
  },

  async lembrete_reuniao({ appointment_id, quando }) {
    const a = db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointment_id);
    if (!a || a.status !== 'agendada') return 'reunião não está agendada';
    const { contact, tenant } = carregar(a.contact_id);
    const nome = primeiroNome(contact);
    const texto = (quando === '1h'
      ? `${nome ? nome + ', ' : ''}nossa reunião começa em 1 hora (${a.inicio.slice(11)}).`
      : `Oi${nome ? ', ' + nome : ''}! Lembrete da nossa reunião amanhã, ${rotuloHorario(a.inicio)}.`) +
      (tenant.reuniao_local ? `\nLocal/link: ${tenant.reuniao_local}` : '') + (quando === '1h' ? '' : '\nSe precisar remarcar, é só me avisar aqui.');
    return enviarAoCliente(tenant, contact, texto, { motivoTarefa: `Lembrar reunião de ${rotuloHorario(a.inicio)}`,
      modelo: { chave: 'ava_lembrete_reuniao', params: [nome || 'tudo bem', 'reunião', tenant.nome, rotuloHorario(a.inicio)] } });
  },
};

/** Chamado pelo motor após cada resposta da IA: agenda a retomada se o cliente sumir. */
export function agendarReengajamento(tenant, contact) {
  if (!tenant.vendas_ativo || !tenant.cadencia_ativa) return;
  cancelarJobsDoContato(contact.id, ['reengajar']);
  const desde = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const [min] = lista('VENDAS_REENGAJAR_MIN', '1320'); // 22h: ainda dentro da janela de 24h do WhatsApp
  agendarEm('reengajar', { contact_id: contact.id, desde }, minutosDaqui(min));
}

// ======================= Ferramentas da IA =======================
const AGENDA_TOOLS = ['consultar_horarios', 'agendar_reuniao'];
export function ferramentasVendas(tenant) {
  if (!tenant.vendas_ativo && !tenant._so_agenda) return [];
  const h = tenant._habilidades;
  return todasFerramentasVendas().filter((f) => (AGENDA_TOOLS.includes(f.name)
    ? (!h || h.includes('agenda'))
    : tenant.vendas_ativo && (!h || h.includes('vendas'))));
}
function todasFerramentasVendas() {
  return [
    {
      name: 'criar_proposta',
      description: 'Monta e envia a proposta formal ao cliente (WhatsApp e, se houver, e-mail), com link para aprovar e pagar. ' +
        'Use quando souber os itens e quantidades. Também use para enviar uma nova versão negociada (substitui a anterior). ' +
        'O sistema calcula os valores e aplica a política comercial; se o desconto passar do limite, pede aprovação ao gestor.',
      input_schema: {
        type: 'object',
        properties: {
          itens: { type: 'array', description: 'Omitir para repetir os itens da proposta aberta (ex.: nova versão só com desconto)', items: { type: 'object', properties: {
            produto: { type: 'string', description: 'Código [n] ou nome do produto no catálogo' },
            quantidade: { type: 'number' },
            preco_unitario: { type: 'number', description: 'Só se for diferente do preço de tabela (negociação)' },
          }, required: ['produto', 'quantidade'] } },
          desconto_percentual: { type: 'number', description: 'Desconto negociado sobre o total (0 se não houver)' },
          frete: { type: 'number', description: 'Valor do frete em reais, se a base de conhecimento permitir calcular' },
          condicao_pagamento: { type: 'string', description: 'Ex.: "Pix à vista" ou "Cartão em até 6x"' },
          observacoes: { type: 'string', description: 'Prazo de entrega, especificações combinadas etc.' },
          email: { type: 'string', description: 'E-mail para enviar a proposta, se o cliente informou' },
          nome: { type: 'string' }, empresa: { type: 'string' },
        },
        required: [],
      },
    },
    {
      name: 'gerar_cobranca',
      description: 'Gera e envia o link de pagamento da proposta aberta, quando o cliente aceitar e escolher a forma de pagamento.',
      input_schema: {
        type: 'object',
        properties: {
          forma: { type: 'string', enum: ['pix', 'boleto', 'cartao', 'livre'], description: 'livre = o cliente escolhe no link' },
          parcelas: { type: 'number', description: 'Parcelas no cartão (respeite o máximo da política)' },
        },
        required: ['forma'],
      },
    },
    {
      name: 'consultar_horarios',
      description: 'Lista os próximos horários livres na agenda para reunião, visita ou demonstração.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'agendar_reuniao',
      description: 'Marca a reunião num horário livre (escolhido pelo cliente entre os de consultar_horarios).',
      input_schema: {
        type: 'object',
        properties: {
          data_hora: { type: 'string', description: 'AAAA-MM-DDTHH:MM, horário de Brasília' },
          assunto: { type: 'string', description: 'Ex.: Demonstração do produto' },
        },
        required: ['data_hora'],
      },
    },
    {
      name: 'enviar_email',
      description: 'Envia um e-mail ao cliente (ex.: informações técnicas, resumo do atendimento). Para proposta, use criar_proposta.',
      input_schema: {
        type: 'object',
        properties: { email: { type: 'string' }, assunto: { type: 'string' }, mensagem: { type: 'string', description: 'Texto do e-mail, em parágrafos' } },
        required: ['assunto', 'mensagem'],
      },
    },
    {
      name: 'registrar_perda',
      description: 'Registra que o cliente desistiu da compra (com o motivo) e encerra os follow-ups. Use só quando ele disser claramente que não vai comprar.',
      input_schema: { type: 'object', properties: { motivo: { type: 'string', description: 'Ex.: preço, comprou do concorrente, adiou o projeto' } }, required: ['motivo'] },
    },
  ];
}

/** Executa uma ferramenta de vendas. Retorna texto para a IA ou null se não for de vendas. */
export async function executarFerramentaVendas(ctx, nome, input) {
  const { tenant, contact, conv } = ctx;
  if (!ferramentasVendas(tenant).some((f) => f.name === nome)) return null;
  if (nome === 'criar_proposta') {
    try { return await criarProposta(ctx, input); } catch (e) { return `Não foi possível montar a proposta: ${e.message}`; }
  }
  if (nome === 'gerar_cobranca') {
    const p = propostaAberta(contact.id);
    const r = await gerarCobranca(tenant, contact, p, input);
    if (r.erro) return r.erro;
    await ctx.enviar(textoCobranca(r.charge, r.descAvista));
    if (r.charge.pix_copia_cola) {
      await ctx.enviar(r.charge.pix_copia_cola);
      return 'Cobrança Pix enviada (copia e cola + link do QR Code). É Pix direto na conta da empresa: a confirmação é manual. Peça o comprovante e NUNCA diga que o pagamento foi confirmado; a equipe confirma no painel.';
    }
    return 'Link de pagamento enviado ao cliente. Não repita o link. Agradeça em uma frase e diga que você avisa quando o pagamento cair.';
  }
  if (nome === 'consultar_horarios') {
    const hs = horariosLivres(tenant, 6);
    if (!hs.length) return 'Sem horários livres nas próximas semanas. Use agendar_retorno.';
    return 'Horários livres (Brasília): ' + hs.map((h) => `${rotuloHorario(h)} [${h.replace(' ', 'T')}]`).join('; ') +
      '. Ofereça 2 ou 3 opções ao cliente e, quando ele escolher, chame agendar_reuniao com o valor entre colchetes.';
  }
  if (nome === 'agendar_reuniao') return agendarReuniao(ctx, input);
  if (nome === 'enviar_email') {
    const lead = garantirLead(tenant, contact, conv);
    const to = (input.email || lead.email || '').trim();
    if (!to) return 'O cliente não informou e-mail. Peça o e-mail antes.';
    if (input.email) db.prepare('UPDATE leads SET email = ? WHERE id = ?').run(to, lead.id);
    const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1d2433">${String(input.mensagem).split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}
      <p style="color:#6b7385;font-size:13px">${esc(tenant.nome)} · enviado pela ${esc(tenant.nome_assistente)}</p></div>`;
    const r = await sendEmail(tenant, { to, subject: input.assunto, html, text: input.mensagem });
    if (r.erro) return `Falha ao enviar o e-mail: ${r.erro}.`;
    logActivity(tenant.id, lead.id, `E-mail enviado para ${to}: ${input.assunto}`, { tipo: 'nota', autor: 'ia' });
    return `E-mail enviado para ${to}.`;
  }
  if (nome === 'registrar_perda') {
    const lead = garantirLead(tenant, contact, conv);
    moverLead(lead, 'perdido', { motivo_perda: input.motivo });
    db.prepare("UPDATE proposals SET status = 'recusada' WHERE contact_id = ? AND status IN ('enviada','aguardando_aprovacao','aceita')").run(contact.id);
    cancelarJobsDoContato(contact.id);
    logActivity(tenant.id, lead.id, `Cliente desistiu: ${input.motivo}`, { autor: 'ia' });
    return 'Perda registrada e follow-ups encerrados. Agradeça com cordialidade e deixe a porta aberta.';
  }
  return null;
}

export function contextoVendas(contactId) {
  const p = propostaAberta(contactId);
  const c = db.prepare("SELECT * FROM charges WHERE contact_id = ? ORDER BY id DESC LIMIT 1").get(contactId);
  const a = db.prepare("SELECT * FROM appointments WHERE contact_id = ? AND status = 'agendada' AND inicio >= ? ORDER BY inicio LIMIT 1").get(contactId, fmtLocal(agoraBR()));
  const partes = [];
  if (p) partes.push(`Proposta nº ${p.numero} (${p.status}): ${JSON.parse(p.itens).map((i) => `${i.quantidade}x ${i.nome}`).join(', ')}, total ${brl(p.total)}, válida até ${p.validade}.`);
  if (c) partes.push(`Última cobrança: ${brl(c.valor)} (${c.forma}) — ${c.status}.`);
  if (a) partes.push(`Reunião marcada: ${rotuloHorario(a.inicio)}.`);
  return partes.join(' ');
}

export function promptVendas(tenant) {
  const dias = String(tenant.agenda_dias || '').split(',').map((d) => SEMANA[Number(d)]).filter(Boolean).join(', ');
  if (!tenant.vendas_ativo && tenant._so_agenda) return `
Agenda: para marcar reunião, visita ou demonstração, chame consultar_horarios, ofereça 2 ou 3 opções e marque com agendar_reuniao. Atendimento: ${dias || 'dias úteis'}, ${tenant.agenda_inicio} às ${tenant.agenda_fim}.`;
  if (!tenant.vendas_ativo) return '';
  return `
Você é também a VENDEDORA da empresa: conduz o cliente do primeiro contato até o pagamento.

Catálogo (preços de tabela — fonte de verdade junto com a base de conhecimento):
${textoCatalogo(tenant)}

Política comercial (o sistema bloqueia o que passar disso):
- Desconto que você pode dar sozinha: até ${tenant.desconto_max}% sobre o preço de tabela.
- Desconto extra para pagamento à vista (Pix, boleto ou cartão 1x): ${tenant.desconto_avista > 0 ? tenant.desconto_avista + '% (aplicado automaticamente na cobrança)' : 'não há'}.
- Cartão: até ${tenant.parcelas_max}x.
- Proposta válida por ${tenant.validade_proposta_dias} dias.
${tenant.condicoes_pagamento ? `- Condições de pagamento: ${tenant.condicoes_pagamento}\n` : ''}${tenant.frete_info ? `- Frete/entrega: ${tenant.frete_info}\n` : ''}
Como vender:
1. Entenda antes de oferecer: no máximo 2 ou 3 perguntas (o que precisa, para quê, quantidade, prazo, cidade). Registre com registrar_lead.
2. Recomende a opção certa do catálogo e explique o benefício em uma ou duas frases.
3. Com itens e quantidades definidos, peça o e-mail (opcional) e chame criar_proposta. Nunca digite a proposta à mão.
4. Objeções: preço → reforce valor, prazo e garantia antes de falar de desconto; "vou pensar" → pergunte o que falta para decidir; "vou ver com o sócio" → ofereça uma reunião (consultar_horarios) ou combine o retorno (agendar_retorno com data).
5. Negociação: nunca ofereça desconto espontaneamente. Se pedirem, conceda em degraus (primeiro metade do seu limite) e sempre em troca de algo: fechar hoje, pagar à vista, quantidade maior. Para aplicar, gere uma nova proposta com criar_proposta. Se o cliente exigir mais que o seu limite, gere a proposta com a condição pedida: o sistema pede aprovação ao gestor.
6. Fechamento: quando o cliente aceitar, pergunte a forma de pagamento (Pix, boleto ou cartão) e chame gerar_cobranca.
7. Reunião, visita ou demonstração: chame consultar_horarios, ofereça 2 ou 3 opções e marque com agendar_reuniao. Agenda: ${dias || 'dias úteis'}, ${tenant.agenda_inicio} às ${tenant.agenda_fim}.
8. Se o cliente disser claramente que não vai comprar, chame registrar_perda.
- Negociação de preço dentro da política é com você: não transfira para humano por isso.`;
}

// ======================= Páginas públicas =======================
function htmlEmailProposta(tenant, contact, p, link) {
  const itens = JSON.parse(p.itens);
  return `<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#1d2433">
  <div style="background:#071430;color:#fff;padding:20px 24px;border-radius:10px 10px 0 0"><div style="font-size:13px;opacity:.8">${esc(tenant.nome)}</div>
  <div style="font-size:22px;font-weight:bold">Proposta nº ${p.numero}</div></div>
  <div style="border:1px solid #e3e8f0;border-top:0;padding:20px 24px;border-radius:0 0 10px 10px">
  <p>Olá${primeiroNome(contact) ? ', ' + esc(primeiroNome(contact)) : ''}! Segue a proposta conforme conversamos.</p>
  <table style="width:100%;border-collapse:collapse;font-size:14px">${itens.map((i) => `<tr><td style="padding:8px 0;border-bottom:1px solid #eee">${i.quantidade} ${esc(i.unidade)} — ${esc(i.nome)}</td><td style="text-align:right;border-bottom:1px solid #eee">${brl(i.total)}</td></tr>`).join('')}
  ${p.frete > 0 ? `<tr><td style="padding:8px 0">Frete</td><td style="text-align:right">${brl(p.frete)}</td></tr>` : ''}
  <tr><td style="padding:10px 0;font-weight:bold">Total</td><td style="text-align:right;font-weight:bold;font-size:18px">${brl(p.total)}</td></tr></table>
  ${p.condicao_pagamento ? `<p><b>Pagamento:</b> ${esc(p.condicao_pagamento)}</p>` : ''}${p.observacoes ? `<p><b>Observações:</b> ${esc(p.observacoes)}</p>` : ''}
  <p>Válida até ${p.validade.split('-').reverse().join('/')}.</p>
  <p style="text-align:center;margin:26px 0"><a href="${link}" style="background:linear-gradient(90deg,#1f6fff,#12d8c4);color:#fff;text-decoration:none;padding:13px 26px;border-radius:9px;font-weight:bold">Ver e aprovar a proposta</a></p>
  <p style="font-size:13px;color:#6b7385">Dúvidas? Responda este e-mail ou fale com a ${esc(tenant.nome_assistente)} no WhatsApp.</p></div></div>`;
}

export function paginaProposta(p, tenant, contact) {
  const itens = JSON.parse(p.itens);
  const aberta = ['enviada', 'aceita'].includes(p.status) && p.validade >= fmtLocal(agoraBR()).slice(0, 10);
  const descAv = Number(tenant.desconto_avista || 0);
  const avista = r2((p.total - p.frete) * (1 - descAv / 100) + p.frete);
  const STATUS = { paga: '✅ Proposta paga. Obrigado!', expirada: 'Esta proposta venceu. Fale conosco no WhatsApp para uma nova.', substituida: 'Esta proposta foi substituída por uma versão mais nova, enviada no WhatsApp.',
    recusada: 'Esta proposta foi encerrada.', aguardando_aprovacao: 'Esta proposta está em análise.' };
  return pagina(`Proposta nº ${p.numero} — ${tenant.nome}`, `<header class="top"><div class="wrap"><div style="opacity:.8;font-size:14px">${esc(tenant.nome)}</div>
  <h1 style="margin:6px 0 2px">Proposta nº ${p.numero}</h1><div style="opacity:.8">Para ${esc(contact.nome || contact.telefone)} · válida até ${p.validade.split('-').reverse().join('/')}</div></div></header>
  <main class="wrap"><div class="card" style="margin-top:-30px">
  <table style="width:100%;border-collapse:collapse">${itens.map((i) => `<tr><td style="padding:10px 0;border-bottom:1px solid #e3e8f0"><b>${esc(i.nome)}</b><div style="color:#6b7385;font-size:13px">${i.quantidade} ${esc(i.unidade)} × ${brl(i.preco_unitario)}</div></td>
    <td style="text-align:right;border-bottom:1px solid #e3e8f0">${brl(i.total)}</td></tr>`).join('')}
  ${p.desconto_percentual > 0 ? `<tr><td style="padding:8px 0">Desconto</td><td style="text-align:right">${p.desconto_percentual}%</td></tr>` : ''}
  ${p.frete > 0 ? `<tr><td style="padding:8px 0">Frete</td><td style="text-align:right">${brl(p.frete)}</td></tr>` : ''}
  <tr><td style="padding:12px 0;font-size:18px"><b>Total</b></td><td style="text-align:right;font-size:22px"><b>${brl(p.total)}</b></td></tr></table>
  ${p.condicao_pagamento ? `<p><b>Pagamento:</b> ${esc(p.condicao_pagamento)}</p>` : ''}${p.observacoes ? `<p><b>Observações:</b> ${esc(p.observacoes)}</p>` : ''}
  </div>
  <div class="card" style="text-align:center">${aberta ? `<h2 style="margin-top:0">Aprovar e pagar</h2>
    <form method="post" action="/proposta/${p.token}/aceitar" style="display:grid;gap:10px;max-width:360px;margin:auto">
      <button class="btn" name="forma" value="pix" type="submit">Pix — ${brl(avista)}${descAv > 0 ? ` <small>(${descAv}% à vista)</small>` : ''}</button>
      <button class="btn" name="forma" value="boleto" type="submit" style="background:#fff;color:#071430;border:1px solid #c9d3e3">Boleto — ${brl(avista)}</button>
      ${tenant.parcelas_max > 1 ? `<button class="btn" name="forma" value="cartao" type="submit" style="background:#fff;color:#071430;border:1px solid #c9d3e3">Cartão em até ${tenant.parcelas_max}x — ${brl(p.total)}</button>
      <input type="hidden" name="parcelas" value="${tenant.parcelas_max}">` : `<button class="btn" name="forma" value="cartao" type="submit" style="background:#fff;color:#071430;border:1px solid #c9d3e3">Cartão — ${brl(avista)}</button>`}
    </form><p style="color:#6b7385;font-size:13px">Pagamento processado com segurança pelo Asaas. Ao aprovar, você concorda com os itens e condições acima.</p>`
    : `<p style="font-size:16px">${STATUS[p.status] || 'Proposta encerrada.'}</p>`}</div>
  <p class="note">Para salvar em PDF, use a opção Imprimir do navegador.</p></main>`);
}

export function paginaPagamentoTesteCobranca(c) {
  return pagina('Pagamento (modo de teste)', `<div class="wrap"><div class="card" style="margin-top:40px;text-align:center">
    <h2>${esc(c.descricao)} — ${brl(c.valor)}</h2>
    <p>Esta é a página de pagamento do <b>modo de teste</b>. Com o Asaas configurado, o cliente vê aqui o checkout com Pix, boleto e cartão.</p>
    ${c.status === 'pago' ? '<p>Pagamento já confirmado.</p>' : `<form method="post" action="/pagar/${c.token}/simular"><button class="btn" type="submit">Simular pagamento aprovado</button></form>`}
  </div></div>`);
}
export const paginaObrigado = (tenant) => pagina('Obrigado!', `<div class="wrap"><div class="card" style="margin-top:40px;text-align:center">
  <h2>Obrigado! 🎉</h2><p>Assim que o pagamento for confirmado, a ${esc(tenant.nome_assistente)} te avisa no WhatsApp.</p></div></div>`);

export function rotasPublicas(app) {
  app.get('/proposta/:token', (req, res) => {
    const p = db.prepare('SELECT * FROM proposals WHERE token = ?').get(req.params.token);
    if (!p) return res.status(404).send('Proposta não encontrada.');
    const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(p.tenant_id);
    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(p.contact_id);
    res.set('cache-control', 'no-store').send(paginaProposta(p, tenant, contact));
  });
  app.post('/proposta/:token/aceitar', async (req, res) => {
    const p = db.prepare('SELECT * FROM proposals WHERE token = ?').get(req.params.token);
    if (!p) return res.status(404).send('Proposta não encontrada.');
    const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(p.tenant_id);
    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(p.contact_id);
    const r = await gerarCobranca(tenant, contact, p, { forma: req.body?.forma, parcelas: req.body?.parcelas });
    if (r.erro) return res.status(400).send(pagina('Proposta', `<div class="wrap"><div class="card" style="margin-top:40px;text-align:center"><p>${esc(r.erro)}</p></div></div>`));
    await enviarAoCliente(tenant, contact, textoCobranca(r.charge, r.descAvista), { motivoTarefa: 'Enviar link de pagamento' }).catch(() => {});
    res.redirect(303, r.charge.pagamento_url);
  });
  app.get('/obrigado/:token', (req, res) => {
    const c = getCobranca(req.params.token);
    if (!c) return res.status(404).send('Não encontrado.');
    if (c.signup_tenant_id) return res.send(pagina('Bem-vindo ao AVA Connect', `<div class="wrap"><div class="card" style="margin-top:40px;text-align:center">
      <h2>${c.status === 'pago' ? 'Conta ativada! 🎉' : 'Recebemos seu pedido!'}</h2>
      <p>${c.status === 'pago' ? 'Seu AVA Connect está ativo. Entre no painel para terminar a configuração da sua assistente.' : 'Assim que o pagamento for confirmado, sua conta é ativada automaticamente. Pix confirma na hora; boleto, em até 2 dias úteis.'}</p>
      <p><a class="btn" href="/app">Entrar no painel</a></p></div></div>`));
    res.send(paginaObrigado(db.prepare('SELECT * FROM tenants WHERE id = ?').get(c.tenant_id)));
  });
}

// ======================= API do painel =======================
const PROD_CAMPOS = ['nome', 'descricao', 'preco', 'preco_minimo', 'unidade', 'ativo'];

export function vendasRouter(canSee, adminOnly) {
  const r = express.Router();
  const dono = (req, res, tabela) => {
    const row = db.prepare(`SELECT * FROM ${tabela} WHERE id = ?`).get(req.params.id);
    if (!row) { res.sendStatus(404); return null; }
    if (!canSee(req, row.tenant_id)) { res.sendStatus(403); return null; }
    return row;
  };
  const tenantOk = (req, res) => { if (!canSee(req, req.params.id)) { res.sendStatus(403); return false; } return true; };

  // Catálogo
  r.get('/tenants/:id/products', (req, res) => { if (!tenantOk(req, res)) return;
    res.json(db.prepare('SELECT * FROM products WHERE tenant_id = ? ORDER BY ativo DESC, nome').all(req.params.id)); });
  r.post('/tenants/:id/products', (req, res) => { if (!tenantOk(req, res)) return;
    const b = req.body || {};
    if (!b.nome || !(Number(b.preco) > 0)) return res.status(400).json({ erro: 'Informe nome e preço' });
    const x = db.prepare('INSERT INTO products (tenant_id, nome, descricao, preco, preco_minimo, unidade) VALUES (?,?,?,?,?,?)')
      .run(req.params.id, b.nome, b.descricao || null, Number(b.preco), b.preco_minimo ? Number(b.preco_minimo) : null, b.unidade || 'un');
    res.status(201).json(db.prepare('SELECT * FROM products WHERE id = ?').get(x.lastInsertRowid)); });
  r.put('/products/:id', (req, res) => { const p = dono(req, res, 'products'); if (!p) return;
    const b = req.body || {}; const cs = PROD_CAMPOS.filter((c) => b[c] !== undefined);
    if (cs.length) db.prepare(`UPDATE products SET ${cs.map((c) => c + ' = ?').join(', ')} WHERE id = ?`)
      .run(...cs.map((c) => (b[c] === '' ? null : ['preco', 'preco_minimo'].includes(c) ? Number(b[c]) : typeof b[c] === 'boolean' ? Number(b[c]) : b[c])), p.id);
    res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(p.id)); });
  r.delete('/products/:id', (req, res) => { const p = dono(req, res, 'products'); if (!p) return;
    db.prepare('DELETE FROM products WHERE id = ?').run(p.id); res.json({ ok: true }); });

  // Propostas
  r.get('/tenants/:id/proposals', (req, res) => { if (!tenantOk(req, res)) return;
    res.json(db.prepare(`SELECT p.*, ct.nome contato_nome, ct.telefone, (SELECT conversation_id FROM leads WHERE id = p.lead_id) conv_id
      FROM proposals p JOIN contacts ct ON ct.id = p.contact_id WHERE p.tenant_id = ? AND p.status != 'substituida' ORDER BY p.id DESC LIMIT 300`).all(req.params.id)); });
  r.post('/proposals/:id/aprovar', async (req, res) => { const p = dono(req, res, 'proposals'); if (!p) return;
    res.json(await aprovarProposta(p, req.body?.aprovado !== false, req.user.admin ? 'administrador' : 'gestor')); });

  // Cobranças
  r.get('/tenants/:id/charges', (req, res) => { if (!tenantOk(req, res)) return;
    res.json(db.prepare(`SELECT c.*, ct.nome contato_nome, ct.telefone FROM charges c JOIN contacts ct ON ct.id = c.contact_id
      WHERE c.tenant_id = ? AND c.status != 'cancelado' ORDER BY c.id DESC LIMIT 300`).all(req.params.id)); });
  r.post('/charges/:id/confirmar', async (req, res) => { const c = dono(req, res, 'charges'); if (!c) return;
    res.json(await confirmarPagamentoCobranca(c)); });

  // Agenda
  r.get('/tenants/:id/appointments', (req, res) => { if (!tenantOk(req, res)) return;
    res.json(db.prepare(`SELECT a.*, ct.nome contato_nome, ct.telefone FROM appointments a JOIN contacts ct ON ct.id = a.contact_id
      WHERE a.tenant_id = ? AND a.inicio >= date('now','-30 days') ORDER BY a.inicio LIMIT 300`).all(req.params.id)); });
  r.post('/appointments/:id/status', (req, res) => { const a = dono(req, res, 'appointments'); if (!a) return;
    const s = req.body?.status; if (!['agendada', 'realizada', 'cancelada', 'faltou'].includes(s)) return res.status(400).json({ erro: 'Status inválido' });
    db.prepare('UPDATE appointments SET status = ? WHERE id = ?').run(s, a.id);
    if (s !== 'agendada') db.prepare("UPDATE jobs SET status = 'cancelado' WHERE status = 'pendente' AND tipo = 'lembrete_reuniao' AND json_extract(payload, '$.appointment_id') = ?").run(a.id);
    res.json({ ok: true }); });
  r.get('/tenants/:id/horarios', (req, res) => { if (!tenantOk(req, res)) return;
    const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
    res.json(horariosLivres(t, 8).map((h) => ({ inicio: h, rotulo: rotuloHorario(h) }))); });

  // Indicadores de vendas do mês
  r.get('/tenants/:id/vendas-stats', (req, res) => { if (!tenantOk(req, res)) return;
    const id = req.params.id; const mes = new Date().toISOString().slice(0, 7);
    const one = (sql, ...a) => db.prepare(sql).get(id, ...a);
    const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
    res.json({
      propostas_mes: one("SELECT COUNT(*) n FROM proposals WHERE tenant_id = ? AND status != 'substituida' AND substr(criado_em,1,7) = ?", mes).n,
      em_aberto: one("SELECT COUNT(*) n, COALESCE(SUM(total),0) v FROM proposals WHERE tenant_id = ? AND status IN ('enviada','aceita','aguardando_aprovacao')"),
      aguardando_aprovacao: one("SELECT COUNT(*) n FROM proposals WHERE tenant_id = ? AND status = 'aguardando_aprovacao'").n,
      vendido_mes: one("SELECT COUNT(*) n, COALESCE(SUM(valor),0) v FROM charges WHERE tenant_id = ? AND status = 'pago' AND substr(pago_em,1,7) = ?", mes),
      a_receber: one("SELECT COUNT(*) n, COALESCE(SUM(valor),0) v FROM charges WHERE tenant_id = ? AND status IN ('pendente','vencido')"),
      reunioes_proximas: one("SELECT COUNT(*) n FROM appointments WHERE tenant_id = ? AND status = 'agendada' AND inicio >= ?", fmtLocal(agoraBR())).n,
      followups_pendentes: db.prepare(`SELECT COUNT(*) n FROM jobs j JOIN contacts c ON c.id = json_extract(j.payload,'$.contact_id')
        WHERE j.status = 'pendente' AND c.tenant_id = ?`).get(id).n,
      pagamento: modoPagamento(t),
    });
  });
  return r;
}
