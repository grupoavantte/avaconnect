// Operação de atendimento: setores, fila e carteira; encerramento com pesquisa de satisfação e motivo;
// copiloto do atendente; campanhas (disparos com modelos aprovados na Meta).
import express from 'express';
import { db, logActivity } from './db.js';
import { sendText, sendTemplate } from './whatsapp.js';
import { avisarEquipe } from './modelos.js';
import { HANDLERS, aoConfirmarPagamento, periodicas } from './ganchos.js';
import { pode } from './auth.js';
import { efetivoDoContato } from './agents.js';
import { sugerirResposta, classificarConversa, MOTIVOS } from './ai.js';

// ---------- Estrutura ----------
const addCols = (tabela, cols) => {
  const tem = db.prepare(`PRAGMA table_info(${tabela})`).all().map((c) => c.name);
  for (const [c, d] of cols) if (!tem.includes(c)) db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${c} ${d}`);
};
addCols('tenants', [['setores', `TEXT NOT NULL DEFAULT '["Vendas","Suporte","Financeiro"]'`], ['pesquisa_ativa', 'INTEGER NOT NULL DEFAULT 1'],
  ['carteira_ativa', 'INTEGER NOT NULL DEFAULT 1'], ['encerrar_apos_h', 'INTEGER NOT NULL DEFAULT 23']]);
addCols('users', [['setores', 'TEXT'], // JSON; vazio = atende todos os setores
  ['ver_conversas', "TEXT NOT NULL DEFAULT 'todas'"], // todas | setor | minhas (definido pelo dono/gestor)
  ['ver_negocios', "TEXT NOT NULL DEFAULT 'todos'"]]); // todos | meus (CRM)
addCols('leads', [['responsavel_id', 'INTEGER']]);
addCols('contacts', [['responsavel_id', 'INTEGER'], ['optout', 'INTEGER NOT NULL DEFAULT 0'], ['pesquisa_conv_id', 'INTEGER'], ['pesquisa_em', 'TEXT']]);
addCols('conversations', [['setor', 'TEXT'], ['atendente_id', 'INTEGER'], ['motivo_atendimento', 'TEXT'], ['nota', 'INTEGER'],
  ['nota_comentario', 'TEXT'], ['encerrada_em', 'TEXT']]);
db.exec(`
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  modelo TEXT NOT NULL,                 -- nome do modelo aprovado na Meta
  idioma TEXT NOT NULL DEFAULT 'pt_BR',
  variaveis TEXT NOT NULL DEFAULT '[]', -- JSON: textos das variáveis {{1}}, {{2}}... aceita {nome} e {empresa}
  texto TEXT,                           -- como a mensagem aparece (fica no histórico para a IA continuar a conversa)
  filtro TEXT NOT NULL DEFAULT '{}',
  agendada_para TEXT,                   -- UTC
  status TEXT NOT NULL DEFAULT 'agendada', -- agendada | enviando | concluida | cancelada
  total INTEGER NOT NULL DEFAULT 0,
  criado_por TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  concluida_em TEXT
);
CREATE TABLE IF NOT EXISTS campaign_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pendente', -- pendente | enviado | falhou | ignorado
  erro TEXT,
  enviado_em TEXT,
  respondeu_em TEXT,
  comprou_valor REAL,
  UNIQUE(campaign_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_csend_contact ON campaign_sends(contact_id, enviado_em);
`);

const json = (s, d) => { try { return JSON.parse(s ?? '') ?? d; } catch { return d; } };
export const setoresDe = (t) => json(t.setores, []).filter(Boolean);
const getTenant = (id) => db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
const getContato = (id) => db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
const getConv = (id) => db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
const getUser = (id) => (id ? db.prepare('SELECT * FROM users WHERE id = ?').get(id) : null);
const primeiroNome = (c) => (c?.nome || '').trim().split(/\s+/)[0] || '';
const registrar = (convId, autor, conteudo) => {
  db.prepare('INSERT INTO messages (conversation_id, autor, conteudo) VALUES (?, ?, ?)').run(convId, autor, conteudo);
  db.prepare("UPDATE conversations SET ultima_mensagem_em = datetime('now') WHERE id = ?").run(convId);
};
const leadDo = (tenantId, contactId) => db.prepare('SELECT id FROM leads WHERE tenant_id = ? AND contact_id = ?').get(tenantId, contactId);
const horasDesde = (sql) => (sql ? (Date.now() - new Date(sql.replace(' ', 'T') + 'Z')) / 3600e3 : Infinity);

// ---------- Setores, fila e carteira ----------
const atendeSetor = (u, setor) => { const s = json(u.setores, []); return !setor || !s.length || s.includes(setor); };
const cargaDe = (userId) => db.prepare("SELECT COUNT(*) n FROM conversations WHERE atendente_id = ? AND status = 'humano'").get(userId).n;

/** Escolhe quem atende: o dono da carteira do cliente; senão, a pessoa do setor com menos conversas abertas. */
export function escolherAtendente(tenant, contact, setor) {
  const ativos = db.prepare('SELECT * FROM users WHERE tenant_id = ? AND ativo = 1').all(tenant.id);
  const dono = tenant.carteira_ativa && ativos.find((u) => u.id === contact.responsavel_id);
  if (dono && atendeSetor(dono, setor)) return dono;
  const doSetor = ativos.filter((u) => atendeSetor(u, setor));
  if (!doSetor.length) return null;
  return doSetor.map((u) => ({ u, n: cargaDe(u.id) })).sort((a, b) => a.n - b.n || a.u.id - b.u.id)[0].u;
}

/** Transferência feita pela IA (ou pelo sistema): coloca na fila do setor e avisa quem vai atender. */
export async function distribuir(tenant, conv, contact, { setor = null, motivo = '' } = {}) {
  const setores = setoresDe(tenant);
  const s = setores.find((x) => x.toLowerCase() === String(setor || '').toLowerCase()) || null;
  const u = escolherAtendente(tenant, contact, s);
  db.prepare("UPDATE conversations SET status = 'humano', setor = ?, atendente_id = ? WHERE id = ?").run(s, u?.id ?? null, conv.id);
  const quem = contact.nome || contact.telefone;
  const aviso = `AVA Connect: ${quem} precisa de atendimento${s ? ` (${s})` : ''}. Motivo: ${motivo}${u ? `\nAtendente: ${u.nome}` : ''}`;
  if (conv.canal === 'whatsapp') {
    const tel = u?.telefone || tenant.telefone_responsavel;
    if (tel) await avisarEquipe(tenant, tel, aviso);
  }
  return u;
}

export function assumir(conv, userId) {
  db.prepare("UPDATE conversations SET status = 'humano', atendente_id = ? WHERE id = ?").run(userId, conv.id);
  entrarNaCarteira(conv, userId);
}
/** Primeira pessoa que atende o cliente passa a ser a responsável por ele (carteira). */
export function entrarNaCarteira(conv, userId) {
  if (!userId) return;
  const t = getTenant(conv.tenant_id);
  if (t?.carteira_ativa) db.prepare('UPDATE contacts SET responsavel_id = ? WHERE id = ? AND responsavel_id IS NULL').run(userId, conv.contact_id);
}

// ---------- Quem vê quais conversas ----------
export const VISIBILIDADE = { todas: 'Todas as conversas', setor: 'Só dos seus setores e as suas', minhas: 'Só as suas (atribuídas ou da carteira)' };
const usuarioDe = (reqUser) => (reqUser?.userId && !reqUser.admin ? getUser(reqUser.userId) : null);
const regraDe = (u) => (!u || u.papel === 'dono' ? 'todas' : VISIBILIDADE[u.ver_conversas] ? u.ver_conversas : 'todas');
/** Trecho SQL para listas de conversas (aliases c = conversations, ct = contacts). */
export function filtroConversas(reqUser) {
  const u = usuarioDe(reqUser); const regra = regraDe(u);
  if (regra === 'todas') return { sql: '', args: [] };
  if (regra === 'minhas') return { sql: 'AND (c.atendente_id = ? OR ct.responsavel_id = ?)', args: [u.id, u.id] };
  const s = json(u.setores, []);
  return { sql: `AND (c.atendente_id = ? OR ct.responsavel_id = ? OR (c.setor IS NOT NULL${s.length ? ` AND c.setor IN (${s.map(() => '?').join(',')})` : ''}))`, args: [u.id, u.id, ...s] };
}
export function podeVerConversa(reqUser, conv) {
  const u = usuarioDe(reqUser); const regra = regraDe(u);
  if (regra === 'todas') return true;
  const ct = getContato(conv.contact_id);
  if (conv.atendente_id === u.id || ct?.responsavel_id === u.id) return true;
  if (regra === 'minhas') return false;
  const s = json(u.setores, []);
  return !!conv.setor && (!s.length || s.includes(conv.setor));
}

// CRM: "meus negócios" = leads em que a pessoa é a responsável ou cujo cliente está na carteira dela.
export const VISIBILIDADE_NEGOCIOS = { todos: 'Todos os negócios', meus: 'Só os negócios dela' };
const soMeus = (reqUser) => { const u = usuarioDe(reqUser); return u && u.papel !== 'dono' && u.ver_negocios === 'meus' ? u : null; };
/** Trecho SQL para listas de leads (aliases l = leads, ct = contacts). */
export function filtroLeads(reqUser) {
  const u = soMeus(reqUser);
  return u ? { sql: 'AND (l.responsavel_id = ? OR ct.responsavel_id = ?)', args: [u.id, u.id], userId: u.id } : { sql: '', args: [], userId: null };
}
export function podeVerLead(reqUser, lead) {
  const u = soMeus(reqUser); if (!u) return true;
  return lead.responsavel_id === u.id || getContato(lead.contact_id)?.responsavel_id === u.id;
}

// ---------- Encerramento, motivo e pesquisa de satisfação ----------
const TEXTO_PESQUISA = 'Antes de você ir: de *1 a 5*, que nota você dá para o nosso atendimento? (5 = excelente). É só responder com o número 🙂';

export async function encerrar(conv, { pesquisa = true } = {}) {
  conv = getConv(conv.id);
  if (!conv || conv.status === 'encerrada') return { ja: true };
  const tenant = getTenant(conv.tenant_id);
  const contact = getContato(conv.contact_id);
  db.prepare("UPDATE conversations SET status = 'encerrada', encerrada_em = datetime('now') WHERE id = ?").run(conv.id);
  const hist = db.prepare('SELECT autor, conteudo FROM messages WHERE conversation_id = ? ORDER BY id').all(conv.id);
  const doCliente = hist.filter((m) => m.autor === 'cliente');
  // Motivo: compra/orçamento pelos registros; o resto pela leitura da conversa.
  const comprou = db.prepare("SELECT 1 FROM charges WHERE contact_id = ? AND status = 'pago' AND COALESCE(pago_em, criado_em) >= ?").get(contact.id, conv.iniciada_em);
  const proposta = db.prepare('SELECT 1 FROM proposals WHERE contact_id = ? AND criado_em >= ?').get(contact.id, conv.iniciada_em);
  const pedido = db.prepare('SELECT 1 FROM orders WHERE contact_id = ? AND criado_em >= ?').get(contact.id, conv.iniciada_em);
  const motivo = doCliente.length ? (comprou ? 'compra' : proposta || pedido ? 'orçamento' : await classificarConversa(tenant, hist)) : 'outro';
  db.prepare('UPDATE conversations SET motivo_atendimento = ? WHERE id = ?').run(motivo, conv.id);
  // Pesquisa só para quem conversou de verdade e ainda está na janela de 24h do WhatsApp.
  const ultimaCliente = db.prepare("SELECT MAX(criado_em) t FROM messages WHERE conversation_id = ? AND autor = 'cliente'").get(conv.id).t;
  const enviar = pesquisa && tenant.pesquisa_ativa && doCliente.length >= 2 && horasDesde(ultimaCliente) < 23.5 && !contact.optout;
  if (enviar) {
    const t = efetivoDoContato(tenant, contact.id);
    if (conv.canal === 'whatsapp') await sendText(t, contact.telefone, TEXTO_PESQUISA);
    registrar(conv.id, 'ia', TEXTO_PESQUISA);
    db.prepare("UPDATE conversations SET status = 'encerrada' WHERE id = ?").run(conv.id);
    db.prepare("UPDATE contacts SET pesquisa_conv_id = ?, pesquisa_em = datetime('now') WHERE id = ?").run(conv.id, contact.id);
  }
  return { motivo, pesquisa: !!enviar };
}

/**
 * Chamado pelo motor antes de abrir a conversa: nota da pesquisa, "SAIR" das campanhas e resposta a campanhas.
 * Devolve { resposta } quando a mensagem já foi tratada aqui.
 */
export async function antesDeAtender(tenant, contact, texto, canal) {
  const t = String(texto || '').trim();
  db.prepare(`UPDATE campaign_sends SET respondeu_em = datetime('now') WHERE contact_id = ? AND respondeu_em IS NULL
    AND status = 'enviado' AND enviado_em > datetime('now', '-3 days')`).run(contact.id);
  if (/^(sair|parar|stop|descadastrar|cancelar campanhas?)[.!\s]*$/i.test(t)) {
    db.prepare('UPDATE contacts SET optout = 1 WHERE id = ?').run(contact.id);
    return { resposta: 'Pronto, você não vai mais receber nossas mensagens de campanha. Se precisar de algo, é só chamar aqui. 👍', tratada: true };
  }
  if (!contact.pesquisa_conv_id || horasDesde(contact.pesquisa_em) > 24) return null;
  const m = t.match(/^\s*(?:nota\s*)?([1-5])\b\s*[,.!\-–]?\s*(.*)$/is) || (/^⭐{1,5}$/.test(t.replace(/\s|️/g, '')) ? [null, String([...t.replace(/\s|️/g, '')].length), ''] : null);
  const convId = contact.pesquisa_conv_id;
  db.prepare('UPDATE contacts SET pesquisa_conv_id = NULL, pesquisa_em = NULL WHERE id = ?').run(contact.id);
  if (!m) return null; // respondeu outra coisa: segue o atendimento normal
  const nota = Number(m[1]); const comentario = (m[2] || '').trim() || null;
  db.prepare('UPDATE conversations SET nota = ?, nota_comentario = ? WHERE id = ?').run(nota, comentario, convId);
  registrar(convId, 'cliente', t);
  const lead = leadDo(tenant.id, contact.id);
  if (nota <= 3) {
    const aviso = `Avaliação ${nota}/5 de ${contact.nome || contact.telefone}${comentario ? `: "${comentario}"` : ''}. Vale um contato para entender o que faltou.`;
    if (lead) logActivity(tenant.id, lead.id, aviso, { tipo: 'tarefa', autor: 'sistema', vence_em: new Date().toISOString().slice(0, 10) });
    const conv = getConv(convId); const resp = getUser(conv?.atendente_id) || getUser(contact.responsavel_id);
    const tel = resp?.telefone || tenant.telefone_responsavel;
    if (tel && canal === 'whatsapp') await avisarEquipe(tenant, tel, `AVA Connect · ${tenant.nome}\n${aviso}`);
  } else if (lead) logActivity(tenant.id, lead.id, `Avaliou o atendimento com nota ${nota}/5${comentario ? `: "${comentario}"` : ''}`, { autor: 'sistema' });
  const resposta = nota >= 4 ? 'Obrigado pela avaliação! 💙 Ficamos felizes em ajudar.' : 'Obrigado pela sinceridade. Vou passar para a equipe e alguém vai falar com você para melhorar isso.';
  registrar(convId, 'ia', resposta);
  return { resposta, tratada: true, conversation_id: convId };
}

// Conversas da IA paradas há horas são encerradas sozinhas (classifica o motivo e manda a pesquisa).
let ultimaVarredura = 0;
periodicas.push(async () => {
  if (Date.now() - ultimaVarredura < 5 * 60e3 && !process.env.VARREDURA_SEMPRE) return;
  ultimaVarredura = Date.now();
  const paradas = db.prepare(`SELECT c.* FROM conversations c JOIN tenants t ON t.id = c.tenant_id
    WHERE c.status = 'ia' AND c.canal = 'whatsapp' AND c.ultima_mensagem_em < datetime('now', '-' || t.encerrar_apos_h || ' hours') LIMIT 50`).all();
  for (const c of paradas) await encerrar(c).catch((e) => console.error('[encerrar]', e.message));
});

// ---------- Campanhas ----------
const soDigitos = (s) => String(s || '').replace(/\D/g, '');
/** Contatos que recebem a campanha, conforme o filtro. */
export function publico(tenantId, f = {}) {
  const where = ['ct.tenant_id = ?', 'ct.optout = 0'];
  const args = [tenantId];
  if (f.etapas?.length) { where.push(`l.etapa IN (${f.etapas.map(() => '?').join(',')})`); args.push(...f.etapas); }
  if (f.tag) { where.push("COALESCE(l.tags, '') LIKE ?"); args.push(`%${f.tag}%`); }
  if (f.compradores === 'sim') where.push("EXISTS (SELECT 1 FROM charges ch WHERE ch.contact_id = ct.id AND ch.status = 'pago')");
  if (f.compradores === 'nao') where.push("NOT EXISTS (SELECT 1 FROM charges ch WHERE ch.contact_id = ct.id AND ch.status = 'pago')");
  const ult = "(SELECT MAX(m.criado_em) FROM messages m JOIN conversations cv ON cv.id = m.conversation_id WHERE cv.contact_id = ct.id)";
  if (Number(f.sem_contato_dias) > 0) { where.push(`${ult} < datetime('now', ?)`); args.push(`-${Number(f.sem_contato_dias)} days`); }
  if (Number(f.com_contato_dias) > 0) { where.push(`${ult} >= datetime('now', ?)`); args.push(`-${Number(f.com_contato_dias)} days`); }
  return db.prepare(`SELECT ct.id, ct.nome, ct.telefone FROM contacts ct LEFT JOIN leads l ON l.contact_id = ct.id AND l.tenant_id = ct.tenant_id
    WHERE ${where.join(' AND ')} ORDER BY ct.id`).all(...args).filter((c) => soDigitos(c.telefone).length >= 10);
}

const preencher = (s, contact, tenant) => String(s || '').replace(/\{nome\}/gi, primeiroNome(contact) || 'cliente').replace(/\{empresa\}/gi, tenant.nome);
const LOTE = () => Math.max(1, Number(process.env.CAMPANHA_LOTE) || 40);
const agendarLote = (campaignId, quando) => db.prepare("INSERT INTO jobs (tipo, payload, executar_em) VALUES ('campanha_lote', ?, ?)")
  .run(JSON.stringify({ campaign_id: campaignId }), quando);

HANDLERS.campanha_lote = async ({ campaign_id }) => {
  const cp = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaign_id);
  if (!cp || !['agendada', 'enviando'].includes(cp.status)) return 'campanha não está ativa';
  const tenant = getTenant(cp.tenant_id);
  if (!tenant || tenant.status !== 'ativo') return 'empresa inativa';
  if (cp.status === 'agendada') {
    const alvo = publico(tenant.id, json(cp.filtro, {}));
    const ins = db.prepare('INSERT OR IGNORE INTO campaign_sends (campaign_id, contact_id) VALUES (?, ?)');
    for (const c of alvo) ins.run(cp.id, c.id);
    db.prepare("UPDATE campaigns SET status = 'enviando', total = ? WHERE id = ?").run(alvo.length, cp.id);
  }
  const vars = json(cp.variaveis, []);
  const fila = db.prepare("SELECT * FROM campaign_sends WHERE campaign_id = ? AND status = 'pendente' ORDER BY id LIMIT ?").all(cp.id, LOTE());
  for (const s of fila) {
    const contact = getContato(s.contact_id);
    if (!contact || contact.optout) { db.prepare("UPDATE campaign_sends SET status = 'ignorado' WHERE id = ?").run(s.id); continue; }
    const t = efetivoDoContato(tenant, contact.id);
    const r = await sendTemplate(t, contact.telefone, cp.modelo, vars.map((v) => preencher(v, contact, tenant)), cp.idioma);
    if (r?.erro) {
      const erro = typeof r.erro === 'string' ? r.erro : r.erro?.error?.message || 'Erro da Meta';
      db.prepare("UPDATE campaign_sends SET status = 'falhou', erro = ? WHERE id = ?").run(erro.slice(0, 300), s.id);
      continue;
    }
    db.prepare("UPDATE campaign_sends SET status = 'enviado', enviado_em = datetime('now') WHERE id = ?").run(s.id);
    // Fica no histórico do cliente: quando ele responder, a IA sabe do que se trata.
    let conv = db.prepare("SELECT * FROM conversations WHERE contact_id = ? AND status != 'encerrada' AND ultima_mensagem_em > datetime('now', '-24 hours') ORDER BY id DESC LIMIT 1").get(contact.id);
    if (!conv) conv = { id: db.prepare("INSERT INTO conversations (tenant_id, contact_id, canal) VALUES (?, ?, 'whatsapp')").run(tenant.id, contact.id).lastInsertRowid };
    registrar(conv.id, 'ia', `📣 Campanha "${cp.nome}": ${preencher(cp.texto || `(modelo ${cp.modelo})`, contact, tenant)}`);
    const lead = leadDo(tenant.id, contact.id);
    if (lead) logActivity(tenant.id, lead.id, `Recebeu a campanha "${cp.nome}"`, { autor: 'sistema' });
  }
  const resta = db.prepare("SELECT COUNT(*) n FROM campaign_sends WHERE campaign_id = ? AND status = 'pendente'").get(cp.id).n;
  if (resta) { agendarLote(cp.id, new Date(Date.now() + 60e3).toISOString().slice(0, 19).replace('T', ' ')); return `lote enviado; faltam ${resta}`; }
  db.prepare("UPDATE campaigns SET status = 'concluida', concluida_em = datetime('now') WHERE id = ?").run(cp.id);
  return 'concluída';
};

// Venda paga até 7 dias depois da campanha conta como resultado da campanha.
aoConfirmarPagamento.push(async (charge) => {
  db.prepare(`UPDATE campaign_sends SET comprou_valor = COALESCE(comprou_valor, 0) + ? WHERE id = (
    SELECT id FROM campaign_sends WHERE contact_id = ? AND status = 'enviado' AND enviado_em > datetime('now', '-7 days') ORDER BY enviado_em DESC LIMIT 1)`)
    .run(Number(charge.valor) || 0, charge.contact_id);
});

const resumoCampanha = (cp) => ({ ...cp, variaveis: json(cp.variaveis, []), filtro: json(cp.filtro, {}),
  ...db.prepare(`SELECT SUM(status = 'enviado') enviados, SUM(status = 'falhou') falhas, SUM(status = 'pendente') pendentes,
    SUM(respondeu_em IS NOT NULL) responderam, SUM(comprou_valor IS NOT NULL) compraram, COALESCE(SUM(comprou_valor), 0) vendido
    FROM campaign_sends WHERE campaign_id = ?`).get(cp.id),
  erros: db.prepare("SELECT erro, COUNT(*) n FROM campaign_sends WHERE campaign_id = ? AND status = 'falhou' GROUP BY erro LIMIT 3").all(cp.id) });

// ---------- API ----------
export function operacaoRouter(canSee) {
  const r = express.Router();
  const conv = (req, res) => {
    const c = getConv(req.params.id);
    if (!c) { res.sendStatus(404); return null; }
    if (!canSee(req, c.tenant_id) || !podeVerConversa(req.user, c)) { res.sendStatus(403); return null; }
    return c;
  };
  const tenantOk = (req, res, acao) => {
    if (!canSee(req, req.params.id)) { res.sendStatus(403); return null; }
    if (acao && !pode(req.user, acao)) { res.status(403).json({ erro: 'Sem permissão' }); return null; }
    return getTenant(req.params.id);
  };

  r.post('/conversations/:id/assumir', (req, res) => {
    const c = conv(req, res); if (!c) return;
    if (!pode(req.user, 'atender')) return res.sendStatus(403);
    assumir(c, req.user.userId || null);
    res.json({ ok: true });
  });
  r.post('/conversations/:id/transferir', async (req, res) => {
    const c = conv(req, res); if (!c) return;
    if (!pode(req.user, 'atender')) return res.sendStatus(403);
    const t = getTenant(c.tenant_id); const b = req.body || {};
    const u = b.atendente_id ? db.prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ? AND ativo = 1').get(b.atendente_id, t.id) : null;
    if (b.atendente_id && !u) return res.status(400).json({ erro: 'Atendente inválido' });
    const setor = b.setor ? setoresDe(t).find((s) => s === b.setor) : null;
    if (b.setor && !setor) return res.status(400).json({ erro: 'Setor inválido' });
    const contact = getContato(c.contact_id);
    const destino = u || escolherAtendente(t, { ...contact, responsavel_id: null }, setor);
    db.prepare("UPDATE conversations SET status = 'humano', setor = COALESCE(?, setor), atendente_id = ? WHERE id = ?").run(setor, destino?.id ?? null, c.id);
    registrar(c.id, 'sistema', `Transferida${setor ? ` para ${setor}` : ''}${destino ? ` · ${destino.nome}` : ' (fila)'}${b.nota ? `: ${b.nota}` : ''}`);
    if (destino?.telefone && c.canal === 'whatsapp' && destino.id !== req.user.userId)
      await avisarEquipe(t, destino.telefone, `AVA Connect: conversa com ${contact.nome || contact.telefone} transferida para você${b.nota ? `. Obs.: ${b.nota}` : ''}`);
    res.json({ ok: true, atendente: destino ? { id: destino.id, nome: destino.nome } : null });
  });
  r.post('/conversations/:id/encerrar', async (req, res) => {
    const c = conv(req, res); if (!c) return;
    if (!pode(req.user, 'atender')) return res.sendStatus(403);
    res.json(await encerrar(c, { pesquisa: req.body?.pesquisa !== false }));
  });
  r.post('/conversations/:id/sugestao', async (req, res) => {
    const c = conv(req, res); if (!c) return;
    if (!pode(req.user, 'atender')) return res.sendStatus(403);
    const t = efetivoDoContato(getTenant(c.tenant_id), c.contact_id);
    const hist = db.prepare("SELECT autor, conteudo FROM messages WHERE conversation_id = ? AND autor != 'sistema' ORDER BY id").all(c.id).slice(-30);
    try { res.json({ texto: (await sugerirResposta(t, hist)) || '' }); }
    catch (e) { res.status(502).json({ erro: 'Não consegui sugerir agora. Tente de novo.' }); }
  });

  // Configuração do atendimento.
  r.get('/tenants/:id/atendimento', (req, res) => {
    const t = tenantOk(req, res); if (!t) return;
    const users = db.prepare('SELECT id, nome, papel, setores, telefone FROM users WHERE tenant_id = ? AND ativo = 1 ORDER BY nome').all(t.id)
      .map((u) => ({ ...u, setores: json(u.setores, []), abertas: cargaDe(u.id) }));
    const st = db.prepare(`SELECT ROUND(AVG(nota), 1) media, COUNT(nota) avaliacoes, SUM(nota >= 4) boas FROM conversations
      WHERE tenant_id = ? AND nota IS NOT NULL AND encerrada_em > datetime('now', '-30 days')`).get(t.id);
    const motivos = db.prepare(`SELECT motivo_atendimento motivo, COUNT(*) n FROM conversations WHERE tenant_id = ? AND motivo_atendimento IS NOT NULL
      AND encerrada_em > datetime('now', '-30 days') GROUP BY motivo_atendimento ORDER BY n DESC`).all(t.id);
    const fila = db.prepare("SELECT COUNT(*) n FROM conversations WHERE tenant_id = ? AND status = 'humano' AND atendente_id IS NULL").get(t.id).n;
    res.json({ setores: setoresDe(t), pesquisa_ativa: t.pesquisa_ativa, carteira_ativa: t.carteira_ativa, encerrar_apos_h: t.encerrar_apos_h,
      users, satisfacao: st, motivos, fila, motivos_possiveis: MOTIVOS });
  });
  r.put('/tenants/:id/atendimento', (req, res) => {
    const t = tenantOk(req, res, 'configurar'); if (!t) return;
    const b = req.body || {};
    const setores = Array.isArray(b.setores) ? [...new Set(b.setores.map((s) => String(s).trim()).filter(Boolean))].slice(0, 12) : setoresDe(t);
    const h = b.encerrar_apos_h === undefined ? t.encerrar_apos_h : Math.max(1, Math.min(23, Number(b.encerrar_apos_h) || 23));
    db.prepare('UPDATE tenants SET setores = ?, pesquisa_ativa = ?, carteira_ativa = ?, encerrar_apos_h = ? WHERE id = ?')
      .run(JSON.stringify(setores), b.pesquisa_ativa === undefined ? t.pesquisa_ativa : Number(!!b.pesquisa_ativa),
        b.carteira_ativa === undefined ? t.carteira_ativa : Number(!!b.carteira_ativa), h, t.id);
    res.json({ ok: true, setores });
  });
  r.put('/users/:id/setores', (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!u?.tenant_id || !canSee(req, u.tenant_id) || !pode(req.user, 'configurar')) return res.sendStatus(403);
    const validos = setoresDe(getTenant(u.tenant_id));
    const s = (Array.isArray(req.body?.setores) ? req.body.setores : []).filter((x) => validos.includes(x));
    db.prepare('UPDATE users SET setores = ? WHERE id = ?').run(s.length ? JSON.stringify(s) : null, u.id);
    res.json({ ok: true, setores: s });
  });
  r.put('/users/:id/visibilidade', (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!u?.tenant_id || !canSee(req, u.tenant_id) || !pode(req.user, 'configurar')) return res.status(403).json({ erro: 'Só dono ou gestor define o que cada pessoa vê' });
    const v = String(req.body?.ver_conversas || '');
    if (!VISIBILIDADE[v]) return res.status(400).json({ erro: 'Opção inválida' });
    if (u.papel === 'dono' && v !== 'todas') return res.status(400).json({ erro: 'O dono sempre vê todas as conversas' });
    db.prepare('UPDATE users SET ver_conversas = ? WHERE id = ?').run(v, u.id);
    res.json({ ok: true, ver_conversas: v });
  });
  r.put('/users/:id/negocios', (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!u?.tenant_id || !canSee(req, u.tenant_id) || !pode(req.user, 'configurar')) return res.status(403).json({ erro: 'Só dono ou gestor define o que cada pessoa vê' });
    const v = String(req.body?.ver_negocios || '');
    if (!VISIBILIDADE_NEGOCIOS[v]) return res.status(400).json({ erro: 'Opção inválida' });
    if (u.papel === 'dono' && v !== 'todos') return res.status(400).json({ erro: 'O dono sempre vê todos os negócios' });
    db.prepare('UPDATE users SET ver_negocios = ? WHERE id = ?').run(v, u.id);
    res.json({ ok: true, ver_negocios: v });
  });
  r.put('/contacts/:id/responsavel', (req, res) => {
    const ct = getContato(req.params.id);
    if (!ct || !canSee(req, ct.tenant_id) || !pode(req.user, 'atender')) return res.sendStatus(403);
    const uid = req.body?.responsavel_id ? Number(req.body.responsavel_id) : null;
    if (uid && !db.prepare('SELECT 1 FROM users WHERE id = ? AND tenant_id = ?').get(uid, ct.tenant_id)) return res.status(400).json({ erro: 'Usuário inválido' });
    db.prepare('UPDATE contacts SET responsavel_id = ? WHERE id = ?').run(uid, ct.id);
    res.json({ ok: true });
  });

  // Campanhas.
  r.get('/tenants/:id/campanhas', (req, res) => {
    const t = tenantOk(req, res); if (!t) return;
    res.json(db.prepare('SELECT * FROM campaigns WHERE tenant_id = ? ORDER BY id DESC LIMIT 100').all(t.id).map(resumoCampanha));
  });
  r.post('/tenants/:id/campanhas/publico', (req, res) => {
    const t = tenantOk(req, res); if (!t) return;
    const p = publico(t.id, req.body?.filtro || {});
    res.json({ total: p.length, amostra: p.slice(0, 8).map((c) => c.nome || c.telefone),
      optout: db.prepare('SELECT COUNT(*) n FROM contacts WHERE tenant_id = ? AND optout = 1').get(t.id).n });
  });
  r.post('/tenants/:id/campanhas', (req, res) => {
    const t = tenantOk(req, res, 'configurar'); if (!t) return;
    const b = req.body || {};
    const nome = String(b.nome || '').trim(); const modelo = String(b.modelo || '').trim();
    if (!nome) return res.status(400).json({ erro: 'Dê um nome à campanha' });
    if (!/^[a-z0-9_]{1,512}$/.test(modelo)) return res.status(400).json({ erro: 'Informe o nome do modelo exatamente como aprovado na Meta (letras minúsculas, números e _)' });
    const variaveis = (Array.isArray(b.variaveis) ? b.variaveis : []).map((v) => String(v)).slice(0, 10);
    if (variaveis.some((v) => !v.trim())) return res.status(400).json({ erro: 'Preencha todas as variáveis do modelo ou remova as vazias' });
    const filtro = b.filtro || {};
    const total = publico(t.id, filtro).length;
    if (!total) return res.status(400).json({ erro: 'Nenhum contato neste público' });
    let quando = new Date();
    if (b.agendar_para) { quando = new Date(`${b.agendar_para}:00-03:00`); if (isNaN(quando)) return res.status(400).json({ erro: 'Data inválida' }); }
    const q = quando.toISOString().slice(0, 19).replace('T', ' ');
    const id = db.prepare(`INSERT INTO campaigns (tenant_id, nome, modelo, idioma, variaveis, texto, filtro, agendada_para, total, criado_por) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(t.id, nome, modelo, String(b.idioma || 'pt_BR'), JSON.stringify(variaveis), String(b.texto || '').slice(0, 1000) || null,
        JSON.stringify(filtro), q, total, req.user.nome || null).lastInsertRowid;
    agendarLote(id, q);
    res.status(201).json(resumoCampanha(db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id)));
  });
  r.post('/campanhas/:cid/cancelar', (req, res) => {
    const cp = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.cid);
    if (!cp || !canSee(req, cp.tenant_id) || !pode(req.user, 'configurar')) return res.sendStatus(403);
    if (!['agendada', 'enviando'].includes(cp.status)) return res.status(400).json({ erro: 'A campanha já terminou' });
    db.prepare("UPDATE campaigns SET status = 'cancelada' WHERE id = ?").run(cp.id);
    db.prepare("UPDATE campaign_sends SET status = 'ignorado' WHERE campaign_id = ? AND status = 'pendente'").run(cp.id);
    res.json({ ok: true });
  });
  return r;
}
