// Teste da conexão do WhatsApp pelo botão da Meta (APIs da Meta simuladas).
process.env.DB_PATH = `/tmp/ava-meta-${Date.now()}.db`;
process.env.META_APP_ID = '111'; process.env.META_APP_SECRET = 'seg'; process.env.META_ES_CONFIG_ID = '222';
const chamadas = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url)); chamadas.push({ path: u.pathname, method: opts.method || 'GET', q: Object.fromEntries(u.searchParams), body: opts.body });
  const j = (d) => ({ ok: true, status: 200, json: async () => d });
  if (u.pathname.endsWith('/oauth/access_token')) return u.searchParams.get('code') === 'bom' ? j({ access_token: 'EAAbiz' }) : { ok: false, status: 400, json: async () => ({ error: { message: 'Error validating verification code' } }) };
  if (u.pathname.endsWith('/debug_token')) return j({ data: { granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['WABA9'] }] } });
  if (u.pathname.endsWith('/phone_numbers')) return j({ data: [{ id: 'PH9' }] });
  if (u.pathname.endsWith('/subscribed_apps')) return j({ success: true });
  if (u.pathname.endsWith('/register')) return j({ success: true });
  return j({ display_phone_number: '+55 24 99999-0000', verified_name: 'Loja Teste' });
};
const { db } = await import('../src/db.js');
const { conectarPelaMeta, metaConfig } = await import('../src/meta.js');
let ok = 0;
const check = (c, m) => { if (!c) { console.error('FALHOU:', m); process.exit(1); } ok++; console.log('ok -', m); };
const tid = db.prepare("INSERT INTO tenants (nome, plano, painel_token) VALUES ('Loja', 'profissional', 'tk')").run().lastInsertRowid;
const t = () => db.prepare('SELECT * FROM tenants WHERE id = ?').get(tid);

check(metaConfig().ativo && metaConfig().config_id === '222', 'configuração da Meta lida do ambiente');
let erro = ''; try { await conectarPelaMeta(t(), { code: 'ruim', waba_id: 'W1', phone_number_id: 'P1' }); } catch (e) { erro = e.message; }
check(erro.includes('verification code'), 'código inválido devolve o erro da Meta');
const r = await conectarPelaMeta(t(), { code: 'bom', waba_id: 'W1', phone_number_id: 'P1', nome: 'Vendas' });
check(r.ok && r.telefone === '5524999990000' && /^\d{6}$/.test(r.pin), 'número conectado com telefone e PIN');
check(chamadas.some((c) => c.path.endsWith('/W1/subscribed_apps') && c.method === 'POST'), 'app inscrito nos webhooks da conta do cliente');
const reg = chamadas.find((c) => c.path.endsWith('/P1/register'));
check(reg && JSON.parse(reg.body).pin === r.pin, 'número registrado na API com o PIN');
const n = db.prepare("SELECT * FROM whatsapp_numbers WHERE phone_number_id = 'P1'").get();
check(n.token === 'EAAbiz' && n.status_teste === 'ok' && n.principal === 1 && t().wa_phone_number_id === 'P1', 'token salvo e número principal sincronizado');
chamadas.length = 0;
const r2 = await conectarPelaMeta(t(), { code: 'bom', coexistencia: true });
check(r2.phone_number_id === 'PH9' && !chamadas.some((c) => c.path.endsWith('/register')), 'coexistência: descobre a conta e não registra o número');
const outra = db.prepare("INSERT INTO tenants (nome, plano, painel_token) VALUES ('Outra', 'premium', 'tk2')").run().lastInsertRowid;
erro = ''; try { await conectarPelaMeta(db.prepare('SELECT * FROM tenants WHERE id = ?').get(outra), { code: 'bom', waba_id: 'W1', phone_number_id: 'P1' }); } catch (e) { erro = e.message; }
check(erro.includes('outra empresa'), 'mesmo número não vai para duas empresas');
console.log(`\n${ok} verificações da conexão Meta passaram.`);
