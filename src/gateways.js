// Gateways de pagamento das empresas clientes. O dinheiro das vendas cai na conta do próprio cliente:
// o AVA só gera o link (ou o Pix) com a credencial dele e recebe a confirmação para seguir o atendimento.
import crypto from 'node:crypto';
import { db } from './db.js';

export const GATEWAYS = {
  asaas: { nome: 'Asaas', descricao: 'Pix, boleto e cartão. Confirmação automática.', automatico: true,
    campos: [{ k: 'api_key', rotulo: 'Chave da API', segredo: true, placeholder: '$aact_...' }] },
  mercadopago: { nome: 'Mercado Pago', descricao: 'Pix, boleto e cartão com o checkout do Mercado Pago. Confirmação automática.', automatico: true,
    campos: [{ k: 'access_token', rotulo: 'Access token de produção', segredo: true, placeholder: 'APP_USR-...' }] },
  pagarme: { nome: 'Pagar.me', descricao: 'Pix, boleto e cartão com o checkout da Pagar.me. Confirmação automática.', automatico: true,
    campos: [{ k: 'secret_key', rotulo: 'Chave secreta (secret key)', segredo: true, placeholder: 'sk_...' }] },
  pix: { nome: 'Pix direto (qualquer banco)', descricao: 'Sem gateway e sem taxa: o cliente paga pela sua chave Pix. A confirmação é manual (comprovante).', automatico: false,
    campos: [{ k: 'chave', rotulo: 'Chave Pix', placeholder: 'CNPJ, e-mail, celular ou chave aleatória' },
      { k: 'nome', rotulo: 'Nome do recebedor (como no banco)', placeholder: 'LOJA EXEMPLO LTDA' },
      { k: 'cidade', rotulo: 'Cidade', placeholder: 'SAO PAULO' }] },
};

const cols = db.prepare('PRAGMA table_info(tenants)').all().map((c) => c.name);
if (!cols.includes('gateway')) db.exec('ALTER TABLE tenants ADD COLUMN gateway TEXT');
if (!cols.includes('gateway_config')) db.exec('ALTER TABLE tenants ADD COLUMN gateway_config TEXT');
const ccols = db.prepare('PRAGMA table_info(charges)').all().map((c) => c.name);
if (!ccols.includes('gateway')) db.exec('ALTER TABLE charges ADD COLUMN gateway TEXT');
if (!ccols.includes('pix_copia_cola')) db.exec('ALTER TABLE charges ADD COLUMN pix_copia_cola TEXT');

export const configGateway = (t) => { try { return JSON.parse(t?.gateway_config || '{}') || {}; } catch { return {}; } };

/** Gateway ativo da empresa: o escolhido; sem escolha, o Asaas se houver chave (compatível com as contas antigas). */
export function gatewayDe(t, chaveAsaasGlobal = null) {
  if (t?.gateway && GATEWAYS[t.gateway] && gatewayCompleto(t.gateway, configGateway(t), t)) return t.gateway;
  if (t?.asaas_api_key || chaveAsaasGlobal) return 'asaas';
  return null;
}
export function gatewayCompleto(g, cfg, t = {}) {
  if (g === 'asaas') return !!(cfg.api_key || t.asaas_api_key);
  return (GATEWAYS[g]?.campos || []).every((c) => String(cfg[c.k] || '').trim());
}

// ---------- Pix (BR Code estático, padrão do Banco Central) ----------
const tlv = (id, v) => `${id}${String(v.length).padStart(2, '0')}${v}`;
function crc16(s) {
  let crc = 0xffff;
  for (const ch of Buffer.from(s, 'utf8')) { crc ^= ch << 8; for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff; }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
const semAcento = (s, max) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 .-]/g, '').toUpperCase().trim().slice(0, max);
const cpfOk = (c) => { if (!/^\d{11}$/.test(c) || /^(\d)\1{10}$/.test(c)) return false;
  const dv = (n) => { let t = 0; for (let i = 0; i < n; i++) t += Number(c[i]) * (n + 1 - i); const r = (t * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === Number(c[9]) && dv(10) === Number(c[10]); };
/** Chave Pix no formato do BR Code: e-mail e aleatória em minúsculas, CPF/CNPJ só números, celular como +55DDDNÚMERO. */
export function normalizarChavePix(chave) {
  const c = String(chave || '').trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c)) return c.toLowerCase();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c)) return c.toLowerCase();
  const d = c.replace(/\D/g, '');
  if (d.length === 14) return d;                                   // CNPJ
  if (d.length === 11 && !c.startsWith('+') && cpfOk(d)) return d; // CPF
  if (d.length === 13 && d.startsWith('55')) return '+' + d;       // celular com 55
  if (d.length === 10 || d.length === 11) return '+55' + d;        // celular com DDD
  return c;
}
export function pixCopiaCola({ chave, nome, cidade, valor, txid, descricao }) {
  const conta = tlv('00', 'br.gov.bcb.pix') + tlv('01', normalizarChavePix(chave)) + (descricao ? tlv('02', semAcento(descricao, 40)) : '');
  const id = String(txid || '***').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***';
  const sem = tlv('00', '01') + tlv('26', conta) + tlv('52', '0000') + tlv('53', '986') + (valor ? tlv('54', Number(valor).toFixed(2)) : '') +
    tlv('58', 'BR') + tlv('59', semAcento(nome, 25) || 'RECEBEDOR') + tlv('60', semAcento(cidade, 15) || 'BRASIL') + tlv('62', tlv('05', id)) + '6304';
  return sem + crc16(sem);
}

// ---------- Chamadas às APIs ----------
async function http(url, { method = 'GET', headers = {}, body } = {}, nome) {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json', 'user-agent': 'ava-connect', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${nome} ${res.status}: ${data.message || data.error?.message || JSON.stringify(data.errors || data).slice(0, 200)}`);
  return data;
}
const MP = 'https://api.mercadopago.com';
const PGM = 'https://api.pagar.me/core/v5';
const mpAuth = (cfg) => ({ authorization: `Bearer ${cfg.access_token}` });
const pgAuth = (cfg) => ({ authorization: 'Basic ' + Buffer.from(`${cfg.secret_key}:`).toString('base64') });

/**
 * Cria a cobrança no gateway escolhido. Retorna { ref, url, pix? }.
 * forma: pix | boleto | cartao | livre. urls: { base, obrigado, webhook }.
 */
export async function criarNoGateway(gateway, cfg, { token, valor, descricao, forma = 'livre', parcelas = 1, vencimentoDias = 3, cliente = {} }, urls) {
  const centavos = Math.round(Number(valor) * 100);
  if (gateway === 'mercadopago') {
    const excluir = { pix: ['credit_card', 'debit_card', 'ticket'], boleto: ['credit_card', 'debit_card', 'bank_transfer'], cartao: ['ticket', 'bank_transfer'] }[forma] || [];
    const expira = new Date(Date.now() + Math.max(1, vencimentoDias) * 864e5).toISOString().replace('Z', '-00:00');
    const pref = await http(`${MP}/checkout/preferences`, { method: 'POST', headers: mpAuth(cfg), body: {
      items: [{ id: token, title: descricao.slice(0, 250), quantity: 1, unit_price: Number(Number(valor).toFixed(2)), currency_id: 'BRL' }],
      external_reference: token, notification_url: urls.webhook, back_urls: { success: urls.obrigado, pending: urls.obrigado, failure: urls.obrigado }, auto_return: 'approved',
      payment_methods: { excluded_payment_types: excluir.map((id) => ({ id })), installments: forma === 'cartao' ? Math.max(1, Math.min(12, parcelas)) : 12 },
      expires: true, date_of_expiration: expira, statement_descriptor: undefined,
      ...(cliente.nome || cliente.email ? { payer: { name: cliente.nome || undefined, email: cliente.email || undefined } } : {}),
    } }, 'Mercado Pago');
    return { ref: pref.id, url: pref.init_point };
  }
  if (gateway === 'pagarme') {
    const metodos = { pix: ['pix'], boleto: ['boleto'], cartao: ['credit_card'] }[forma] || ['pix', 'boleto', 'credit_card'];
    const fone = String(cliente.telefone || '').replace(/\D/g, '').replace(/^55/, '');
    const order = await http(`${PGM}/orders`, { method: 'POST', headers: pgAuth(cfg), body: {
      code: token, closed: true,
      items: [{ amount: centavos, description: descricao.slice(0, 256), quantity: 1, code: 'ava' }],
      customer: { name: cliente.nome || 'Cliente', type: 'individual', ...(cliente.email ? { email: cliente.email } : {}),
        ...(fone.length >= 10 ? { phones: { mobile_phone: { country_code: '55', area_code: fone.slice(0, 2), number: fone.slice(2) } } } : {}) },
      payments: [{ payment_method: 'checkout', amount: centavos, checkout: {
        expires_in: Math.max(1, vencimentoDias) * 24 * 60, accepted_payment_methods: metodos, customer_editable: true, skip_checkout_success_page: false,
        success_url: urls.obrigado,
        ...(metodos.includes('pix') ? { pix: { expires_in: Math.max(1, vencimentoDias) * 86400 } } : {}),
        ...(metodos.includes('boleto') ? { boleto: { due_at: new Date(Date.now() + Math.max(1, vencimentoDias) * 864e5).toISOString() } } : {}),
        ...(metodos.includes('credit_card') ? { credit_card: { installments: Array.from({ length: forma === 'cartao' ? Math.max(1, Math.min(12, parcelas)) : 1 }, (_, i) => ({ number: i + 1, total: centavos })) } } : {}),
      } }],
      metadata: { ava_token: token },
    } }, 'Pagar.me');
    const url = order.checkouts?.[0]?.payment_url || order.charges?.[0]?.last_transaction?.url || null;
    if (!url) throw new Error('Pagar.me não devolveu o link de pagamento');
    return { ref: order.id, url };
  }
  if (gateway === 'pix') {
    const pix = pixCopiaCola({ chave: cfg.chave, nome: cfg.nome, cidade: cfg.cidade, valor, txid: token.replace(/^cob_/, '').slice(0, 25), descricao: null });
    return { ref: 'pix', url: `${urls.base}/pix/${token}`, pix };
  }
  throw new Error('Gateway não suportado');
}

/** Confere a credencial na API do gateway. */
export async function testarGateway(gateway, cfg) {
  try {
    if (gateway === 'mercadopago') { const me = await http(`${MP}/users/me`, { headers: mpAuth(cfg) }, 'Mercado Pago'); return { ok: true, msg: `Conta ${me.nickname || me.email || me.id}` }; }
    if (gateway === 'pagarme') { await http(`${PGM}/orders?size=1`, { headers: pgAuth(cfg) }, 'Pagar.me'); return { ok: true, msg: 'Chave válida' }; }
    if (gateway === 'pix') {
      const c = normalizarChavePix(cfg.chave);
      const ok = /^[^\s@]+@[^\s@]+$/.test(c) || /^\+55\d{10,11}$/.test(c) || /^\d{11}$|^\d{14}$/.test(c) || /^[0-9a-f-]{36}$/.test(c);
      return ok ? { ok: true, msg: 'Chave Pix no formato certo. Faça um Pix de teste de R$ 1 para conferir.' } : { ok: false, msg: 'Chave Pix em formato desconhecido' };
    }
    return { ok: false, msg: 'Gateway sem teste' };
  } catch (e) { return { ok: false, msg: e.message }; }
}

/** Busca no gateway se o pagamento avisado foi aprovado. Retorna { token, pago } ou null. */
export async function conferirWebhook(gateway, cfg, req) {
  if (gateway === 'mercadopago') {
    const tipo = req.body?.type || req.body?.topic || req.query.type || req.query.topic;
    const id = req.body?.data?.id || req.query['data.id'] || req.query.id;
    if (!id || (tipo && !String(tipo).includes('payment'))) return null;
    const p = await http(`${MP}/v1/payments/${encodeURIComponent(id)}`, { headers: mpAuth(cfg) }, 'Mercado Pago');
    return { token: p.external_reference, pago: p.status === 'approved', valor: p.transaction_amount };
  }
  if (gateway === 'pagarme') {
    const d = req.body?.data || {};
    const orderId = d.order?.id || (String(d.id || '').startsWith('or_') ? d.id : null);
    if (!orderId) return null;
    const o = await http(`${PGM}/orders/${encodeURIComponent(orderId)}`, { headers: pgAuth(cfg) }, 'Pagar.me');
    return { token: o.code || o.metadata?.ava_token, pago: o.status === 'paid', valor: (o.amount || 0) / 100 };
  }
  return null;
}

export const novoSegredo = () => crypto.randomBytes(16).toString('hex');

// ---------- Rotas: webhooks dos gateways, página do Pix e configuração ----------
import express from 'express';
import QRCode from 'qrcode';
import { pode } from './auth.js';

const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function rotasGateways(app) {
  // Aviso do gateway: confirmamos na API dele com a credencial da empresa (o corpo do aviso não basta).
  for (const g of ['mercadopago', 'pagarme']) app.post(`/webhooks/${g}/:tid`, express.json({ limit: '256kb' }), async (req, res) => {
    res.sendStatus(200);
    try {
      const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(Number(req.params.tid));
      if (!t || t.gateway !== g) return;
      const ev = await conferirWebhook(g, configGateway(t), req);
      if (!ev?.token || !ev.pago) return;
      const charge = db.prepare('SELECT * FROM charges WHERE token = ? AND tenant_id = ?').get(ev.token, t.id);
      if (!charge || charge.status === 'pago') return;
      const { confirmarPagamentoCobranca } = await import('./vendas.js');
      await confirmarPagamentoCobranca(charge);
    } catch (e) { console.error(`[${g}] webhook`, e.message); }
  });

  // Pix direto: página com QR Code e copia e cola.
  app.get('/pix/:token', async (req, res) => {
    const c = db.prepare('SELECT c.*, t.nome empresa FROM charges c JOIN tenants t ON t.id = c.tenant_id WHERE c.token = ?').get(req.params.token);
    if (!c?.pix_copia_cola) return res.status(404).send('Cobrança não encontrada.');
    const svg = await QRCode.toString(c.pix_copia_cola, { type: 'svg', margin: 1, width: 240 });
    res.type('html').send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pix — ${esc(c.empresa)}</title><style>body{margin:0;font-family:Inter,system-ui,sans-serif;background:#F5F7FB;color:#0F1A2E;display:grid;place-items:center;min-height:100vh}
.c{background:#fff;border:1px solid #E3E8F0;border-radius:18px;padding:28px;max-width:380px;width:calc(100% - 32px);text-align:center}h1{font-size:20px;margin:0 0 4px}
.v{font-size:30px;font-weight:800;margin:10px 0}.q{width:240px;height:240px;margin:12px auto}textarea{width:100%;box-sizing:border-box;font:12px monospace;border:1px solid #E3E8F0;border-radius:10px;padding:10px;height:90px;resize:none}
button{margin-top:10px;width:100%;padding:14px;border:0;border-radius:12px;background:#06112A;color:#fff;font-weight:700;font-size:16px;cursor:pointer}p{color:#5B6780;font-size:14px;line-height:1.5}.ok{color:#0B6E66;font-weight:700}</style></head>
<body><main class="c"><h1>${esc(c.empresa)}</h1><p style="margin:0">${esc(c.descricao)}</p><div class="v">${brl(c.valor)}</div>
${c.status === 'pago' ? '<p class="ok">Pagamento confirmado. Obrigado!</p>' : `<div class="q" role="img" aria-label="QR Code do Pix">${svg}</div>
<label for="cc" style="font-size:13px;font-weight:600">Pix copia e cola</label><textarea id="cc" readonly>${esc(c.pix_copia_cola)}</textarea>
<button type="button" onclick="navigator.clipboard.writeText(document.getElementById('cc').value).then(()=>this.textContent='Copiado!')">Copiar código</button>
<p>Abra o app do seu banco, escolha Pix copia e cola (ou leia o QR Code) e pague. Depois, envie o comprovante na conversa do WhatsApp.</p>`}</main></body></html>`);
  });
}

/** Cliente mandou imagem ou PDF com um Pix direto em aberto: avisa a equipe para conferir e confirmar. */
export async function possivelComprovante(tenant, contact, entrada) {
  if (!['image', 'document'].includes(entrada?.type)) return false;
  const ch = db.prepare("SELECT * FROM charges WHERE contact_id = ? AND status IN ('pendente','vencido') AND pix_copia_cola IS NOT NULL ORDER BY id DESC LIMIT 1").get(contact.id);
  if (!ch) return false;
  const { avisarResponsavel } = await import('./vendas.js');
  await avisarResponsavel(tenant, `🧾 ${contact.nome || contact.telefone} enviou um possível comprovante do Pix de ${brl(ch.valor)} (${ch.descricao}). Confira no banco e confirme no painel (Vendas → Cobranças).`);
  return true;
}

export function recebimentoRouter(canSee) {
  const r = express.Router();
  const ok = (req, res, acao) => {
    if (!canSee(req, req.params.id)) { res.sendStatus(403); return null; }
    if (acao && !pode(req.user, acao)) { res.status(403).json({ erro: 'Sem permissão' }); return null; }
    return db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
  };
  const base = () => (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  const mascara = (v) => (v ? `••••${String(v).slice(-4)}` : '');
  r.get('/tenants/:id/recebimento', (req, res) => {
    const t = ok(req, res); if (!t) return;
    const cfg = configGateway(t);
    const atual = t.gateway || (t.asaas_api_key ? 'asaas' : null);
    res.json({ gateway: atual, ativo: gatewayDe(t), gateways: Object.entries(GATEWAYS).map(([id, g]) => ({ id, ...g })),
      config: Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, GATEWAYS[atual]?.campos.find((c) => c.k === k)?.segredo ? mascara(v) : v])),
      asaas_legado: !!t.asaas_api_key,
      webhook_token: t.asaas_webhook_token || '',
      webhooks: { asaas: `${base()}/webhooks/asaas`, pagarme: `${base()}/webhooks/pagarme/${t.id}`, mercadopago: `${base()}/webhooks/mercadopago/${t.id}` } });
  });
  r.put('/tenants/:id/recebimento', async (req, res) => {
    const t = ok(req, res, 'conexoes'); if (!t) return;
    const g = req.body?.gateway;
    if (g === null || g === '') { db.prepare('UPDATE tenants SET gateway = NULL, gateway_config = NULL WHERE id = ?').run(t.id); return res.json({ ok: true }); }
    if (!GATEWAYS[g]) return res.status(400).json({ erro: 'Escolha uma forma de recebimento' });
    const anterior = t.gateway === g ? configGateway(t) : {};
    const cfg = {};
    for (const c of GATEWAYS[g].campos) {
      const v = String(req.body?.config?.[c.k] ?? '').trim();
      cfg[c.k] = v && !v.startsWith('••••') ? v : anterior[c.k] || (g === 'asaas' && c.k === 'api_key' ? t.asaas_api_key || '' : '');
    }
    if (!gatewayCompleto(g, cfg, t)) return res.status(400).json({ erro: 'Preencha todos os campos' });
    let teste = { ok: true, msg: '' };
    if (g === 'asaas') {
      try { const base = process.env.ASAAS_BASE_URL || 'https://api.asaas.com/v3';
        const rr = await fetch(`${base}/myAccount`, { headers: { access_token: cfg.api_key, 'user-agent': 'ava-connect' } });
        teste = rr.ok ? { ok: true, msg: 'Asaas conectado' } : { ok: false, msg: `Asaas recusou a chave (${rr.status})` }; } catch (e) { teste = { ok: false, msg: e.message }; }
    } else teste = await testarGateway(g, cfg);
    if (!teste.ok && req.body?.forcar !== true) return res.status(400).json({ erro: teste.msg, teste });
    db.prepare('UPDATE tenants SET gateway = ?, gateway_config = ?, asaas_api_key = CASE WHEN ? THEN ? ELSE asaas_api_key END WHERE id = ?')
      .run(g, JSON.stringify(cfg), g === 'asaas' ? 1 : 0, cfg.api_key || null, t.id);
    res.json({ ok: true, teste });
  });
  return r;
}
