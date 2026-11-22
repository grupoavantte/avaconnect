// Conexão do WhatsApp pelo botão da Meta (Cadastro incorporado / Embedded Signup).
// O cliente entra com o Facebook, escolhe ou cria a conta do WhatsApp Business e o número;
// aqui trocamos o código por um token da empresa, inscrevemos o app nos webhooks e registramos o número.
import crypto from 'node:crypto';
import express from 'express';
import { db } from './db.js';
import { getPlan } from './plans.js';
import { pode } from './auth.js';
import { sincronizarPrincipal } from './agents.js';

const V = process.env.WA_GRAPH_VERSION || 'v21.0';
const GRAPH = `https://graph.facebook.com/${V}`;
export const metaConfig = () => ({
  ativo: !!(process.env.META_APP_ID && process.env.META_APP_SECRET && process.env.META_ES_CONFIG_ID),
  app_id: process.env.META_APP_ID || null, config_id: process.env.META_ES_CONFIG_ID || null, versao: V,
});

const cols = db.prepare('PRAGMA table_info(whatsapp_numbers)').all().map((c) => c.name);
for (const [c, d] of [['pin', 'TEXT'], ['coexistencia', 'INTEGER NOT NULL DEFAULT 0'], ['origem', "TEXT NOT NULL DEFAULT 'manual'"]])
  if (!cols.includes(c)) db.exec(`ALTER TABLE whatsapp_numbers ADD COLUMN ${c} ${d}`);

async function graph(path, { method = 'GET', token, body, query } = {}) {
  const url = new URL(GRAPH + path);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error?.error_user_msg || data.error?.message || `Meta respondeu ${res.status}`);
  return data;
}

/** Conclui a conexão a partir do que o Cadastro incorporado devolveu. */
export async function conectarPelaMeta(tenant, { code, phone_number_id, waba_id, coexistencia = false, agent_id = null, nome = 'Principal' }) {
  const cfg = metaConfig();
  if (!cfg.ativo) throw new Error('Conexão pela Meta ainda não configurada na plataforma.');
  if (!code) throw new Error('A conexão com a Meta não foi concluída. Tente de novo.');
  // 1. Código → token da empresa (business integration system user token)
  const tok = await graph('/oauth/access_token', { query: { client_id: cfg.app_id, client_secret: process.env.META_APP_SECRET, code } });
  const token = tok.access_token;
  // Se a janela não informou a conta, descobre pelas permissões concedidas ao token.
  if (!waba_id) {
    const dbg = await graph('/debug_token', { query: { input_token: token, access_token: `${cfg.app_id}|${process.env.META_APP_SECRET}` } });
    waba_id = dbg.data?.granular_scopes?.find((g) => g.scope === 'whatsapp_business_management')?.target_ids?.[0];
    if (!waba_id) throw new Error('Não encontramos a conta do WhatsApp Business autorizada. Refaça a conexão escolhendo a conta.');
  }
  // 2. Número: se o cliente não escolheu na janela, pega o primeiro da conta
  let phoneId = phone_number_id;
  if (!phoneId) phoneId = (await graph(`/${waba_id}/phone_numbers`, { token })).data?.[0]?.id;
  if (!phoneId) throw new Error('Nenhum número encontrado na conta do WhatsApp Business.');
  const existente = db.prepare('SELECT * FROM whatsapp_numbers WHERE phone_number_id = ?').get(phoneId);
  if (existente && existente.tenant_id !== tenant.id) throw new Error('Este número já está conectado a outra empresa.');
  if (!existente && db.prepare('SELECT COUNT(*) n FROM whatsapp_numbers WHERE tenant_id = ?').get(tenant.id).n >= getPlan(tenant.plano).numeros_whatsapp)
    throw new Error(`O plano ${getPlan(tenant.plano).nome} permite ${getPlan(tenant.plano).numeros_whatsapp} número(s).`);
  // 3. Inscreve o nosso app nos webhooks da conta do cliente
  await graph(`/${waba_id}/subscribed_apps`, { method: 'POST', token });
  // 4. Registra o número na API (no modo coexistência o número continua no app e não é registrado)
  let pin = existente?.pin || null;
  if (!coexistencia) {
    pin = pin || String(crypto.randomInt(100000, 999999));
    try { await graph(`/${phoneId}/register`, { method: 'POST', token, body: { messaging_product: 'whatsapp', pin } }); }
    catch (e) { if (!/already registered|já registrado/i.test(e.message)) throw new Error('Não foi possível registrar o número: ' + e.message); }
  }
  const info = await graph(`/${phoneId}`, { token, query: { fields: 'display_phone_number,verified_name' } }).catch(() => ({}));
  const tel = (info.display_phone_number || '').replace(/\D/g, '') || null;
  if (existente) {
    db.prepare(`UPDATE whatsapp_numbers SET token = ?, waba_id = ?, telefone = COALESCE(?, telefone), status_teste = 'ok', testado_em = datetime('now'), pin = ?, coexistencia = ?, origem = 'meta',
      agent_id = COALESCE(?, agent_id) WHERE id = ?`).run(token, waba_id, tel, pin, coexistencia ? 1 : 0, agent_id, existente.id);
  } else {
    const primeiro = !db.prepare('SELECT 1 FROM whatsapp_numbers WHERE tenant_id = ?').get(tenant.id);
    db.prepare(`INSERT INTO whatsapp_numbers (tenant_id, nome, telefone, phone_number_id, waba_id, token, agent_id, principal, status_teste, testado_em, pin, coexistencia, origem)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ok', datetime('now'), ?, ?, 'meta')`).run(tenant.id, nome, tel, phoneId, waba_id, token, agent_id, primeiro ? 1 : 0, pin, coexistencia ? 1 : 0);
  }
  sincronizarPrincipal(tenant.id);
  return { ok: true, phone_number_id: phoneId, telefone: tel, nome_verificado: info.verified_name || null, pin, coexistencia: !!coexistencia };
}

export function metaRouter(canSee) {
  const r = express.Router();
  r.get('/meta/config', (_req, res) => res.json(metaConfig()));
  r.post('/tenants/:id/numbers/meta', async (req, res) => {
    if (!canSee(req, req.params.id)) return res.sendStatus(403);
    if (!pode(req.user, 'conexoes')) return res.status(403).json({ erro: 'Só o dono da conta conecta o WhatsApp' });
    const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
    try { res.status(201).json(await conectarPelaMeta(t, req.body || {})); }
    catch (e) { console.error('[meta] conexão', e.message); res.status(400).json({ erro: e.message }); }
  });
  return r;
}
