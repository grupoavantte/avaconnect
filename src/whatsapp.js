// Envio pela WhatsApp Cloud API (Meta). Sem token configurado, apenas registra no log.
import crypto from 'node:crypto';

const GRAPH = `https://graph.facebook.com/${process.env.WA_GRAPH_VERSION || 'v21.0'}`;

// Só envia para números de telefone (contatos do chat do site e do e-mail não têm WhatsApp).
const ehTelefone = (to) => /^\d{8,15}$/.test(String(to || ''));

// Celular brasileiro: o webhook da Meta costuma trazer o número SEM o 9 (55 + DDD + 8 dígitos).
// Quando a Meta recusa esse formato (ex.: lista de destinatários do número de teste), tenta de novo com o 9.
export function variantesBR(to) {
  const n = String(to || '');
  let m = n.match(/^55(\d{2})([6-9]\d{7})$/);
  if (m) return [n, `55${m[1]}9${m[2]}`];
  m = n.match(/^55(\d{2})9([6-9]\d{7})$/);
  return m ? [n, `55${m[1]}${m[2]}`] : [n];
}

// Últimos erros de envio (para diagnóstico no painel da plataforma).
export const errosRecentes = [];
function anotarErro(tenant, to, status, data) {
  errosRecentes.unshift({ quando: new Date().toISOString(), phone_number_id: tenant.wa_phone_number_id, to, status,
    codigo: data?.error?.code ?? null, mensagem: data?.error?.message || data?.error?.error_data?.details || String(data).slice(0, 200) });
  errosRecentes.length = Math.min(errosRecentes.length, 30);
}
const ERROS_DESTINO = new Set([131030, 131026, 100]);

async function postar(tenant, token, payload, rotulo) {
  let ultimo;
  for (const to of variantesBR(payload.to)) {
    let res;
    try {
      res = await fetch(`${GRAPH}/${tenant.wa_phone_number_id}/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...payload, to }),
      });
    } catch (e) { console.error('[whatsapp] sem conexão com a Meta', e.message); anotarErro(tenant, to, 0, { error: { message: e.message } }); return { erro: e.message }; }
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    console.error(`[whatsapp] ${rotulo}`, res.status, to, JSON.stringify(data));
    anotarErro(tenant, to, res.status, data);
    ultimo = { erro: data };
    if (!ERROS_DESTINO.has(data?.error?.code)) break;
  }
  return ultimo;
}

export async function sendText(tenant, to, body) {
  if (!ehTelefone(to)) return { ignorado: 'sem WhatsApp' };
  const token = tenant.wa_token || process.env.WA_DEFAULT_TOKEN;
  if (!tenant.wa_phone_number_id || !token) {
    console.log(`[whatsapp:simulado] ${tenant.nome} -> ${to}: ${body}`);
    return { simulado: true };
  }
  return postar(tenant, token, { messaging_product: 'whatsapp', to, type: 'text', text: { body, preview_url: false } }, 'erro ao enviar');
}

// Foto por link público (a Meta baixa a imagem do nosso servidor).
export const sendImage = (tenant, to, link, caption = '') => sendMedia(tenant, to, 'image', link, caption);

// Foto, vídeo ou documento por link público. tipo: image | video | document.
export async function sendMedia(tenant, to, tipo, link, caption = '', filename = '') {
  if (!ehTelefone(to)) return { ignorado: 'sem WhatsApp' };
  const token = tenant.wa_token || process.env.WA_DEFAULT_TOKEN;
  if (!tenant.wa_phone_number_id || !token) { console.log(`[whatsapp:simulado] ${tenant.nome} -> ${to}: [${tipo}] ${link} ${caption}`); return { simulado: true }; }
  const midia = { link, ...(caption ? { caption: caption.slice(0, 1000) } : {}), ...(tipo === 'document' && filename ? { filename } : {}) };
  return postar(tenant, token, { messaging_product: 'whatsapp', to, type: tipo, [tipo]: midia }, `erro no envio de ${tipo}`);
}

// Mensagem de modelo aprovado pela Meta (necessária para falar com o cliente após 24h sem resposta dele).
export async function sendTemplate(tenant, to, name, params = [], lang = 'pt_BR') {
  if (!ehTelefone(to)) return { erro: 'sem WhatsApp' };
  const token = tenant.wa_token || process.env.WA_DEFAULT_TOKEN;
  if (!tenant.wa_phone_number_id || !token) {
    console.log(`[whatsapp:simulado] modelo ${name} -> ${to}: ${params.join(' | ')}`);
    return { simulado: true };
  }
  return postar(tenant, token, {
    messaging_product: 'whatsapp', to, type: 'template',
    template: { name, language: { code: lang }, components: params.length ? [{ type: 'body', parameters: params.map((t) => ({ type: 'text', text: String(t) })) }] : [] },
  }, 'erro no modelo');
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
