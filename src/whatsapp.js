// Envio pela WhatsApp Cloud API (Meta). Sem token configurado, apenas registra no log.
import crypto from 'node:crypto';

const GRAPH = `https://graph.facebook.com/${process.env.WA_GRAPH_VERSION || 'v21.0'}`;

// Só envia para números de telefone (contatos do chat do site e do e-mail não têm WhatsApp).
const ehTelefone = (to) => /^\d{8,15}$/.test(String(to || ''));

export async function sendText(tenant, to, body) {
  if (!ehTelefone(to)) return { ignorado: 'sem WhatsApp' };
  const token = tenant.wa_token || process.env.WA_DEFAULT_TOKEN;
  if (!tenant.wa_phone_number_id || !token) {
    console.log(`[whatsapp:simulado] ${tenant.nome} -> ${to}: ${body}`);
    return { simulado: true };
  }
  let res;
  try {
    res = await fetch(`${GRAPH}/${tenant.wa_phone_number_id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body, preview_url: false } }),
    });
  } catch (e) { console.error('[whatsapp] sem conexão com a Meta', e.message); return { erro: e.message }; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('[whatsapp] erro ao enviar', res.status, JSON.stringify(data));
    return { erro: data };
  }
  return data;
}

// Foto por link público (a Meta baixa a imagem do nosso servidor).
export async function sendImage(tenant, to, link, caption = '') {
  if (!ehTelefone(to)) return { ignorado: 'sem WhatsApp' };
  const token = tenant.wa_token || process.env.WA_DEFAULT_TOKEN;
  if (!tenant.wa_phone_number_id || !token) { console.log(`[whatsapp:simulado] ${tenant.nome} -> ${to}: [foto] ${link} ${caption}`); return { simulado: true }; }
  try {
    const res = await fetch(`${GRAPH}/${tenant.wa_phone_number_id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'image', image: { link, caption: caption.slice(0, 1000) } }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { console.error('[whatsapp] erro na foto', res.status, JSON.stringify(data)); return { erro: data }; }
    return data;
  } catch (e) { console.error('[whatsapp] sem conexão com a Meta', e.message); return { erro: e.message }; }
}

// Mensagem de modelo aprovado pela Meta (necessária para falar com o cliente após 24h sem resposta dele).
export async function sendTemplate(tenant, to, name, params = [], lang = 'pt_BR') {
  if (!ehTelefone(to)) return { erro: 'sem WhatsApp' };
  const token = tenant.wa_token || process.env.WA_DEFAULT_TOKEN;
  if (!tenant.wa_phone_number_id || !token) {
    console.log(`[whatsapp:simulado] modelo ${name} -> ${to}: ${params.join(' | ')}`);
    return { simulado: true };
  }
  let res;
  try { res = await fetch(`${GRAPH}/${tenant.wa_phone_number_id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to, type: 'template',
      template: { name, language: { code: lang }, components: params.length ? [{ type: 'body', parameters: params.map((t) => ({ type: 'text', text: String(t) })) }] : [] },
    }),
  }); } catch (e) { console.error('[whatsapp] sem conexão com a Meta', e.message); return { erro: e.message }; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { console.error('[whatsapp] erro no modelo', res.status, JSON.stringify(data)); return { erro: data }; }
  return data;
}

// Valida a assinatura X-Hub-Signature-256 enviada pela Meta.
export function validSignature(rawBody, header) {
  const secret = process.env.WA_APP_SECRET;
  if (!secret) return true; // validação desligada em desenvolvimento
  if (!header?.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const got = header.slice(7);
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

// Extrai mensagens recebidas do payload do webhook.
export function parseWebhook(body) {
  const out = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const phoneNumberId = v.metadata?.phone_number_id;
      const nomes = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of v.messages || []) {
        let texto;
        if (m.type === 'text') texto = m.text?.body;
        else if (m.type === 'button') texto = m.button?.text;
        else if (m.type === 'interactive') texto = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title;
        else if (m.type === 'reaction') texto = m.reaction?.emoji;
        else texto = `[${m.type} recebido]`;
        const md = m[m.type] || {};
        out.push({ phoneNumberId, from: m.from, nome: nomes[m.from], waId: m.id, texto, tipo: m.type,
          mediaId: md.id || null, mime: md.mime_type || null, legenda: md.caption || null, nomeArquivo: md.filename || null,
          local: m.type === 'location' ? m.location : null });
      }
    }
  }
  return out;
}
