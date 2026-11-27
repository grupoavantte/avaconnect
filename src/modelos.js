// Modelos de mensagem (templates) da Meta para cada fase da AVA e do AvaShop.
// Fora da janela de 24h, o WhatsApp só aceita mensagens de modelos aprovados. Este módulo:
//  - define a biblioteca padrão (texto, categoria e exemplo) usada por todas as empresas;
//  - envia os modelos para aprovação na conta do WhatsApp Business da empresa e acompanha o status;
//  - escolhe o modelo certo quando o sistema precisa falar com alguém fora da janela.
import express from 'express';
import { db } from './db.js';
import { sendText, sendTemplate } from './whatsapp.js';
import { pode } from './auth.js';

const GRAPH = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v21.0'}`;

// Regras da Meta seguidas aqui: o texto não começa nem termina com variável; variáveis em sequência {{1}}, {{2}}...;
// cada variável tem exemplo; parâmetros não podem ter quebra de linha.
// categoria: UTILITY (sobre algo que o cliente pediu: pedido, proposta, pagamento, reunião) | MARKETING (promoção, reativação).
export const MODELOS = [
  // ---- AVA: atendimento e vendas ----
  { chave: 'ava_retomar_atendimento', fase: 'Atendimento', uso: 'Retomar uma conversa parada (fora das 24h)', categoria: 'UTILITY',
    corpo: 'Olá, {{1}}! Aqui é {{2}}, da {{3}}. Ficou alguma dúvida sobre o seu atendimento? Responda esta mensagem para continuarmos de onde paramos.',
    exemplo: ['Maria', 'AVA', 'Loja Exemplo'], botoes: ['Continuar'] },
  { chave: 'ava_lead_formulario', fase: 'Atendimento', uso: 'Responder no WhatsApp quem preencheu o formulário do site (com consentimento)', categoria: 'UTILITY',
    corpo: 'Olá, {{1}}! Recebemos seu contato pelo site da {{2}} sobre: {{3}}. Posso continuar seu atendimento por aqui? É só responder esta mensagem.',
    exemplo: ['Maria', 'Loja Exemplo', 'orçamento de 1.000 caixas'], botoes: ['Sim, pode continuar'] },
  { chave: 'ava_retorno_combinado', fase: 'Atendimento', uso: 'Retorno no dia combinado com o cliente', categoria: 'UTILITY',
    corpo: 'Olá, {{1}}! Conforme combinamos, estou retomando o assunto: {{2}}. Podemos seguir por aqui?',
    exemplo: ['Maria', 'orçamento das caixas'], botoes: ['Sim, vamos seguir', 'Depois'] },
  { chave: 'ava_followup_proposta', fase: 'Vendas', uso: 'Follow-up da proposta enviada', categoria: 'UTILITY',
    corpo: 'Olá, {{1}}! A proposta nº {{2}} da {{3}}, no valor de {{4}}, continua válida. Posso ajudar com alguma dúvida para seguirmos?',
    exemplo: ['Maria', '37', 'Loja Exemplo', 'R$ 4.990,00'], botoes: ['Tenho dúvidas', 'Quero fechar'] },
  { chave: 'ava_proposta_vencendo', fase: 'Vendas', uso: 'Último aviso antes da proposta vencer', categoria: 'UTILITY',
    corpo: 'Olá, {{1}}! A proposta nº {{2}} vence em {{3}}. Se quiser seguir ou ajustar alguma condição, é só responder esta mensagem.',
    exemplo: ['Maria', '37', '30/11'], botoes: ['Quero seguir'] },
  { chave: 'ava_lembrete_pagamento', fase: 'Vendas', uso: 'Lembrete de pagamento em aberto (proposta ou pedido)', categoria: 'UTILITY',
    corpo: 'Olá, {{1}}! Lembrete do pagamento de {{2}} referente a {{3}}. Para pagar, acesse: {{4}} . Se já pagou, desconsidere esta mensagem.',
    exemplo: ['Maria', 'R$ 4.990,00', 'Proposta nº 37', 'https://www.asaas.com/i/abc123'] },
  { chave: 'ava_pagamento_confirmado', fase: 'Vendas', uso: 'Confirmação de pagamento recebido', categoria: 'UTILITY',
    corpo: 'Olá, {{1}}! Confirmamos o pagamento de {{2}} referente a {{3}}. Obrigado pela confiança!',
    exemplo: ['Maria', 'R$ 4.990,00', 'Proposta nº 37'] },
  { chave: 'ava_lembrete_reuniao', fase: 'Agenda', uso: 'Lembrete de reunião ou visita marcada', categoria: 'UTILITY',
    corpo: 'Olá, {{1}}! Lembrete: {{2}} com a {{3}} em {{4}}. Se precisar remarcar, responda esta mensagem.',
    exemplo: ['Maria', 'reunião comercial', 'Loja Exemplo', '25/11 às 10h'], botoes: ['Confirmo', 'Preciso remarcar'] },
  { chave: 'ava_alerta_equipe', fase: 'Equipe', uso: 'Avisos para a equipe (transferência, aprovação de desconto, venda fechada, nota baixa)', categoria: 'UTILITY',
    corpo: 'Aviso do AVA Connect para a equipe da {{1}}: {{2}}. Abra o painel para ver os detalhes.',
    exemplo: ['Loja Exemplo', 'Maria precisa de atendimento (Financeiro)'] },
  // ---- AvaShop ----
  { chave: 'shop_carrinho_parado', fase: 'AvaShop', uso: 'Cliente viu o frete e não fechou o pedido', categoria: 'MARKETING',
    corpo: 'Oi, {{1}}! Os itens que você escolheu na {{2}} ({{3}}) ainda estão separados. Quer que eu finalize o seu pedido? Para não receber mais mensagens, responda SAIR.',
    exemplo: ['Maria', 'Loja Exemplo', '2x Camiseta Azul M'], botoes: ['Finalizar pedido'] },
  { chave: 'shop_aguardando_pagamento', fase: 'AvaShop', uso: 'Pedido criado e ainda não pago', categoria: 'UTILITY',
    corpo: 'Olá, {{1}}! O seu pedido nº {{2}} ({{3}}) está aguardando pagamento. Para pagar, acesse: {{4}} . Qualquer dúvida, responda esta mensagem.',
    exemplo: ['Maria', '1042', 'R$ 129,90', 'https://www.asaas.com/i/abc123'] },
  { chave: 'shop_pagamento_confirmado', fase: 'AvaShop', uso: 'Pagamento do pedido confirmado', categoria: 'UTILITY',
    corpo: 'Olá, {{1}}! O pagamento do pedido nº {{2}} foi confirmado. Vamos separar e avisar você quando for enviado.',
    exemplo: ['Maria', '1042'] },
  { chave: 'shop_pedido_enviado', fase: 'AvaShop', uso: 'Pedido enviado, com rastreio', categoria: 'UTILITY',
    corpo: 'Olá, {{1}}! O seu pedido nº {{2}} foi enviado. Código de rastreio: {{3}} . Acompanhe pelo site da transportadora.',
    exemplo: ['Maria', '1042', 'BR123456789'] },
  { chave: 'shop_pronto_retirada', fase: 'AvaShop', uso: 'Pedido pronto para retirada', categoria: 'UTILITY',
    corpo: 'Olá, {{1}}! O seu pedido nº {{2}} está pronto para retirada em {{3}}. Até já!',
    exemplo: ['Maria', '1042', 'Rua A, 10 - Centro'] },
  { chave: 'shop_pedido_entregue', fase: 'AvaShop', uso: 'Pedido entregue', categoria: 'UTILITY',
    corpo: 'Olá, {{1}}! O seu pedido nº {{2}} foi entregue. Se precisar de qualquer coisa, é só responder esta mensagem.',
    exemplo: ['Maria', '1042'] },
  { chave: 'shop_pedido_cancelado', fase: 'AvaShop', uso: 'Pedido cancelado', categoria: 'UTILITY',
    corpo: 'Olá, {{1}}! O pedido nº {{2}} foi cancelado. Se quiser, montamos um novo pedido por aqui.',
    exemplo: ['Maria', '1042'] },
  // ---- Campanhas (marketing) ----
  { chave: 'mkt_promocao', fase: 'Campanhas', uso: 'Promoção ou oferta (texto da oferta na variável 2)', categoria: 'MARKETING',
    corpo: 'Oi, {{1}}! {{2}} Responda esta mensagem para saber mais. Para não receber mais ofertas, responda SAIR.',
    exemplo: ['Maria', 'Esta semana tem 10% de desconto em toda a linha de camisetas.'], botoes: ['Quero saber mais'] },
  { chave: 'mkt_reativacao', fase: 'Campanhas', uso: 'Reativar clientes que não conversam há tempo', categoria: 'MARKETING',
    corpo: 'Oi, {{1}}! Faz tempo que não conversamos aqui na {{2}}. {{3}} Responda para ver as novidades. Para sair da lista, responda SAIR.',
    exemplo: ['Maria', 'Loja Exemplo', 'Chegaram modelos novos esta semana.'], botoes: ['Ver novidades'] },
  { chave: 'mkt_reposicao', fase: 'Campanhas', uso: 'Produto voltou ao estoque', categoria: 'MARKETING',
    corpo: 'Oi, {{1}}! Boa notícia: {{2}} voltou ao estoque na {{3}}. Quer garantir o seu? Para sair da lista, responda SAIR.',
    exemplo: ['Maria', 'a Camiseta Azul', 'Loja Exemplo'], botoes: ['Quero garantir'] },
  { chave: 'mkt_pos_venda', fase: 'Campanhas', uso: 'Pós-venda: indicação, recompra ou avaliação', categoria: 'MARKETING',
    corpo: 'Oi, {{1}}! Obrigado por comprar com a {{2}}. {{3}} Para sair da lista, responda SAIR.',
    exemplo: ['Maria', 'Loja Exemplo', 'Indique um amigo e ganhe 10% na próxima compra.'] },
];
export const getModelo = (chave) => MODELOS.find((m) => m.chave === chave);
const nVars = (corpo) => (corpo.match(/\{\{\d+\}\}/g) || []).length;

db.exec(`
CREATE TABLE IF NOT EXISTS tenant_templates (
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  chave TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'nao_enviado',  -- nao_enviado | existente | PENDING | APPROVED | REJECTED | PAUSED | DISABLED | erro
  categoria_meta TEXT,                          -- categoria final definida pela Meta (pode reclassificar)
  meta_id TEXT,
  motivo TEXT,
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, chave)
);
CREATE TABLE IF NOT EXISTS modelos_proprios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  categoria TEXT NOT NULL,
  idioma TEXT NOT NULL DEFAULT 'pt_BR',
  corpo TEXT NOT NULL,
  exemplos TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  categoria_meta TEXT,
  meta_id TEXT,
  motivo TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, nome)
);
`);

const limparParam = (v) => String(v ?? '').replace(/[\r\n\t]+/g, ' · ').replace(/ {4,}/g, '   ').trim().slice(0, 900) || '-';
export const aprovado = (tenantId, chave) =>
  db.prepare("SELECT 1 FROM tenant_templates WHERE tenant_id = ? AND chave = ? AND status = 'APPROVED'").get(tenantId, chave);

/** Envia o modelo aprovado. Devolve true se foi enviado. */
export async function enviarModelo(tenant, telefone, chave, params) {
  const m = getModelo(chave);
  if (!m || !aprovado(tenant.id, chave)) return false;
  const ps = Array.from({ length: nVars(m.corpo) }, (_, i) => limparParam(params[i]));
  const r = await sendTemplate(tenant, telefone, chave, ps);
  return !r?.erro;
}
/** Texto do modelo preenchido (para o histórico da conversa). */
export const textoModelo = (chave, params) => getModelo(chave)?.corpo.replace(/\{\{(\d+)\}\}/g, (_, n) => limparParam(params[Number(n) - 1])) || '';

// Avisos para a equipe: o telefone do gestor quase nunca está dentro das 24h, então usa o modelo quando aprovado.
export async function avisarEquipe(tenant, telefone, texto) {
  if (await enviarModelo(tenant, telefone, 'ava_alerta_equipe', [tenant.nome, texto])) return 'modelo';
  await sendText(tenant, telefone, texto);
  return 'texto';
}

// ---------- Meta: credenciais, envio para aprovação e status ----------
function credenciais(tenantId) {
  const n = db.prepare('SELECT * FROM whatsapp_numbers WHERE tenant_id = ? AND waba_id IS NOT NULL ORDER BY principal DESC, id LIMIT 1').get(tenantId);
  if (n) return { waba: n.waba_id, token: n.token };
  const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);
  return t?.wa_waba_id && (t.wa_token || process.env.WA_DEFAULT_TOKEN) ? { waba: t.wa_waba_id, token: t.wa_token || process.env.WA_DEFAULT_TOKEN } : null;
}
async function graph(path, token, opts = {}) {
  const res = await fetch(`${GRAPH}${path}`, { method: opts.method || 'GET', headers: { authorization: `Bearer ${token}`, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error?.error_user_msg || d.error?.message || `Meta ${res.status}`);
  return d;
}
export function componentes(m) {
  const c = [{ type: 'BODY', text: m.corpo, example: { body_text: [m.exemplo] } }];
  if (m.botoes?.length) c.push({ type: 'BUTTONS', buttons: m.botoes.map((text) => ({ type: 'QUICK_REPLY', text })) });
  return c;
}
const salvar = (tenantId, chave, campos) => db.prepare(`INSERT INTO tenant_templates (tenant_id, chave, status, categoria_meta, meta_id, motivo, atualizado_em)
  VALUES (?, ?, ?, ?, ?, ?, datetime('now')) ON CONFLICT(tenant_id, chave) DO UPDATE SET status = excluded.status,
  categoria_meta = COALESCE(excluded.categoria_meta, categoria_meta), meta_id = COALESCE(excluded.meta_id, meta_id), motivo = excluded.motivo, atualizado_em = datetime('now')`)
  .run(tenantId, chave, campos.status, campos.categoria || null, campos.id || null, campos.motivo || null);

/** Lê na Meta o status de todos os modelos da conta e atualiza a tabela. */
export async function sincronizarModelos(tenantId) {
  const cr = credenciais(tenantId);
  if (!cr) return { erro: 'Conecte o WhatsApp pelo botão da Meta (ou informe o WABA ID) para gerenciar os modelos.' };
  const d = await graph(`/${cr.waba}/message_templates?fields=name,status,category,rejected_reason,id&limit=250`, cr.token);
  const chaves = new Set(MODELOS.map((m) => m.chave));
  const upd = db.prepare("UPDATE modelos_proprios SET status = ?, categoria_meta = ?, meta_id = COALESCE(?, meta_id), motivo = ?, atualizado_em = datetime('now') WHERE tenant_id = ? AND nome = ?");
  for (const x of d.data || []) {
    const motivo = x.rejected_reason && x.rejected_reason !== 'NONE' ? x.rejected_reason : null;
    if (chaves.has(x.name)) salvar(tenantId, x.name, { status: x.status, categoria: x.category, id: x.id, motivo });
    else upd.run(x.status, x.category || null, x.id || null, motivo, tenantId, x.name);
  }
  return { ok: true };
}

/** Envia para aprovação os modelos que ainda não existem na conta (ou os escolhidos). */
export async function enviarParaAprovacao(tenantId, chaves = null) {
  const cr = credenciais(tenantId);
  if (!cr) return { erro: 'Conecte o WhatsApp pelo botão da Meta (ou informe o WABA ID) para enviar os modelos.' };
  await sincronizarModelos(tenantId).catch(() => {});
  const ja = new Set(db.prepare("SELECT chave FROM tenant_templates WHERE tenant_id = ? AND status NOT IN ('nao_enviado', 'erro')").all(tenantId).map((x) => x.chave));
  const lista = MODELOS.filter((m) => (chaves ? chaves.includes(m.chave) : true) && !ja.has(m.chave));
  const out = [];
  for (const m of lista) {
    try {
      const r = await graph(`/${cr.waba}/message_templates`, cr.token, { method: 'POST',
        body: { name: m.chave, language: 'pt_BR', category: m.categoria, allow_category_change: true, components: componentes(m) } });
      salvar(tenantId, m.chave, { status: r.status || 'PENDING', categoria: r.category, id: r.id });
      out.push({ chave: m.chave, status: r.status || 'PENDING' });
    } catch (e) {
      // Já existe com esse nome na conta: passa a acompanhar o status.
      if (/already exists|já existe|duplicate/i.test(e.message)) { salvar(tenantId, m.chave, { status: 'existente' }); out.push({ chave: m.chave, status: 'existente' }); continue; }
      salvar(tenantId, m.chave, { status: 'erro', motivo: e.message.slice(0, 300) });
      out.push({ chave: m.chave, status: 'erro', erro: e.message });
    }
  }
  await sincronizarModelos(tenantId).catch(() => {});
  return { enviados: out };
}

// ---------- Modelos criados pela própria empresa ----------
export function validarModeloProprio(b = {}) {
  const nome = String(b.nome || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,60}$/.test(nome)) return { erro: 'Nome: só letras minúsculas, números e _ (3 a 60 caracteres). Ex.: confirmacao_atendimento' };
  if (MODELOS.some((m) => m.chave === nome)) return { erro: 'Esse nome já é usado por um modelo padrão do sistema' };
  const categoria = String(b.categoria || '').toUpperCase();
  if (!['UTILITY', 'MARKETING'].includes(categoria)) return { erro: 'Escolha a categoria: Utilidade ou Marketing' };
  const corpo = String(b.corpo || '').trim();
  if (corpo.length < 10 || corpo.length > 1024) return { erro: 'O texto precisa ter entre 10 e 1024 caracteres' };
  if (/^\{\{|\}\}$/.test(corpo)) return { erro: 'O texto não pode começar nem terminar com uma variável {{n}}' };
  const nums = (corpo.match(/\{\{(\d+)\}\}/g) || []).map((v) => Number(v.replace(/\D/g, '')));
  const n = nums.length ? Math.max(...nums) : 0;
  for (let i = 1; i <= n; i++) if (!nums.includes(i)) return { erro: `As variáveis precisam ser sequenciais: falta {{${i}}}` };
  const exemplos = (Array.isArray(b.exemplos) ? b.exemplos : []).map((x) => String(x || '').trim()).slice(0, n);
  if (exemplos.length < n || exemplos.some((x) => !x)) return { erro: `Informe um exemplo para cada variável (${n})` };
  return { nome, categoria, corpo, exemplos, idioma: b.idioma || 'pt_BR' };
}
export async function criarModeloProprio(tenantId, b) {
  const cr = credenciais(tenantId);
  if (!cr) return { erro: 'Conecte o WhatsApp (com o WABA ID) para criar modelos.' };
  const v = validarModeloProprio(b);
  if (v.erro) return v;
  if (db.prepare('SELECT 1 FROM modelos_proprios WHERE tenant_id = ? AND nome = ?').get(tenantId, v.nome)) return { erro: 'Já existe um modelo seu com esse nome' };
  const components = [{ type: 'BODY', text: v.corpo, ...(v.exemplos.length ? { example: { body_text: [v.exemplos] } } : {}) }];
  const r = await graph(`/${cr.waba}/message_templates`, cr.token, { method: 'POST',
    body: { name: v.nome, language: v.idioma, category: v.categoria, components } });
  db.prepare('INSERT INTO modelos_proprios (tenant_id, nome, categoria, idioma, corpo, exemplos, status, categoria_meta, meta_id) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(tenantId, v.nome, v.categoria, v.idioma, v.corpo, JSON.stringify(v.exemplos), r.status || 'PENDING', r.category || null, r.id || null);
  return { ok: true, status: r.status || 'PENDING' };
}
export const listaProprios = (tenantId) => db.prepare('SELECT * FROM modelos_proprios WHERE tenant_id = ? ORDER BY id DESC').all(tenantId)
  .map((m) => ({ ...m, exemplos: JSON.parse(m.exemplos || '[]') }));

export function listaModelos(tenantId) {
  const st = Object.fromEntries(db.prepare('SELECT * FROM tenant_templates WHERE tenant_id = ?').all(tenantId).map((x) => [x.chave, x]));
  return MODELOS.map((m) => ({ ...m, variaveis: nVars(m.corpo), status: st[m.chave]?.status || 'nao_enviado', categoria_meta: st[m.chave]?.categoria_meta || null,
    motivo: st[m.chave]?.motivo || null, atualizado_em: st[m.chave]?.atualizado_em || null }));
}

// Status muda na Meta em minutos ou horas: confere as contas com modelos pendentes de tempos em tempos.
import { periodicas } from './ganchos.js';
let ultimaChecagem = 0;
periodicas.push(async () => {
  if (Date.now() - ultimaChecagem < 30 * 60e3) return;
  ultimaChecagem = Date.now();
  const ts = db.prepare("SELECT DISTINCT tenant_id FROM tenant_templates WHERE status = 'PENDING' UNION SELECT DISTINCT tenant_id FROM modelos_proprios WHERE status = 'PENDING'").all();
  for (const { tenant_id } of ts) await sincronizarModelos(tenant_id).catch((e) => console.error('[modelos]', e.message));
});

export function modelosRouter(canSee) {
  const r = express.Router();
  const ok = (req, res, acao) => {
    if (!canSee(req, req.params.id)) { res.sendStatus(403); return false; }
    if (acao && !pode(req.user, acao)) { res.status(403).json({ erro: 'Sem permissão' }); return false; }
    return true;
  };
  r.get('/tenants/:id/modelos', (req, res) => {
    if (!ok(req, res)) return;
    res.json({ modelos: listaModelos(Number(req.params.id)), proprios: listaProprios(Number(req.params.id)), conectado: !!credenciais(Number(req.params.id)) });
  });
  r.post('/tenants/:id/modelos/novo', async (req, res) => {
    if (!ok(req, res, 'configurar')) return;
    try { const r2 = await criarModeloProprio(Number(req.params.id), req.body || {}); if (r2.erro) return res.status(400).json(r2); res.status(201).json(r2); }
    catch (e) { res.status(502).json({ erro: e.message }); }
  });
  r.post('/tenants/:id/modelos/enviar', async (req, res) => {
    if (!ok(req, res, 'configurar')) return;
    try { const r2 = await enviarParaAprovacao(Number(req.params.id), Array.isArray(req.body?.chaves) ? req.body.chaves : null);
      if (r2.erro) return res.status(400).json(r2); res.json(r2); } catch (e) { res.status(502).json({ erro: e.message }); }
  });
  r.post('/tenants/:id/modelos/sincronizar', async (req, res) => {
    if (!ok(req, res)) return;
    try { const r2 = await sincronizarModelos(Number(req.params.id)); if (r2.erro) return res.status(400).json(r2);
      res.json({ modelos: listaModelos(Number(req.params.id)), proprios: listaProprios(Number(req.params.id)) }); } catch (e) { res.status(502).json({ erro: e.message }); }
  });
  return r;
}
