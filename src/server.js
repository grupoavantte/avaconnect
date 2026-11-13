import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, newToken, getUsage, currentMonth, publicTenant } from './db.js';
import { PLANS, getPlan } from './plans.js';
import { handleIncoming, humanReply } from './engine.js';
import { parseWebhook, validSignature } from './whatsapp.js';
import { AI_MODE } from './ai.js';
import { crmRouter } from './crm.js';
import { BRAND } from './brand-assets.js';

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'troque-este-token';
if (!process.env.ADMIN_TOKEN) console.warn('[aviso] ADMIN_TOKEN não definido — usando token padrão de desenvolvimento.');

app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.get('/brand/:file', (req, res) => {
  const data = BRAND[req.params.file];
  if (!data) return res.sendStatus(404);
  res.type(req.params.file.split('.').pop()).set('cache-control', 'public, max-age=86400').send(Buffer.from(data, 'base64'));
});
app.use(express.static(path.resolve('public')));

app.get('/health', (_req, res) => res.json({ ok: true, ia: AI_MODE }));

// ---------------- Webhook WhatsApp ----------------
app.get('/webhooks/whatsapp', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.WA_VERIFY_TOKEN) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

app.post('/webhooks/whatsapp', (req, res) => {
  if (!validSignature(req.rawBody || Buffer.from(''), req.get('x-hub-signature-256'))) return res.sendStatus(401);
  res.sendStatus(200); // responde rápido; processa em seguida
  for (const m of parseWebhook(req.body)) {
    const tenant = db.prepare('SELECT * FROM tenants WHERE wa_phone_number_id = ?').get(m.phoneNumberId);
    if (!tenant) { console.warn('[webhook] número sem empresa:', m.phoneNumberId); continue; }
    handleIncoming(tenant, { telefone: m.from, nome: m.nome, texto: m.texto, waId: m.waId, canal: 'whatsapp' })
      .catch((e) => console.error('[webhook] erro', e));
  }
});

// ---------------- Autenticação do painel ----------------
// Token de admin (Avantte) vê todas as empresas; token de painel vê só a própria empresa.
function auth(req, res, next) {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (token && token.length === ADMIN_TOKEN.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN))) {
    req.user = { admin: true };
    return next();
  }
  const t = token && db.prepare('SELECT id, nome FROM tenants WHERE painel_token = ?').get(token);
  if (t) { req.user = { admin: false, tenantId: t.id, nome: t.nome }; return next(); }
  res.status(401).json({ erro: 'Token inválido' });
}
const adminOnly = (req, res, next) => (req.user.admin ? next() : res.status(403).json({ erro: 'Apenas administrador' }));
const canSee = (req, tenantId) => req.user.admin || req.user.tenantId === Number(tenantId);

const api = express.Router();
api.use(auth);

api.get('/me', (req, res) => res.json({ ...req.user, ia: AI_MODE }));
api.get('/plans', (_req, res) => res.json(Object.values(PLANS)));

api.get('/overview', (req, res) => {
  const where = req.user.admin ? '' : 'WHERE t.id = ' + Number(req.user.tenantId);
  const tenants = db.prepare(`SELECT t.* FROM tenants t ${where}`).all();
  const ativos = tenants.filter((t) => t.status === 'ativo');
  const mes = currentMonth();
  const ids = tenants.map((t) => t.id).join(',') || '0';
  const uso = db.prepare(`SELECT COALESCE(SUM(conversas),0) c, COALESCE(SUM(mensagens_ia),0) m FROM usage WHERE mes = ? AND tenant_id IN (${ids})`).get(mes);
  const leads = db.prepare(`SELECT etapa, COUNT(*) n, COALESCE(SUM(valor_estimado),0) v FROM leads WHERE tenant_id IN (${ids}) GROUP BY etapa`).all();
  const humanos = db.prepare(`SELECT COUNT(*) n FROM conversations WHERE status = 'humano' AND tenant_id IN (${ids})`).get().n;
  res.json({
    empresas_ativas: ativos.length,
    mrr: req.user.admin ? ativos.reduce((s, t) => s + getPlan(t.plano).preco_mensal, 0) : undefined,
    conversas_mes: uso.c,
    mensagens_ia_mes: uso.m,
    aguardando_humano: humanos,
    leads,
  });
});

// Empresas
api.get('/tenants', (req, res) => {
  const rows = req.user.admin
    ? db.prepare('SELECT * FROM tenants ORDER BY id DESC').all()
    : db.prepare('SELECT * FROM tenants WHERE id = ?').all(req.user.tenantId);
  res.json(rows.map((t) => ({ ...publicTenant(t), uso: getUsage(t.id), limite: getPlan(t.plano).conversas_mes })));
});

const EDITABLE = ['nome', 'plano', 'status', 'nome_assistente', 'persona', 'base_conhecimento', 'horario_atendimento',
  'telefone_responsavel', 'wa_phone_number_id', 'wa_token'];
const ADMIN_FIELDS = ['plano', 'status', 'wa_phone_number_id', 'wa_token'];

function validateTenant(body, plano) {
  if (body.plano && !PLANS[body.plano]) return 'Plano inválido';
  if (body.status && !['ativo', 'pausado', 'cancelado'].includes(body.status)) return 'Status inválido';
  if (body.base_conhecimento && body.base_conhecimento.length > getPlan(body.plano || plano).limite_base_conhecimento)
    return `Base de conhecimento acima do limite do plano (${getPlan(body.plano || plano).limite_base_conhecimento} caracteres)`;
  return null;
}

api.post('/tenants', adminOnly, (req, res) => {
  const b = req.body || {};
  if (!b.nome) return res.status(400).json({ erro: 'Nome obrigatório' });
  const erro = validateTenant(b, b.plano); if (erro) return res.status(400).json({ erro });
  const fields = EDITABLE.filter((f) => b[f] !== undefined && b[f] !== '');
  const r = db.prepare(`INSERT INTO tenants (${[...fields, 'painel_token'].join(',')}) VALUES (${[...fields, 'x'].map(() => '?').join(',')})`)
    .run(...fields.map((f) => b[f]), newToken());
  res.status(201).json(publicTenant(db.prepare('SELECT * FROM tenants WHERE id = ?').get(r.lastInsertRowid), { withSecrets: true }));
});

api.get('/tenants/:id', (req, res) => {
  if (!canSee(req, req.params.id)) return res.sendStatus(403);
  const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
  if (!t) return res.sendStatus(404);
  res.json({ ...publicTenant(t, { withSecrets: req.user.admin }), uso: getUsage(t.id), plano_info: getPlan(t.plano) });
});

api.put('/tenants/:id', (req, res) => {
  if (!canSee(req, req.params.id)) return res.sendStatus(403);
  const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
  if (!t) return res.sendStatus(404);
  const b = req.body || {};
  const allowed = EDITABLE.filter((f) => b[f] !== undefined && (req.user.admin || !ADMIN_FIELDS.includes(f)));
  const erro = validateTenant(b, t.plano); if (erro) return res.status(400).json({ erro });
  if (allowed.length) {
    db.prepare(`UPDATE tenants SET ${allowed.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`)
      .run(...allowed.map((f) => (b[f] === '' ? null : b[f])), t.id);
  }
  res.json(publicTenant(db.prepare('SELECT * FROM tenants WHERE id = ?').get(t.id), { withSecrets: req.user.admin }));
});

api.post('/tenants/:id/rotate-token', adminOnly, (req, res) => {
  db.prepare('UPDATE tenants SET painel_token = ? WHERE id = ?').run(newToken(), req.params.id);
  res.json(publicTenant(db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id), { withSecrets: true }));
});

// Conversas
api.get('/tenants/:id/conversations', (req, res) => {
  if (!canSee(req, req.params.id)) return res.sendStatus(403);
  const status = req.query.status;
  const rows = db.prepare(`SELECT c.*, ct.nome contato_nome, ct.telefone,
      (SELECT conteudo FROM messages m WHERE m.conversation_id = c.id ORDER BY id DESC LIMIT 1) ultima_mensagem
    FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
    WHERE c.tenant_id = ? ${status ? 'AND c.status = ?' : ''}
    ORDER BY c.ultima_mensagem_em DESC, c.id DESC LIMIT 200`).all(...[req.params.id, status].filter(Boolean));
  res.json(rows);
});

function loadConv(req, res) {
  const c = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!c) { res.sendStatus(404); return null; }
  if (!canSee(req, c.tenant_id)) { res.sendStatus(403); return null; }
  return c;
}

api.get('/conversations/:id', (req, res) => {
  const c = loadConv(req, res); if (!c) return;
  const contato = db.prepare('SELECT * FROM contacts WHERE id = ?').get(c.contact_id);
  const mensagens = db.prepare('SELECT id, autor, conteudo, criado_em FROM messages WHERE conversation_id = ? ORDER BY id').all(c.id);
  const lead = db.prepare('SELECT * FROM leads WHERE contact_id = ?').get(c.contact_id);
  res.json({ ...c, contato, mensagens, lead });
});

api.post('/conversations/:id/reply', async (req, res) => {
  const c = loadConv(req, res); if (!c) return;
  const texto = String(req.body?.texto || '').trim();
  if (!texto) return res.status(400).json({ erro: 'Texto vazio' });
  await humanReply(c, texto);
  res.json({ ok: true });
});

api.post('/conversations/:id/status', (req, res) => {
  const c = loadConv(req, res); if (!c) return;
  const s = req.body?.status;
  if (!['ia', 'humano', 'encerrada'].includes(s)) return res.status(400).json({ erro: 'Status inválido' });
  db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run(s, c.id);
  res.json({ ok: true });
});

// CRM (leads, funil, atividades, tarefas, métricas, exportação)
api.use(crmRouter(canSee));

// Simulador: testa a IA sem WhatsApp
api.post('/tenants/:id/simulate', async (req, res) => {
  if (!canSee(req, req.params.id)) return res.sendStatus(403);
  const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
  if (!t) return res.sendStatus(404);
  const texto = String(req.body?.texto || '').trim();
  if (!texto) return res.status(400).json({ erro: 'Texto vazio' });
  const r = await handleIncoming(t, { telefone: req.body?.telefone || 'simulador', nome: req.body?.nome || 'Teste', texto, canal: 'simulador' });
  res.json(r);
});

app.use('/api', api);
app.get('*', (_req, res) => res.sendFile(path.resolve('public/index.html')));

app.listen(PORT, () => console.log(`AVA Connect rodando na porta ${PORT} — IA: ${AI_MODE}`));
