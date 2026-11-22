// Envio de e-mail pela API da Resend (resend.com). Sem RESEND_API_KEY, apenas registra no log (modo simulado).
const KEY = process.env.RESEND_API_KEY;
export const EMAIL_MODE = KEY ? 'resend' : 'simulado';

// Remetente precisa ser de um domínio verificado na Resend (ex.: vendas@grupoavantte.com.br).
const FROM_EMAIL = process.env.EMAIL_FROM || 'contato@grupoavantte.com.br';

export async function sendEmail(tenant, { to, subject, html, text }) {
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { erro: 'E-mail inválido' };
  const from = `${(tenant.email_remetente_nome || tenant.nome).replace(/[<>"]/g, '')} <${FROM_EMAIL}>`;
  if (!KEY) {
    console.log(`[email:simulado] ${from} -> ${to}: ${subject}`);
    return { simulado: true };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ from, to: [to], subject, html, text, reply_to: tenant.email_resposta || undefined }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { console.error('[email] erro', res.status, JSON.stringify(data)); return { erro: data.message || 'falha no envio' }; }
  return data;
}
