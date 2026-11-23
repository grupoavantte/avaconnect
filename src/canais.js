// Canais além do WhatsApp: chat no site (balão da AVA), formulários de contato/orçamento e e-mail.
// Tudo cai na mesma caixa de entrada e no mesmo CRM, com a origem marcada.
import crypto from 'node:crypto';
import express from 'express';
import { db, logActivity, bumpUsage } from './db.js';
import { handleIncoming, addMessage } from './engine.js';
import { garantirLead } from './vendas.js';
import { enviarModelo, textoModelo, avisarEquipe } from './modelos.js';
import { sendEmail } from './email.js';
import { publicUrl } from './payments.js';

// ---------- Estrutura ----------
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
const addCols = (t, lista) => { const tem = cols(t); for (const [c, d] of lista) if (!tem.includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); };
addCols('tenants', [
  ['canal_token', 'TEXT'],                          // identificador público usado no código do site e nos formulários
  ['webchat_ativo', 'INTEGER NOT NULL DEFAULT 1'],
  ['webchat_cor', "TEXT NOT NULL DEFAULT '#12D8C4'"],
  ['webchat_titulo', 'TEXT'],
  ['webchat_saudacao', 'TEXT'],
  ['webchat_lado', "TEXT NOT NULL DEFAULT 'direita'"],   // direita | esquerda
  ['webchat_margem', 'INTEGER NOT NULL DEFAULT 20'],      // distância do rodapé em px (para não brigar com outro botão do site)
  ['form_whatsapp', 'INTEGER NOT NULL DEFAULT 1'],  // responder pelo WhatsApp quem deixou o número no formulário (com consentimento)
  ['form_aviso_email', 'TEXT'],                     // e-mail da equipe para receber cada formulário
]);
addCols('contacts', [['email', 'TEXT'], ['whatsapp_informado', 'TEXT'], ['vinculo_site_conv', 'INTEGER'], ['nome_confirmado', 'INTEGER NOT NULL DEFAULT 0']]);
addCols('usage', [['conversas_canais', 'INTEGER NOT NULL DEFAULT 0']]);

export const CANAIS_EXTRAS = ['site', 'formulario', 'email'];
export const NOME_CANAL = { whatsapp: 'WhatsApp', simulador: 'Simulador', site: 'Chat do site', formulario: 'Formulário', email: 'E-mail' };

export function tokenCanal(tenant) {
  if (tenant.canal_token) return tenant.canal_token;
  const tk = 'c' + crypto.randomBytes(9).toString('base64url');
  db.prepare('UPDATE tenants SET canal_token = ? WHERE id = ? AND canal_token IS NULL').run(tk, tenant.id);
  return db.prepare('SELECT canal_token FROM tenants WHERE id = ?').get(tenant.id).canal_token;
}
const tenantPorToken = (tk) => (tk && /^c[\w-]{6,30}$/.test(tk) ? db.prepare('SELECT * FROM tenants WHERE canal_token = ?').get(tk) : null);

/** Número de WhatsApp principal da empresa (para o botão "continuar no WhatsApp"). */
function whatsappDaEmpresa(tenant) {
  const n = db.prepare('SELECT telefone FROM whatsapp_numbers WHERE tenant_id = ? AND telefone IS NOT NULL ORDER BY principal DESC, id LIMIT 1').get(tenant.id);
  return String(n?.telefone || tenant.telefone_responsavel || '').replace(/\D/g, '') || null;
}

/** Normaliza telefone brasileiro para 55DDDNÚMERO. Retorna null se não parecer telefone. */
export function normalizarTelefone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return /^55\d{10,11}$/.test(d) ? d : (/^\d{12,15}$/.test(d) && !d.startsWith('55') ? d : null);
}
/** Procura um WhatsApp/telefone escrito no meio de um texto. */
export function telefoneNoTexto(t) {
  const m = String(t || '').match(/(?:\+?55[\s.-]?)?\(?\b[1-9]{2}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}\b/);
  return m ? normalizarTelefone(m[0]) : null;
}

// ---------- Contexto para a IA conforme o canal ----------
export function contextoCanal(canal, contact) {
  const partes = [];
  if (canal === 'site') partes.push('Canal: chat no site da empresa (a pessoa NÃO está no WhatsApp). Responda curto. Quando houver interesse real (orçamento, proposta, compra, agendamento), peça o nome e o WhatsApp para enviar a proposta e continuar o atendimento; não envie cobrança por aqui antes disso.');
  if (canal === 'email') partes.push('Canal: e-mail. Responda como um e-mail curto e cordial, em parágrafos, sem emojis e sem markdown. Se fizer sentido, ofereça continuar pelo WhatsApp.');
  if (contact?.id) {
    const c = db.prepare('SELECT nome, nome_confirmado FROM contacts WHERE id = ?').get(contact.id);
    if (c?.nome_confirmado && c.nome) partes.push(`Nome do cliente (confirmado): ${c.nome}. Chame pelo primeiro nome e não pergunte de novo.`);
    else partes.push(`Ainda NÃO sabemos o nome do cliente${c?.nome ? ` (o perfil mostra "${c.nome}", mas pode não ser o nome real; não use)` : ''}. Antes de qualquer outra coisa, pergunte como ele se chama; assim que ele disser, chame registrar_lead com o nome.`);
  }
  if (contact?.id) {
    const f = db.prepare(`SELECT a.descricao FROM activities a JOIN leads l ON l.id = a.lead_id WHERE l.contact_id = ? AND a.descricao LIKE '📝 Formulário do site:%'
      AND a.criado_em > datetime('now', '-15 days') ORDER BY a.id DESC LIMIT 1`).get(contact.id);
    if (f) partes.push(`Esta pessoa preencheu o formulário do site da empresa. Dados enviados: ${f.descricao.replace(/^📝 Formulário do site:\n/, '').replace(/\n/g, '; ').slice(0, 900)}. Use isso para atender sem pedir de novo o que ela já informou.`);
  }
  if (contact?.vinculo_site_conv) {
    const ult = db.prepare("SELECT autor, conteudo FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 8").all(contact.vinculo_site_conv).reverse();
    if (ult.length) partes.push(`Esta pessoa veio do chat do site. Resumo do que conversaram lá: ${ult.map((m) => `${m.autor === 'cliente' ? 'Cliente' : 'Empresa'}: ${m.conteudo}`).join(' | ').slice(0, 1200)}. Continue de onde parou, sem repetir perguntas já respondidas.`);
  }
  return partes.join(' ');
}

/** Contagem de uso: conversas de site, formulário e e-mail não consomem o limite de conversas de WhatsApp do plano. */
export function contarConversa(tenantId, canal) {
  bumpUsage(tenantId, CANAIS_EXTRAS.includes(canal) ? 'conversas_canais' : 'conversas');
}

/** WhatsApp que chega com o código do chat do site ("Código S123"): liga as duas conversas. */
export function vincularCodigoSite(tenant, contact, texto) {
  const m = String(texto || '').match(/\bS(\d{1,9})\b/);
  if (!m) return;
  const conv = db.prepare("SELECT * FROM conversations WHERE id = ? AND tenant_id = ? AND canal = 'site'").get(Number(m[1]), tenant.id);
  if (!conv || contact.vinculo_site_conv === conv.id) return;
  db.prepare('UPDATE contacts SET vinculo_site_conv = ? WHERE id = ?').run(conv.id, contact.id);
  contact.vinculo_site_conv = conv.id;
  const visitante = db.prepare('SELECT * FROM contacts WHERE id = ?').get(conv.contact_id);
  if (visitante?.nome && !contact.nome_confirmado) { db.prepare('UPDATE contacts SET nome = ?, nome_confirmado = 1 WHERE id = ?').run(visitante.nome, contact.id); contact.nome = visitante.nome; }
  // O negócio criado pelo site passa para o contato do WhatsApp (sem duplicar).
  const leadSite = db.prepare('SELECT * FROM leads WHERE tenant_id = ? AND contact_id = ?').get(tenant.id, conv.contact_id);
  const leadWa = db.prepare('SELECT 1 FROM leads WHERE tenant_id = ? AND contact_id = ?').get(tenant.id, contact.id);
  if (leadSite && !leadWa) db.prepare('UPDATE leads SET contact_id = ?, atualizado_em = datetime(\'now\') WHERE id = ?').run(contact.id, leadSite.id);
  if (leadSite) logActivity(tenant.id, leadSite.id, 'Cliente do chat do site continuou a conversa pelo WhatsApp.', { autor: 'sistema' });
}

// ---------- Limite simples por IP (protege contra robôs) ----------
const hits = new Map();
function limitar(chave, max, janelaMs) {
  const agora = Date.now(); const h = hits.get(chave) || [];
  const recentes = h.filter((t) => agora - t < janelaMs); recentes.push(agora); hits.set(chave, recentes);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => agora - t < janelaMs)) hits.delete(k);
  return recentes.length > max;
}
const cors = (res) => res.set({ 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Formulários ----------
const CAMPOS = {
  nome: /^(nome|name|your-name|nome_completo|full_?name|first_?name|contato)$/i,
  email: /^(e-?mail|your-email|mail)$/i,
  telefone: /^(telefone|phone|whatsapp|whats|celular|fone|tel|mobile|your-phone)$/i,
  empresa: /^(empresa|company|companhia|organiza[cç][aã]o)$/i,
  mensagem: /^(mensagem|message|your-message|msg|descri[cç][aã]o|observa[cç][oõ]es|assunto|comments?)$/i,
  consentimento: /^(consentimento|consent|aceite|aceito|lgpd|whatsapp_ok|autorizo|optin|opt_in)$/i,
};
function lerFormulario(body) {
  const dados = {}; const extras = {};
  for (const [k, v0] of Object.entries(body || {})) {
    if (/^_/.test(k) || /g-recaptcha|cf-turnstile|^h-captcha/i.test(k)) continue;
    const v = Array.isArray(v0) ? v0.join(', ') : String(v0 ?? '').trim();
    if (!v) continue;
    const campo = Object.keys(CAMPOS).find((c) => CAMPOS[c].test(k.trim()));
    if (campo && !dados[campo]) dados[campo] = v.slice(0, 2000); else extras[k.slice(0, 60)] = v.slice(0, 500);
  }
  if (!dados.telefone) { const t = Object.values(extras).map(telefoneNoTexto).find(Boolean); if (t) dados.telefone = t; }
  if (!dados.email) { const e = Object.values(extras).find((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)); if (e) dados.email = e; }
  return { dados, extras };
}
const consentiu = (v) => v != null && /^(1|on|true|sim|yes|s|aceito|ok|y)$/i.test(String(v).trim());

export async function receberFormulario(tenant, body, { pagina = null } = {}) {
  const { dados, extras } = lerFormulario(body);
  const fone = normalizarTelefone(dados.telefone);
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dados.email || '') ? dados.email.toLowerCase() : null;
  if (!fone && !email) throw new Error('Informe um WhatsApp ou e-mail para contato.');
  const chave = fone || `email_${email}`;
  db.prepare(`INSERT INTO contacts (tenant_id, telefone, nome) VALUES (?, ?, ?) ON CONFLICT(tenant_id, telefone) DO UPDATE SET nome = COALESCE(contacts.nome, excluded.nome)`)
    .run(tenant.id, chave, dados.nome || null);
  if (dados.nome) db.prepare('UPDATE contacts SET nome = ?, nome_confirmado = 1 WHERE tenant_id = ? AND telefone = ?').run(dados.nome, tenant.id, chave);
  const contact = db.prepare('SELECT * FROM contacts WHERE tenant_id = ? AND telefone = ?').get(tenant.id, chave);
  if (email) db.prepare('UPDATE contacts SET email = COALESCE(email, ?) WHERE id = ?').run(email, contact.id);

  const novo = !db.prepare('SELECT 1 FROM leads WHERE tenant_id = ? AND contact_id = ?').get(tenant.id, contact.id);
  const lead = garantirLead(tenant, contact, null);
  const resumo = (dados.mensagem || Object.values(extras).join(' · ') || 'Contato pelo formulário do site').slice(0, 300);
  db.prepare(`UPDATE leads SET origem = CASE WHEN ? THEN 'formulario' ELSE origem END, nome = COALESCE(nome, ?), email = COALESCE(email, ?),
    interesse = COALESCE(interesse, ?), atualizado_em = datetime('now') WHERE id = ?`).run(novo ? 1 : 0, dados.nome || null, email, resumo, lead.id);
  const linhas = [['Nome', dados.nome], ['WhatsApp/telefone', dados.telefone], ['E-mail', email], ['Empresa', dados.empresa], ['Mensagem', dados.mensagem],
    ...Object.entries(extras), ['Página', pagina]].filter(([, v]) => v);
  logActivity(tenant.id, lead.id, `📝 Formulário do site:\n${linhas.map(([k, v]) => `${k}: ${v}`).join('\n')}`, { autor: 'sistema' });

  // Resposta rápida: WhatsApp (com consentimento e modelo aprovado) ou e-mail de confirmação.
  let respondido = null;
  const assistente = tenant.nome_assistente || 'AVA';
  if (fone && tenant.form_whatsapp && consentiu(dados.consentimento) && tenant.status === 'ativo') {
    const params = [(dados.nome || '').split(' ')[0] || 'tudo bem', tenant.nome, resumo.slice(0, 120)];
    if (await enviarModelo(tenant, fone, 'ava_lead_formulario', params)) {
      // Abre a conversa no WhatsApp já com o pedido, para a IA continuar quando a pessoa responder.
      const r = db.prepare("INSERT INTO conversations (tenant_id, contact_id, canal) VALUES (?, ?, 'whatsapp')").run(tenant.id, contact.id);
      contarConversa(tenant.id, 'whatsapp');
      addMessage(r.lastInsertRowid, 'sistema', `Pedido recebido pelo formulário do site: ${resumo}`);
      addMessage(r.lastInsertRowid, 'ia', textoModelo('ava_lead_formulario', params));
      db.prepare('UPDATE leads SET conversation_id = ? WHERE id = ?').run(r.lastInsertRowid, lead.id);
      respondido = 'whatsapp';
    }
  }
  if (!respondido && email) {
    const r = await sendEmail(tenant, { to: email, subject: `Recebemos seu contato — ${tenant.nome}`,
      html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1d2433;max-width:560px"><p>Olá${dados.nome ? ', ' + esc(dados.nome.split(' ')[0]) : ''}!</p>
        <p>Recebemos sua mensagem${dados.mensagem ? ` sobre "<i>${esc(dados.mensagem.slice(0, 200))}</i>"` : ''} e vamos responder em breve.</p>
        ${whatsappDaEmpresa(tenant) ? `<p>Se preferir, fale agora com a ${esc(assistente)} no WhatsApp: <a href="https://wa.me/${whatsappDaEmpresa(tenant)}">clique aqui</a>.</p>` : ''}
        <p>${esc(tenant.nome)}</p></div>`, text: `Recebemos sua mensagem e vamos responder em breve. ${tenant.nome}` });
    if (!r?.erro) respondido = 'email';
  }
  if (!respondido) logActivity(tenant.id, lead.id, `Responder o formulário de ${dados.nome || email || fone}${fone ? ` (WhatsApp ${fone})` : ''}.`,
    { tipo: 'tarefa', autor: 'sistema', vence_em: new Date().toISOString().slice(0, 10) });

  // Avisos para a equipe.
  const aviso = `Novo formulário do site: ${dados.nome || 'sem nome'}${dados.empresa ? ` (${dados.empresa})` : ''} — ${resumo.slice(0, 120)}${respondido === 'whatsapp' ? '. A IA já chamou no WhatsApp.' : ''}`;
  if (tenant.telefone_responsavel) avisarEquipe(tenant, tenant.telefone_responsavel, aviso).catch(() => {});
  if (tenant.form_aviso_email) sendEmail(tenant, { to: tenant.form_aviso_email, subject: `Novo contato pelo site: ${dados.nome || email || fone}`,
    html: `<pre style="font-family:Arial,sans-serif;font-size:14px">${esc(linhas.map(([k, v]) => `${k}: ${v}`).join('\n'))}</pre>`, text: linhas.map(([k, v]) => `${k}: ${v}`).join('\n') }).catch(() => {});
  return { ok: true, lead_id: lead.id, respondido };
}

function paginaObrigado(tenant, voltar) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Recebemos seu contato</title>
<style>body{margin:0;font-family:Inter,system-ui,sans-serif;background:#F5F7FB;color:#0F1A2E;display:grid;place-items:center;min-height:100vh;padding:20px}.c{background:#fff;border:1px solid #E3E8F0;border-radius:16px;padding:32px;max-width:440px;text-align:center}a{color:#0B6E66}</style></head>
<body><main class="c"><div style="font-size:40px" aria-hidden="true">✅</div><h1 style="font-size:22px">Recebemos seu contato!</h1><p>A equipe da ${esc(tenant.nome)} vai responder em instantes.</p>${voltar ? `<p><a href="${esc(voltar)}">Voltar ao site</a></p>` : ''}</main></body></html>`;
}

function paginaFormulario(tenant) {
  const cor = /^#[0-9a-f]{6}$/i.test(tenant.webchat_cor || '') ? tenant.webchat_cor : '#12D8C4';
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fale com a ${esc(tenant.nome)}</title>
<style>*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,sans-serif;background:transparent;color:#0F1A2E}form{background:#fff;border:1px solid #E3E8F0;border-radius:16px;padding:24px;max-width:480px;margin:0 auto}
label{display:block;font-size:14px;font-weight:600;margin:12px 0 4px}input,textarea{width:100%;font:inherit;padding:11px 12px;border:1px solid #C9D3E6;border-radius:10px}textarea{min-height:96px}
input:focus,textarea:focus{outline:3px solid ${cor};outline-offset:1px}.ck{display:flex;gap:8px;align-items:flex-start;font-weight:400;font-size:13px;color:#5B6780}.ck input{width:auto;margin-top:2px}
button{margin-top:16px;width:100%;border:0;border-radius:10px;padding:13px;font:700 15px Inter,sans-serif;background:${cor};color:#06112A;cursor:pointer}.hp{position:absolute;left:-9999px}</style></head>
<body><form method="post" action="/f/${tokenCanal(tenant)}"><h1 style="font-size:20px;margin:0 0 4px">Fale com a ${esc(tenant.nome)}</h1><p style="margin:0;color:#5B6780;font-size:14px">Responderemos em instantes.</p>
<label for="f-nome">Nome</label><input id="f-nome" name="nome" autocomplete="name" required>
<label for="f-wa">WhatsApp</label><input id="f-wa" name="whatsapp" type="tel" inputmode="tel" autocomplete="tel" placeholder="(11) 90000-0000">
<label for="f-em">E-mail</label><input id="f-em" name="email" type="email" autocomplete="email">
<label for="f-msg">Como podemos ajudar?</label><textarea id="f-msg" name="mensagem" required></textarea>
<label class="ck"><input type="checkbox" name="consentimento" value="sim" checked> Aceito receber o retorno pelo WhatsApp.</label>
<input class="hp" name="_hp" tabindex="-1" autocomplete="off" aria-hidden="true">
<button type="submit">Enviar</button></form></body></html>`;
}

// ---------- Chat do site: script do balão ----------
function scriptWidget(tenant) {
  const cfg = {
    base: publicUrl(), token: tokenCanal(tenant),
    cor: /^#[0-9a-f]{6}$/i.test(tenant.webchat_cor || '') ? tenant.webchat_cor : '#12D8C4',
    titulo: tenant.webchat_titulo || `${tenant.nome_assistente || 'AVA'} · ${tenant.nome}`,
    saudacao: tenant.webchat_saudacao || `Oi! Sou a ${tenant.nome_assistente || 'AVA'}, da ${tenant.nome}. Como posso te ajudar?`,
    lado: tenant.webchat_lado === 'esquerda' ? 'left' : 'right',
    margem: Math.min(400, Math.max(0, Number(tenant.webchat_margem) || 20)),
  };
  return `(function(){if(window.__avaChat)return;window.__avaChat=1;var C=${JSON.stringify(cfg).replace(/</g, '\\u003c')};
try{var S=document.currentScript;if(S&&S.src)C.base=new URL(S.src).origin}catch(e){}
var K='ava_v_'+C.token,V;try{V=localStorage.getItem(K)}catch(e){}if(!V){V=Math.random().toString(36).slice(2)+Date.now().toString(36);try{localStorage.setItem(K,V)}catch(e){}}
var ult=0,aberto=false,poll=null,root=document.createElement('div');root.style.cssText='position:fixed;'+C.lado+':20px;bottom:'+C.margem+'px;z-index:2147483000';
var sh=root.attachShadow?root.attachShadow({mode:'open'}):root;document.body.appendChild(root);
sh.innerHTML='<style>*{box-sizing:border-box;font-family:Inter,system-ui,Arial,sans-serif}.b{width:60px;height:60px;border-radius:50%;border:0;background:'+C.cor+';color:#06112A;box-shadow:0 8px 24px rgba(6,17,42,.3);cursor:pointer;display:grid;place-items:center}.b:focus-visible,.s:focus-visible,.x:focus-visible{outline:3px solid #06112A;outline-offset:2px}'
+'.p{position:absolute;'+C.lado+':0;bottom:72px;width:min(370px,calc(100vw - 32px));height:min(540px,calc(100vh - '+(C.margem+92)+'px));background:#fff;border-radius:16px;box-shadow:0 16px 48px rgba(6,17,42,.35);display:none;flex-direction:column;overflow:hidden;color:#0F1A2E}.p.on{display:flex}'
+'.h{background:#06112A;color:#fff;padding:14px 16px;display:flex;align-items:center;gap:10px}.h b{font-size:15px;flex:1}.x{background:none;border:0;color:#fff;font-size:22px;cursor:pointer;line-height:1}'
+'.m{flex:1;overflow-y:auto;padding:14px;background:#F5F7FB;display:flex;flex-direction:column;gap:8px}.g{max-width:85%;padding:9px 12px;border-radius:12px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word}.g.c{align-self:flex-end;background:#1F6FFF;color:#fff}.g.i{align-self:flex-start;background:#fff;border:1px solid #E3E8F0}.g a{color:inherit}'
+'.wa{align-self:flex-start;background:#25D366;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:9px 14px;border-radius:999px}'
+'.f{display:flex;gap:8px;padding:10px;border-top:1px solid #E3E8F0}.f textarea{flex:1;resize:none;height:42px;border:1px solid #C9D3E6;border-radius:10px;padding:10px;font-size:14px}.s{border:0;border-radius:10px;background:'+C.cor+';color:#06112A;font-weight:700;padding:0 14px;cursor:pointer}'
+'.d{font-size:12px;color:#5B6780;align-self:flex-start}.ft{font-size:10px;text-align:center;color:#93A0B8;padding:0 0 6px;background:#fff}@media (max-width:480px){.p{bottom:70px}}</style>'
+'<div class="p" role="dialog" aria-label="Chat" aria-modal="false"><div class="h"><b></b><button class="x" aria-label="Fechar chat">×</button></div><div class="m" aria-live="polite"></div>'
+'<form class="f"><label style="position:absolute;left:-9999px" for="avaIn">Mensagem</label><textarea id="avaIn" placeholder="Escreva sua mensagem" maxlength="1500"></textarea><button class="s" type="submit">Enviar</button></form><div class="ft">atendimento com IA · AVA Connect</div></div>'
+'<button class="b" aria-label="Abrir chat" aria-expanded="false"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></button>';
var q=function(s){return sh.querySelector(s)},P=q('.p'),M=q('.m'),B=q('.b'),T=q('textarea');q('.h b').textContent=C.titulo;
function linkar(t){var d=document.createElement('div');d.textContent=t;return d.innerHTML.replace(/(https?:\\/\\/[^\\s<]+)/g,function(u){return /\\/a\\/f[0-9a-f]+\\/[^\\s]+\\.(jpg|png|webp)$/i.test(u)?'<a href="'+u+'" target="_blank" rel="noopener"><img src="'+u+'" alt="" style="max-width:100%;border-radius:8px;display:block;margin-top:4px"></a>':'<a href="'+u+'" target="_blank" rel="noopener">'+(/\\/a\\/f[0-9a-f]+\\//.test(u)?'Abrir arquivo':u)+'</a>'})}
function bolha(t,quem){var d=document.createElement('div');d.className='g '+quem;d.innerHTML=linkar(t);M.appendChild(d);M.scrollTop=M.scrollHeight}
function botaoWa(u){if(q('.wa'))return;var a=document.createElement('a');a.className='wa';a.href=u;a.target='_blank';a.rel='noopener';a.textContent='Continuar no WhatsApp';M.appendChild(a);M.scrollTop=M.scrollHeight}
function api(p,o){return fetch(C.base+'/api/w/'+C.token+p,o).then(function(r){return r.json()})}
function buscar(){api('/msgs?v='+V+'&depois='+ult).then(function(r){(r.mensagens||[]).forEach(function(m){ult=Math.max(ult,m.id);bolha(m.conteudo,m.autor==='cliente'?'c':'i')});if(r.whatsapp)botaoWa(r.whatsapp)}).catch(function(){})}
function abrir(v){aberto=v;P.classList.toggle('on',v);B.setAttribute('aria-expanded',v);if(v){if(!M.childNodes.length){bolha(C.saudacao,'i');buscar()}poll=setInterval(buscar,6000);setTimeout(function(){T.focus()},50)}else clearInterval(poll)}
B.onclick=function(){abrir(!aberto)};q('.x').onclick=function(){abrir(false);B.focus()};
T.onkeydown=function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();q('form').requestSubmit()}};
q('form').onsubmit=function(e){e.preventDefault();var t=T.value.trim();if(!t)return;T.value='';bolha(t,'c');var d=document.createElement('div');d.className='d';d.textContent='digitando…';M.appendChild(d);
api('/msg',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({v:V,texto:t,pagina:location.href})}).then(function(r){d.remove();if(r.erro){bolha(r.erro,'i');return}
(r.respostas||[]).forEach(function(x){bolha(x,'i')});if(r.ultimo_id)ult=Math.max(ult,r.ultimo_id);if(r.whatsapp)botaoWa(r.whatsapp)}).catch(function(){d.remove();bolha('Não consegui enviar agora. Tente de novo em instantes.','i')})};
})();`;
}

/** Link "continuar no WhatsApp" depois que o visitante deixou o número. */
function linkWhatsapp(tenant, conv, contact) {
  const num = whatsappDaEmpresa(tenant);
  if (!num || !contact?.whatsapp_informado) return null;
  return `https://wa.me/${num}?text=${encodeURIComponent(`Oi! Vim do site e quero continuar o atendimento. Código S${conv.id}`)}`;
}

// ---------- E-mail recebido ----------
function lerEmail(b) {
  const d = b?.data && typeof b.data === 'object' ? b.data : b || {};
  const deRaw = d.from?.email || d.from?.address || (Array.isArray(d.from) ? d.from[0]?.email || d.from[0] : d.from) || d.sender || d.From || '';
  const de = String(deRaw).match(/[^\s<>"]+@[^\s<>"]+\.[^\s<>"]+/)?.[0]?.toLowerCase();
  const nome = (typeof d.from === 'string' ? d.from.match(/^\s*"?([^"<]+?)"?\s*</)?.[1] : d.from?.name) || null;
  const assunto = d.subject || d.Subject || '';
  let texto = d.text || d['body-plain'] || d['stripped-text'] || d.plain || d.TextBody || '';
  if (!texto && (d.html || d['body-html'] || d.HtmlBody)) texto = String(d.html || d['body-html'] || d.HtmlBody).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ');
  texto = String(texto).split(/\n\s*(?:Em .{5,120} escreveu:|On .{5,120} wrote:|-{2,}\s*Original Message|_{5,})/i)[0].replace(/\n>.*$/gm, '').replace(/\s+\n/g, '\n').trim();
  return { de, nome, assunto, texto: texto.slice(0, 6000) };
}

// ---------- Rotas públicas ----------
export function rotasCanais(app) {
  const urlenc = express.urlencoded({ extended: true, limit: '200kb' });
  app.options(['/api/w/:tk/*', '/f/:tk'], (_req, res) => { cors(res); res.sendStatus(204); });

  app.get('/w/:arquivo', (req, res) => {
    const tk = String(req.params.arquivo).replace(/\.js$/, '');
    const t = tenantPorToken(tk);
    res.type('application/javascript').set('cache-control', 'public, max-age=300');
    if (!t || !t.webchat_ativo || t.status === 'cancelado') return res.send('/* AVA Connect: chat indisponível */');
    res.send(scriptWidget(t));
  });

  app.post('/api/w/:tk/msg', async (req, res) => {
    cors(res);
    const t = tenantPorToken(req.params.tk);
    if (!t || !t.webchat_ativo) return res.status(404).json({ erro: 'Chat indisponível.' });
    const v = String(req.body?.v || ''); const texto = String(req.body?.texto || '').trim().slice(0, 1500);
    if (!/^[a-z0-9]{8,40}$/.test(v) || !texto) return res.status(400).json({ erro: 'Mensagem inválida.' });
    if (limitar(`w:${req.ip}`, 30, 60e3) || limitar(`wv:${v}`, 12, 60e3)) return res.status(429).json({ erro: 'Muitas mensagens seguidas. Aguarde um instante.' });
    try {
      const chave = `site_${v}`;
      const r = await handleIncoming(t, { telefone: chave, texto, canal: 'site' });
      const contact = db.prepare('SELECT * FROM contacts WHERE tenant_id = ? AND telefone = ?').get(t.id, chave);
      const conv = r.conversation_id ? db.prepare('SELECT * FROM conversations WHERE id = ?').get(r.conversation_id) : null;
      // Visitante escreveu o WhatsApp: vira negócio no CRM e ganha o botão para continuar por lá.
      const fone = telefoneNoTexto(texto);
      if (fone && contact && conv && contact.whatsapp_informado !== fone) {
        db.prepare('UPDATE contacts SET whatsapp_informado = ? WHERE id = ?').run(fone, contact.id); contact.whatsapp_informado = fone;
        const novo = !db.prepare('SELECT 1 FROM leads WHERE tenant_id = ? AND contact_id = ?').get(t.id, contact.id);
        const lead = garantirLead(t, contact, conv);
        if (novo) db.prepare("UPDATE leads SET origem = 'site' WHERE id = ?").run(lead.id);
        logActivity(t.id, lead.id, `Visitante do chat do site informou o WhatsApp ${fone}${req.body?.pagina ? ` (página: ${String(req.body.pagina).slice(0, 200)})` : ''}.`, { autor: 'sistema' });
      }
      const ultimo = conv ? db.prepare('SELECT MAX(id) AS id FROM messages WHERE conversation_id = ?').get(conv.id).id : 0;
      res.json({ respostas: r.respostas || [], ultimo_id: ultimo, whatsapp: conv ? linkWhatsapp(t, conv, contact) : null });
    } catch (e) { console.error('[webchat]', e.message); res.status(500).json({ erro: 'Não consegui responder agora. Tente de novo em instantes.' }); }
  });

  app.get('/api/w/:tk/msgs', (req, res) => {
    cors(res);
    const t = tenantPorToken(req.params.tk);
    const v = String(req.query.v || '');
    if (!t || !/^[a-z0-9]{8,40}$/.test(v)) return res.json({ mensagens: [] });
    const contact = db.prepare('SELECT * FROM contacts WHERE tenant_id = ? AND telefone = ?').get(t.id, `site_${v}`);
    if (!contact) return res.json({ mensagens: [] });
    const conv = db.prepare("SELECT * FROM conversations WHERE contact_id = ? AND canal = 'site' ORDER BY id DESC LIMIT 1").get(contact.id);
    if (!conv) return res.json({ mensagens: [] });
    const depois = Number(req.query.depois) || 0;
    const mensagens = db.prepare(`SELECT id, autor, conteudo FROM messages WHERE conversation_id = ? AND id > ? AND autor IN ('cliente','ia','humano')
      ORDER BY id DESC LIMIT 50`).all(conv.id, depois).reverse();
    res.json({ mensagens, whatsapp: linkWhatsapp(t, conv, contact) });
  });

  // Formulários: qualquer site pode enviar para cá (action="https://.../f/TOKEN").
  app.get('/f/:tk', (req, res) => {
    const t = tenantPorToken(req.params.tk);
    if (!t) return res.status(404).send('Formulário não encontrado.');
    res.type('html').send(paginaFormulario(t));
  });
  app.post('/f/:tk', urlenc, async (req, res) => {
    cors(res);
    const t = tenantPorToken(req.params.tk);
    const querJson = /json/.test(req.get('accept') || '') || /json/.test(req.get('content-type') || '');
    if (!t || t.status === 'cancelado') return res.status(404).json({ erro: 'Formulário não encontrado.' });
    const body = req.body || {};
    const voltar = /^https?:\/\//.test(body._next || body._redirect || '') ? String(body._next || body._redirect) : (req.get('referer') || null);
    // Robô preencheu o campo escondido: finge sucesso e descarta.
    if (body._hp || body._gotcha) return querJson ? res.json({ ok: true }) : res.type('html').send(paginaObrigado(t, voltar));
    if (limitar(`f:${req.ip}`, 8, 10 * 60e3)) return res.status(429).json({ erro: 'Muitos envios seguidos. Tente mais tarde.' });
    try {
      const r = await receberFormulario(t, body, { pagina: req.get('referer') || null });
      if (querJson) return res.json(r);
      if (/^https?:\/\//.test(body._next || body._redirect || '')) return res.redirect(303, voltar);
      res.type('html').send(paginaObrigado(t, voltar));
    } catch (e) { res.status(400).json({ erro: e.message }); }
  });

  // E-mail: o provedor de e-mail (Cloudflare Email Routing, Mailgun, Postmark, Resend...) envia cada mensagem recebida para cá.
  app.post('/inbound/email/:tk', urlenc, async (req, res) => {
    const t = tenantPorToken(req.params.tk);
    if (!t) return res.sendStatus(404);
    const { de, nome, assunto, texto } = lerEmail(req.body);
    if (!de || !texto) return res.json({ ok: false, motivo: 'sem remetente ou texto' });
    if (/no-?reply|mailer-daemon|postmaster|notifica/i.test(de) || de.endsWith('@resend.dev')) return res.json({ ok: false, motivo: 'remetente automático' });
    if (limitar(`e:${de}`, 10, 60 * 60e3)) return res.json({ ok: false, motivo: 'limite' });
    res.json({ ok: true }); // responde já; a IA trabalha em seguida
    try {
      const chave = `email_${de}`;
      const r = await handleIncoming(t, { telefone: chave, nome, texto: `${assunto ? `Assunto: ${assunto}\n` : ''}${texto}`, canal: 'email' });
      db.prepare('UPDATE contacts SET email = COALESCE(email, ?) WHERE tenant_id = ? AND telefone = ?').run(de, t.id, chave);
      const corpo = (r.respostas || []).join('\n\n').trim();
      if (corpo) await sendEmail(t, { to: de, subject: /^re:/i.test(assunto) ? assunto : `Re: ${assunto || `Contato com ${t.nome}`}`,
        html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1d2433;max-width:600px;white-space:pre-wrap">${esc(corpo)}</div>`, text: corpo });
    } catch (e) { console.error('[email-inbound]', e.message); }
  });
}

// ---------- Painel: configuração dos canais ----------
export function canaisRouter(canSee) {
  const r = express.Router();
  const podeConfig = (req) => req.user.admin || ['dono', 'gestor'].includes(req.user.papel);
  const dadosCanais = (t) => {
    const base = publicUrl(); const tk = tokenCanal(t);
    return {
      token: tk, webchat_ativo: !!t.webchat_ativo, webchat_cor: t.webchat_cor, webchat_titulo: t.webchat_titulo || '', webchat_saudacao: t.webchat_saudacao || '', webchat_lado: t.webchat_lado || 'direita', webchat_margem: t.webchat_margem ?? 20,
      form_whatsapp: !!t.form_whatsapp, form_aviso_email: t.form_aviso_email || '',
      codigo_chat: `<script src="${base}/w/${tk}.js" async></script>`,
      form_url: `${base}/f/${tk}`, email_webhook: `${base}/inbound/email/${tk}`,
      exemplo_form: `<form action="${base}/f/${tk}" method="post">\n  <input name="nome" placeholder="Nome" required>\n  <input name="whatsapp" placeholder="WhatsApp">\n  <input name="email" type="email" placeholder="E-mail">\n  <textarea name="mensagem" placeholder="Mensagem"></textarea>\n  <label><input type="checkbox" name="consentimento" value="sim" checked> Aceito receber o retorno pelo WhatsApp</label>\n  <input name="_hp" style="display:none" tabindex="-1" autocomplete="off">\n  <button>Enviar</button>\n</form>`,
      uso_mes: db.prepare("SELECT conversas_canais FROM usage WHERE tenant_id = ? AND mes = strftime('%Y-%m','now')").get(t.id)?.conversas_canais || 0,
    };
  };
  r.get('/tenants/:id/canais', (req, res) => {
    if (!canSee(req, req.params.id)) return res.sendStatus(403);
    const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
    if (!t) return res.sendStatus(404);
    res.json(dadosCanais(t));
  });
  r.put('/tenants/:id/canais', express.json(), (req, res) => {
    if (!canSee(req, req.params.id) || !podeConfig(req)) return res.status(403).json({ erro: 'Sem permissão para esta ação' });
    const b = req.body || {};
    if (b.webchat_cor && !/^#[0-9a-f]{6}$/i.test(b.webchat_cor)) return res.status(400).json({ erro: 'Cor inválida.' });
    if (b.form_aviso_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.form_aviso_email)) return res.status(400).json({ erro: 'E-mail de aviso inválido.' });
    const sets = []; const vals = [];
    for (const [k, conv] of [['webchat_ativo', (v) => (v ? 1 : 0)], ['webchat_cor', String], ['webchat_titulo', (v) => String(v).slice(0, 60) || null],
      ['webchat_saudacao', (v) => String(v).slice(0, 300) || null], ['webchat_lado', (v) => (v === 'esquerda' ? 'esquerda' : 'direita')],
      ['webchat_margem', (v) => Math.min(400, Math.max(0, Math.round(Number(v) || 20)))], ['form_whatsapp', (v) => (v ? 1 : 0)], ['form_aviso_email', (v) => String(v).trim() || null]]) {
      if (b[k] !== undefined) { sets.push(`${k} = ?`); vals.push(conv(b[k])); }
    }
    if (sets.length) db.prepare(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`).run(...vals, req.params.id);
    res.json(dadosCanais(db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id)));
  });
  return r;
}

/** Token do chat da própria Avantte (para o balão no site do AVA). */
export function tokenChatAvantte() {
  const avt = db.prepare("SELECT * FROM tenants WHERE nome LIKE 'Avantte%' COLLATE NOCASE ORDER BY id LIMIT 1").get();
  return avt && avt.webchat_ativo ? tokenCanal(avt) : null;
}
