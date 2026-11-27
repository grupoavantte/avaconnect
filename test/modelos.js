// Teste dos modelos da Meta (biblioteca, envio para aprovação, uso fora das 24h) e de quem vê quais conversas.
process.env.DB_PATH = `/tmp/ava-mod-${Date.now()}.db`;
const graph = []; const enviados = [];
const json = (d, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => d, headers: new Map() });
const statusMeta = {};
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  if (!url.includes('graph.facebook.com')) throw new Error('URL inesperada ' + url);
  const body = opts.body ? JSON.parse(opts.body) : null;
  graph.push({ url, method: opts.method || 'GET', body });
  if (url.includes('/message_templates') && opts.method === 'POST') {
    if (body.name === 'mkt_pos_venda') return json({ error: { message: 'Message template already exists' } }, false);
    statusMeta[body.name] = 'PENDING'; return json({ id: 'tpl_' + body.name, status: 'PENDING', category: body.category });
  }
  if (url.includes('/message_templates')) return json({ data: Object.entries(statusMeta).map(([name, status]) => ({ name, status, category: 'UTILITY', id: 'tpl_' + name, rejected_reason: 'NONE' })) });
  if (url.includes('/messages')) { enviados.push(body); return json({ messages: [{ id: 'w' + enviados.length }] }); }
  return json({});
};

const { db } = await import('../src/db.js');
const { MODELOS, enviarParaAprovacao, sincronizarModelos, listaModelos, avisarEquipe, componentes, validarModeloProprio, criarModeloProprio, listaProprios } = await import('../src/modelos.js');
const { enviarAoCliente } = await import('../src/vendas.js');
const { filtroConversas, podeVerConversa } = await import('../src/operacao.js');
let ok = 0;
const check = (c, m) => { if (!c) { console.error('FALHOU:', m); process.exit(1); } ok++; console.log('ok -', m); };

// ---- Biblioteca ----
const vars = (c) => (c.match(/\{\{(\d+)\}\}/g) || []).map((x) => Number(x.slice(2, -2)));
check(MODELOS.length >= 18 && new Set(MODELOS.map((m) => m.chave)).size === MODELOS.length, `${MODELOS.length} modelos, nomes únicos`);
check(MODELOS.every((m) => /^[a-z0-9_]+$/.test(m.chave)), 'nomes no padrão da Meta (minúsculas e _)');
check(MODELOS.every((m) => !/^\s*\{\{/.test(m.corpo) && !/\{\{\d+\}\}\s*$/.test(m.corpo)), 'nenhum texto começa ou termina com variável');
check(MODELOS.every((m) => vars(m.corpo).every((n, i) => n === i + 1) && vars(m.corpo).length === m.exemplo.length), 'variáveis em sequência e com exemplo');
check(MODELOS.filter((m) => m.categoria === 'MARKETING').every((m) => m.corpo.includes('SAIR')), 'modelos de marketing ensinam a sair da lista');
check(['Atendimento', 'Vendas', 'Agenda', 'Equipe', 'AvaShop', 'Campanhas'].every((f) => MODELOS.some((m) => m.fase === f)), 'cobre todas as fases da AVA e do AvaShop');
check(componentes(MODELOS.find((m) => m.chave === 'ava_lembrete_reuniao')).some((c) => c.type === 'BUTTONS'), 'botões de resposta rápida');

// ---- Envio para aprovação ----
const tid = db.prepare("INSERT INTO tenants (nome, plano, painel_token, wa_phone_number_id, wa_token, nome_assistente, telefone_responsavel) VALUES ('Moda Sul', 'profissional', 'tk', 'PN1', 'tok', 'AVA', '5524999990000')").run().lastInsertRowid;
check((await enviarParaAprovacao(tid)).erro?.includes('Conecte'), 'sem conta da Meta: pede para conectar');
db.prepare("INSERT INTO whatsapp_numbers (tenant_id, nome, phone_number_id, waba_id, token, principal) VALUES (?, 'Principal', 'PN1', 'WABA9', 'tok', 1)").run(tid);
const r = await enviarParaAprovacao(tid);
const posts = graph.filter((g) => g.method === 'POST' && g.url.includes('WABA9/message_templates'));
check(posts.length === MODELOS.length && posts[0].body.language === 'pt_BR' && posts[0].body.components[0].example.body_text[0].length, 'todos enviados para a conta da empresa, em pt_BR e com exemplos');
check(r.enviados.find((x) => x.chave === 'mkt_pos_venda').status === 'existente', 'modelo que já existe na conta passa a ser acompanhado');
check(listaModelos(tid).filter((m) => m.status === 'PENDING').length === MODELOS.length - 1, 'status "em análise" registrado');
const antes = posts.length;
await enviarParaAprovacao(tid);
check(graph.filter((g) => g.method === 'POST' && g.url.includes('message_templates')).length === antes, 'não reenvia o que já foi enviado');
for (const k of ['ava_lembrete_pagamento', 'ava_retomar_atendimento', 'ava_alerta_equipe']) statusMeta[k] = 'APPROVED';
await sincronizarModelos(tid);
check(listaModelos(tid).find((m) => m.chave === 'ava_lembrete_pagamento').status === 'APPROVED', 'aprovação lida da Meta');

// ---- Uso fora da janela de 24h ----
const tenant = () => db.prepare('SELECT * FROM tenants WHERE id = ?').get(tid);
const ct = db.prepare("INSERT INTO contacts (tenant_id, telefone, nome) VALUES (?, '5524911112222', 'Maria Souza')").run(tid).lastInsertRowid;
const cv = db.prepare("INSERT INTO conversations (tenant_id, contact_id, canal) VALUES (?, ?, 'whatsapp')").run(tid, ct).lastInsertRowid;
db.prepare("INSERT INTO messages (conversation_id, autor, conteudo, criado_em) VALUES (?, 'cliente', 'oi', datetime('now', '-3 days'))").run(cv);
const contato = db.prepare('SELECT * FROM contacts WHERE id = ?').get(ct);
let res = await enviarAoCliente(tenant(), contato, 'Lembrete livre', { modelo: { chave: 'ava_lembrete_pagamento', params: ['Maria', 'R$ 100,00', 'Proposta nº 3', 'https://pag.link/x'] } });
let t = enviados.at(-1);
check(res === 'modelo' && t.template.name === 'ava_lembrete_pagamento' && t.template.components[0].parameters[3].text === 'https://pag.link/x', 'fora das 24h usa o modelo da fase (lembrete de pagamento)');
check(db.prepare("SELECT conteudo FROM messages WHERE conversation_id = ? ORDER BY id DESC").get(cv).conteudo.includes('Lembrete do pagamento de R$ 100,00'), 'histórico guarda o texto que o cliente recebeu');
res = await enviarAoCliente(tenant(), contato, 'Seu pedido saiu', { modelo: { chave: 'shop_pedido_enviado', params: ['Maria', '1042', 'BR1'] } });
check(res === 'modelo' && enviados.at(-1).template.name === 'ava_retomar_atendimento', 'modelo da fase ainda não aprovado: usa o de retomada');
statusMeta.ava_retomar_atendimento = 'PAUSED'; await sincronizarModelos(tid);
db.prepare("UPDATE messages SET criado_em = datetime('now', '-3 days') WHERE conversation_id = ?").run(cv);
res = await enviarAoCliente(tenant(), contato, 'Oi!', {});
check(res === 'tarefa', 'sem modelo aprovado: vira tarefa para a equipe');
await avisarEquipe(tenant(), '5524999990000', 'Maria precisa de atendimento.\nSetor: Financeiro');
t = enviados.at(-1);
check(t.template?.name === 'ava_alerta_equipe' && !t.template.components[0].parameters[1].text.includes('\n'), 'aviso para a equipe usa o modelo (sem quebra de linha nos parâmetros)');

// ---- Quem vê quais conversas ----
const u = (nome, papel, ver, setores) => db.prepare('INSERT INTO users (tenant_id, nome, email, papel, ver_conversas, setores) VALUES (?, ?, ?, ?, ?, ?)')
  .run(tid, nome, nome + '@x.com', papel, ver, setores ? JSON.stringify(setores) : null).lastInsertRowid;
const ana = u('ana', 'atendente', 'minhas'), bia = u('bia', 'atendente', 'setor', ['Financeiro']), dono = u('dono', 'dono', 'minhas');
const conv = (setor, atendente, resp = null) => {
  const c = db.prepare("INSERT INTO contacts (tenant_id, telefone, responsavel_id) VALUES (?, ?, ?)").run(tid, String(Math.random()).slice(2, 14), resp).lastInsertRowid;
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(db.prepare("INSERT INTO conversations (tenant_id, contact_id, status, setor, atendente_id) VALUES (?, ?, 'humano', ?, ?)").run(tid, c, setor, atendente).lastInsertRowid);
};
const daAna = conv('Vendas', ana), fin = conv('Financeiro', null), vendas = conv('Vendas', null), carteiraAna = conv(null, null, ana);
const U = (id) => ({ userId: id });
check(podeVerConversa(U(ana), daAna) && podeVerConversa(U(ana), carteiraAna) && !podeVerConversa(U(ana), fin), '"Só as dela": atribuídas a ela ou da carteira dela');
check(podeVerConversa(U(bia), fin) && !podeVerConversa(U(bia), vendas) && !podeVerConversa(U(bia), daAna), '"Do setor": só Financeiro');
check(podeVerConversa(U(dono), fin) && podeVerConversa({ admin: true }, fin), 'dono e plataforma veem tudo');
const lista = (id) => { const f = filtroConversas(U(id)); return db.prepare(`SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.tenant_id = ? ${f.sql}`).all(tid, ...f.args).map((x) => x.id); };
check(lista(ana).sort().join() === [daAna.id, carteiraAna.id].sort().join() && lista(bia).join() === String(fin.id), 'lista de conversas filtrada no banco');

// ---- Modelos criados pela empresa ----
check(validarModeloProprio({ nome: 'Com Espaço', categoria: 'UTILITY', corpo: 'Olá, tudo certo por aqui?' }).erro, 'nome fora do padrão recusado');
check(validarModeloProprio({ nome: 'ava_lembrete_reuniao', categoria: 'UTILITY', corpo: 'Olá, tudo certo por aqui?' }).erro, 'não sobrescreve modelo padrão');
check(validarModeloProprio({ nome: 'teste_ok', categoria: 'UTILITY', corpo: 'Olá {{1}}, pedido {{3}} saiu.', exemplos: ['a', 'b', 'c'] }).erro?.includes('{{2}}'), 'variáveis fora de sequência recusadas');
check(validarModeloProprio({ nome: 'teste_ok', categoria: 'UTILITY', corpo: 'Olá {{1}}, recebemos sua mensagem.', exemplos: [] }).erro?.includes('exemplo'), 'exige exemplo das variáveis');
const cp = await criarModeloProprio(tid, { nome: 'confirmacao_atendimento', categoria: 'UTILITY', corpo: 'Olá {{1}}, recebemos sua mensagem e já vamos te atender.', exemplos: ['Maria'] });
const envio = graph.filter((g) => g.method === 'POST' && g.body?.name === 'confirmacao_atendimento').at(-1);
check(cp.ok && envio?.url.includes('/WABA9/message_templates') && envio.body.components[0].example.body_text[0][0] === 'Maria', 'modelo próprio enviado para a Meta com exemplo');
statusMeta.confirmacao_atendimento = 'APPROVED'; await sincronizarModelos(tid);
check(listaProprios(tid)[0].status === 'APPROVED', 'status do modelo próprio sincronizado');
check((await criarModeloProprio(tid, { nome: 'confirmacao_atendimento', categoria: 'UTILITY', corpo: 'Olá {{1}}, recebemos sua mensagem.', exemplos: ['Maria'] })).erro, 'nome repetido recusado');

// ---- CRM: todos os negócios ou só os dela ----
const { filtroLeads, podeVerLead } = await import('../src/operacao.js');
db.prepare("UPDATE users SET ver_negocios = 'meus' WHERE id IN (?, ?)").run(ana, dono);
const lead = (resp, carteira = null) => { const c = db.prepare('INSERT INTO contacts (tenant_id, telefone, responsavel_id) VALUES (?, ?, ?)').run(tid, String(Math.random()).slice(2, 14), carteira).lastInsertRowid;
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(db.prepare("INSERT INTO leads (tenant_id, contact_id, responsavel_id, etapa) VALUES (?, ?, ?, 'novo')").run(tid, c, resp).lastInsertRowid); };
const lAna = lead(ana), lCart = lead(null, ana), lOutro = lead(bia), lSem = lead(null);
check(podeVerLead(U(ana), lAna) && podeVerLead(U(ana), lCart) && !podeVerLead(U(ana), lOutro) && !podeVerLead(U(ana), lSem), 'CRM "só os dela": responsável ou cliente da carteira');
check(podeVerLead(U(bia), lOutro) && podeVerLead(U(bia), lSem), 'CRM "todos": vê tudo');
check(podeVerLead(U(dono), lSem), 'dono sempre vê todos os negócios');
const fl = filtroLeads(U(ana));
const ids = db.prepare(`SELECT l.id FROM leads l JOIN contacts ct ON ct.id = l.contact_id WHERE l.tenant_id = ? ${fl.sql}`).all(tid, ...fl.args).map((x) => x.id);
check(ids.sort().join() === [lAna.id, lCart.id].sort().join(), 'lista do CRM filtrada no banco');

console.log(`\n${ok} verificações dos modelos e da visibilidade passaram.`);
process.exit(0);
