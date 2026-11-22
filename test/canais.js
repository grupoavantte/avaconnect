// Teste dos canais além do WhatsApp: chat no site, formulários e e-mail (APIs externas simuladas).
process.env.DB_PATH = `/tmp/ava-canais-${Date.now()}.db`;
process.env.ANTHROPIC_API_KEY = 'teste';
process.env.RESEND_API_KEY = 're_teste';
const realFetch = globalThis.fetch;
const fila = []; const claude = []; const wa = []; const emails = [];
const json = (d, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => d, headers: new Map() });
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  if (url.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  if (url.includes('api.anthropic.com')) { claude.push(JSON.parse(opts.body)); return json(fila.shift() || { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Claro! Como posso ajudar?' }] }); }
  if (url.includes('graph.facebook.com')) { wa.push(JSON.parse(opts.body)); return json({ messages: [{ id: 'wamid.' + wa.length }] }); }
  if (url.includes('api.resend.com')) { emails.push(JSON.parse(opts.body)); return json({ id: 'em_' + emails.length }); }
  throw new Error('URL inesperada ' + url);
};
const fala = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });

const http = await import('node:http');
const express = (await import('express')).default;
const { db } = await import('../src/db.js');
const { criarAgente } = await import('../src/agents.js');
const { handleIncoming } = await import('../src/engine.js');
const { rotasCanais, canaisRouter, normalizarTelefone, telefoneNoTexto, tokenCanal } = await import('../src/canais.js');
const { MODELOS } = await import('../src/modelos.js');
let ok = 0;
const check = (c, m) => { if (!c) { console.error('FALHOU:', m); process.exit(1); } ok++; console.log('ok -', m); };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const tid = db.prepare(`INSERT INTO tenants (nome, plano, painel_token, wa_phone_number_id, wa_token, telefone_responsavel, vendas_ativo)
  VALUES ('Embalagens Sul', 'profissional', 'tk', 'PN1', 'tok', '5511999990000', 1)`).run().lastInsertRowid;
criarAgente(tid, { modelo: 'vendas', nome: 'AVA' });
db.prepare("INSERT INTO whatsapp_numbers (tenant_id, telefone, principal, phone_number_id) VALUES (?, '5511988880000', 1, 'PN1')").run(tid);
const T = () => db.prepare('SELECT * FROM tenants WHERE id = ?').get(tid);
const tk = tokenCanal(T());

const app = express(); app.set('trust proxy', true); app.use(express.json());
rotasCanais(app);
app.use('/api', (req, _res, next) => { req.user = { admin: false, papel: 'dono', tenantId: tid }; next(); }, canaisRouter((req, id) => Number(id) === tid));
const srv = http.createServer(app).listen(0); await espera(50);
const BASE = `http://127.0.0.1:${srv.address().port}`;
const post = (p, body, headers = { 'content-type': 'application/json' }) => fetch(BASE + p, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual' });

// ---- utilitários ----
check(normalizarTelefone('(11) 98888-7777') === '5511988887777' && normalizarTelefone('abc') === null, 'normaliza telefone brasileiro');
check(telefoneNoTexto('pode chamar no 11 98888-7777 por favor') === '5511988887777', 'acha o WhatsApp no meio do texto');
check(MODELOS.some((m) => m.chave === 'ava_lead_formulario' && m.categoria === 'UTILITY'), 'modelo Meta para responder formulário');

// ---- chat no site ----
const js = await fetch(`${BASE}/w/${tk}.js`).then((r) => r.text());
check(js.includes(tk) && js.includes('attachShadow') && js.includes('Embalagens Sul'), 'script do balão com o nome da empresa');
check((await fetch(`${BASE}/w/cinvalido1.js`).then((r) => r.text())).includes('indisponível'), 'token inválido não carrega o chat');
const V = 'visitante12345';
fila.push(fala('Oi! Fazemos sim. Quantas unidades você precisa?'));
let r = await post(`/api/w/${tk}/msg`, { v: V, texto: 'Vocês fazem caixa personalizada?', pagina: 'https://loja.com/produtos' }).then((x) => x.json());
check(r.respostas[0].includes('Quantas unidades') && !r.whatsapp, 'IA responde no chat do site');
check(claude.at(-1).system.includes('chat no site') || JSON.stringify(claude.at(-1)).includes('chat no site'), 'IA sabe que está no chat do site');
const convSite = db.prepare("SELECT * FROM conversations WHERE canal = 'site'").get();
check(convSite && db.prepare("SELECT conversas, conversas_canais FROM usage WHERE tenant_id = ?").get(tid).conversas_canais === 1, 'conversa do site conta à parte do limite do WhatsApp');
check(!wa.length, 'nada é enviado por WhatsApp para visitante do site');
fila.push(fala('Perfeito! Vou preparar a proposta.'));
r = await post(`/api/w/${tk}/msg`, { v: V, texto: 'Sou o Carlos, meu whats é (11) 97777-6666' }).then((x) => x.json());
check(r.whatsapp && r.whatsapp.includes('wa.me/5511988880000') && r.whatsapp.includes(`S${convSite.id}`), 'deixou o WhatsApp: botão para continuar no WhatsApp com código');
const leadSite = db.prepare("SELECT * FROM leads WHERE tenant_id = ? AND origem = 'site'").get(tid);
check(leadSite, 'visitante vira negócio no CRM com origem "site"');
// atendente responde pelo painel: aparece no balão
db.prepare("INSERT INTO messages (conversation_id, autor, conteudo) VALUES (?, 'humano', 'Oi Carlos, aqui é a Ana!')").run(convSite.id);
const novas = await fetch(`${BASE}/api/w/${tk}/msgs?v=${V}&depois=${r.ultimo_id}`).then((x) => x.json());
check(novas.mensagens.length === 1 && novas.mensagens[0].conteudo.includes('Ana'), 'resposta do atendente chega no chat do site');
check((await post(`/api/w/${tk}/msg`, { v: 'x', texto: 'oi' })).status === 400, 'visitante inválido recusado');

// continua no WhatsApp com o código
fila.push(fala('Oi Carlos! Continuando: são 1.000 caixas?'));
await handleIncoming(T(), { telefone: '5511977776666', texto: `Oi! Vim do site e quero continuar o atendimento. Código S${convSite.id}`, canal: 'whatsapp' });
const cWa = db.prepare("SELECT * FROM contacts WHERE telefone = '5511977776666'").get();
check(cWa.vinculo_site_conv === convSite.id && JSON.stringify(claude.at(-1)).includes('veio do chat do site'), 'WhatsApp com código puxa a conversa do site para a IA');
check(db.prepare('SELECT contact_id FROM leads WHERE id = ?').get(leadSite.id).contact_id === cWa.id, 'negócio do site passa para o contato do WhatsApp');

// ---- formulários ----
db.prepare("UPDATE tenants SET form_aviso_email = 'vendas@embalagens.com' WHERE id = ?").run(tid);
let f = await post(`/f/${tk}`, { name: 'Maria Lima', phone: '(21) 96666-5555', email: 'maria@x.com', message: 'Orçamento de 500 caixas', consentimento: 'sim', cidade: 'Niterói' }).then((x) => x.json());
const cMaria = db.prepare("SELECT * FROM contacts WHERE telefone = '5521966665555'").get();
const leadMaria = db.prepare('SELECT * FROM leads WHERE contact_id = ?').get(cMaria.id);
check(f.ok && leadMaria.origem === 'formulario' && leadMaria.email === 'maria@x.com' && leadMaria.interesse.includes('500 caixas'), 'formulário vira negócio com os dados certos');
check(db.prepare('SELECT descricao FROM activities WHERE lead_id = ?').all(leadMaria.id).some((a) => a.descricao.includes('Niterói')), 'campos extras do formulário ficam no histórico');
check(f.respondido === 'email' && emails.some((e) => e.to[0] === 'maria@x.com'), 'sem modelo aprovado: responde por e-mail');
check(emails.some((e) => e.to[0] === 'vendas@embalagens.com') && wa.some((w) => w.to === '5511999990000'), 'equipe avisada por e-mail e WhatsApp');
// com o modelo aprovado: responde no WhatsApp
db.prepare("INSERT INTO tenant_templates (tenant_id, chave, status) VALUES (?, 'ava_lead_formulario', 'APPROVED')").run(tid);
wa.length = 0;
f = await post(`/f/${tk}`, 'nome=Jo%C3%A3o+Paz&whatsapp=21955554444&mensagem=Quero+saber+o+pre%C3%A7o&consentimento=on', { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }).then((x) => x.json());
check(f.respondido === 'whatsapp' && wa.some((w) => w.type === 'template' && w.to === '5521955554444' && w.template.name === 'ava_lead_formulario'), 'com consentimento e modelo aprovado: IA chama no WhatsApp em segundos');
fila.push(fala('Claro, João! O preço depende da quantidade.'));
await handleIncoming(T(), { telefone: '5521955554444', texto: 'Sim, pode continuar', canal: 'whatsapp' });
check(JSON.stringify(claude.at(-1)).includes('Quero saber o preço'), 'quando a pessoa responde, a IA já sabe o que ela pediu no formulário');
wa.length = 0;
f = await post(`/f/${tk}`, { nome: 'Sem Aceite', whatsapp: '21944443333', mensagem: 'oi' }).then((x) => x.json());
check(f.respondido !== 'whatsapp' && !wa.some((w) => w.to === '5521944443333'), 'sem consentimento não manda WhatsApp');
const red = await post(`/f/${tk}`, 'nome=Ana&email=ana%40x.com&mensagem=oi&_next=https%3A%2F%2Floja.com%2Fobrigado', { 'content-type': 'application/x-www-form-urlencoded' });
check(red.status === 303 && red.headers.get('location') === 'https://loja.com/obrigado', 'formulário HTML volta para a página de obrigado do site');
const html = await post(`/f/${tk}`, 'nome=Bia&email=bia%40x.com&mensagem=oi', { 'content-type': 'application/x-www-form-urlencoded' }).then((x) => x.text());
check(html.includes('Recebemos seu contato'), 'sem página própria: mostra página de obrigado');
const antes = db.prepare('SELECT COUNT(*) n FROM leads').get().n;
await post(`/f/${tk}`, { nome: 'Robo', email: 'r@x.com', _hp: 'spam' });
check(db.prepare('SELECT COUNT(*) n FROM leads').get().n === antes, 'robô (campo escondido preenchido) é descartado');
check((await post(`/f/${tk}`, { nome: 'Sem contato', mensagem: 'oi' })).status === 400, 'formulário sem WhatsApp nem e-mail é recusado');
check((await fetch(`${BASE}/f/${tk}`).then((x) => x.text())).includes(`/f/${tk}`), 'formulário pronto hospedado pelo AVA');

// ---- e-mail ----
emails.length = 0;
fila.push(fala('Olá, Pedro! Temos sim. Para quantas unidades seria?'));
const e = await post(`/inbound/email/${tk}`, { from: 'Pedro Alves <pedro@cliente.com>', subject: 'Cotação de caixas', text: 'Bom dia, vocês têm caixa 30x20?\n\nEm seg., 10 de nov. escreveu:\n> mensagem antiga' }).then((x) => x.json());
await espera(150);
const convEmail = db.prepare("SELECT * FROM conversations WHERE canal = 'email'").get();
check(e.ok && convEmail, 'e-mail recebido vira conversa');
check(!JSON.stringify(claude.at(-1)).includes('mensagem antiga') && JSON.stringify(claude.at(-1)).includes('sem emojis'), 'IA lê só a mensagem nova e responde no formato de e-mail');
check(emails.some((m) => m.to[0] === 'pedro@cliente.com' && m.subject === 'Re: Cotação de caixas' && m.text.includes('quantas unidades')), 'IA responde o e-mail');
check((await post(`/inbound/email/${tk}`, { from: 'noreply@banco.com', subject: 'x', text: 'y' }).then((x) => x.json())).ok === false, 'e-mail automático (noreply) é ignorado');

// ---- painel ----
const cfg = await fetch(`${BASE}/api/tenants/${tid}/canais`).then((x) => x.json());
check(cfg.codigo_chat.includes(`/w/${tk}.js`) && cfg.form_url.endsWith(`/f/${tk}`) && cfg.email_webhook.includes('/inbound/email/'), 'painel mostra código do chat, formulário e e-mail');
const put = await fetch(`${BASE}/api/tenants/${tid}/canais`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ webchat_cor: '#1F6FFF', webchat_saudacao: 'Olá! Quer um orçamento?' }) }).then((x) => x.json());
check(put.webchat_cor === '#1F6FFF' && (await fetch(`${BASE}/w/${tk}.js`).then((x) => x.text())).includes('Quer um orçamento'), 'cor e saudação do chat salvas');
check((await fetch(`${BASE}/api/tenants/${tid}/canais`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ webchat_cor: 'vermelho' }) })).status === 400, 'cor inválida recusada');

srv.close();
console.log(`\n${ok} verificações dos canais (site, formulário, e-mail) passaram.`);
process.exit(0);
