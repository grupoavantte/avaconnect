// Teste da operação: usuários ilimitados, setores/fila/carteira, encerramento com motivo e pesquisa,
// copiloto, recuperação de compra parada e campanhas (APIs simuladas).
process.env.DB_PATH = `/tmp/ava-op-${Date.now()}.db`;
process.env.ANTHROPIC_API_KEY = 'teste';
process.env.VARREDURA_SEMPRE = '1';
const fila = []; const claude = []; const enviados = [];
const json = (d, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => d, headers: new Map() });
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  if (url.includes('api.anthropic.com')) { claude.push(JSON.parse(opts.body)); return json(fila.shift() || { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Ok!' }] }); }
  if (url.includes('graph.facebook.com')) {
    const b = JSON.parse(opts.body); enviados.push(b);
    if (b.type === 'template' && b.to === '5524900000009') return json({ error: { message: 'Template name does not exist' } }, false);
    return json({ messages: [{ id: 'wamid.' + enviados.length }] });
  }
  throw new Error('URL inesperada ' + url);
};
const tool = (name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't' + Math.random(), name, input }] });
const fala = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });

const { db } = await import('../src/db.js');
const { getPlan } = await import('../src/plans.js');
const { criarAgente } = await import('../src/agents.js');
const { handleIncoming, humanReply } = await import('../src/engine.js');
const { HANDLERS, rodarJobs } = await import('../src/funil.js');
const { encerrar, publico } = await import('../src/operacao.js');
const { sugerirResposta } = await import('../src/ai.js');
const { confirmarPagamentoCobranca } = await import('../src/vendas.js');
let ok = 0;
const check = (c, m) => { if (!c) { console.error('FALHOU:', m); process.exit(1); } ok++; console.log('ok -', m); };

check(['essencial', 'profissional', 'premium'].every((p) => getPlan(p).usuarios_painel === null), 'usuários ilimitados em todos os planos');

const tid = db.prepare(`INSERT INTO tenants (nome, plano, painel_token, wa_phone_number_id, wa_token, telefone_responsavel, loja_ativa, cep_origem, entrega_local, cadencia_ativa)
  VALUES ('Moda Sul', 'profissional', 'tk', 'PN1', 'tok', '5524999990000', 1, '25850000', '{"ceps":"256","taxa":10,"prazo":"hoje","nome":"Motoboy"}', 1)`).run().lastInsertRowid;
criarAgente(tid, { modelo: 'loja', nome: 'AVA' });
const user = (nome, setores, tel) => db.prepare("INSERT INTO users (tenant_id, nome, email, papel, setores, telefone) VALUES (?, ?, ?, 'atendente', ?, ?)")
  .run(tid, nome, nome.toLowerCase() + '@x.com', setores ? JSON.stringify(setores) : null, tel).lastInsertRowid;
const ana = user('Ana', ['Financeiro'], '5524911110001'); const beto = user('Beto', null, '5524911110002'); const caio = user('Caio', ['Vendas'], null);
const tenant = () => db.prepare('SELECT * FROM tenants WHERE id = ?').get(tid);
const msg = (tel, texto, nome = 'Cliente') => handleIncoming(tenant(), { telefone: tel, nome, texto, canal: 'whatsapp', waId: 'w' + Math.random() });
const conv = (id) => db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);

// ---- Setores, fila e carteira ----
fila.push(tool('transferir_humano', { motivo: '2ª via do boleto', setor: 'Financeiro' }), fala('Vou te passar para o financeiro.'));
let r = await msg('5524900000001', 'Preciso da segunda via do boleto');
check(claude.at(-1).tools.find((t) => t.name === 'transferir_humano').input_schema.properties.setor.enum.join() === 'Vendas,Suporte,Financeiro', 'IA escolhe o setor entre os da empresa');
let c1 = conv(r.conversation_id);
check(c1.status === 'humano' && c1.setor === 'Financeiro' && c1.atendente_id === Number(ana), 'Financeiro vai para quem atende o setor (Ana)');
check(enviados.some((e) => e.to === '5524911110001' && e.text?.body.includes('Financeiro')), 'Ana é avisada no WhatsApp dela');
fila.push(tool('transferir_humano', { motivo: 'boleto', setor: 'Financeiro' }), fala('Já te passo.'));
r = await msg('5524900000002', 'Boleto vencido');
check(conv(r.conversation_id).atendente_id === Number(beto), 'próxima vai para quem está mais livre (Beto, que atende todos)');
fila.push(tool('transferir_humano', { motivo: 'quer comprar 50 peças', setor: 'Vendas' }), fala('Te passo para vendas.'));
r = await msg('5524900000003', 'Quero comprar no atacado');
check(conv(r.conversation_id).atendente_id === Number(caio), 'Vendas vai para Caio');
const c3 = conv(r.conversation_id);
await humanReply(c3, 'Oi! Sou o Caio, vamos ver seu pedido.', Number(caio));
check(db.prepare('SELECT responsavel_id FROM contacts WHERE id = ?').get(c3.contact_id).responsavel_id === Number(caio), 'quem atendeu primeiro vira o responsável (carteira)');
db.prepare("UPDATE conversations SET status = 'encerrada' WHERE id = ?").run(c3.id);
fila.push(tool('transferir_humano', { motivo: 'dúvida de pagamento', setor: 'Vendas' }), fala('Já te passo.'));
r = await msg('5524900000003', 'Oi de novo, dúvida sobre o pedido');
check(conv(r.conversation_id).atendente_id === Number(caio), 'cliente da carteira volta para o mesmo atendente');

// ---- Copiloto ----
fila.push(fala('Claro! Vou gerar a 2ª via agora e te mando em seguida.'));
const sug = await sugerirResposta(tenant(), [{ autor: 'cliente', conteudo: 'Preciso da segunda via' }]);
check(sug.includes('2ª via') && claude.at(-1).messages[0].content.includes('ATENDENTE HUMANO'), 'copiloto sugere a resposta para o atendente');

// ---- Encerramento, motivo e pesquisa ----
fila.push(fala('Temos sim, R$ 59,90.'), fala('Pode ser no Pix.'));
r = await msg('5524900000004', 'Vocês têm camiseta?', 'Duda');
await msg('5524900000004', 'E aceita pix?');
fila.push(fala('dúvida'));
const enc = await encerrar(conv(r.conversation_id));
check(enc.motivo === 'dúvida' && enc.pesquisa && conv(r.conversation_id).motivo_atendimento === 'dúvida', 'ao encerrar, registra o motivo do atendimento');
check(enviados.at(-1).to === '5524900000004' && enviados.at(-1).text.body.includes('de *1 a 5*'), 'pesquisa de satisfação enviada');
const antes = claude.length;
r = await msg('5524900000004', '2, demorou para responder');
check(r.pesquisa && claude.length === antes && conv(r.conversation_id).nota === 2 && conv(r.conversation_id).nota_comentario === 'demorou para responder', 'nota e comentário registrados, sem gastar IA');
check(enviados.some((e) => e.to === '5524999990000' && e.text?.body.includes('Avaliação 2/5')), 'nota baixa avisa o responsável');
fila.push(fala('Oi Duda! Como posso ajudar?'));
r = await msg('5524900000004', '5');
check(!r.pesquisa && r.respostas[0].includes('Duda'), 'depois da pesquisa, um "5" já é conversa normal');

// Encerramento automático de conversa parada
fila.push(fala('Olá!'), fala('Certo.'));
r = await msg('5524900000005', 'oi'); await msg('5524900000005', 'tudo bem?');
db.prepare("UPDATE conversations SET ultima_mensagem_em = datetime('now', '-24 hours') WHERE id = ?").run(r.conversation_id);
fila.push(fala('outro'));
await rodarJobs();
check(conv(r.conversation_id).status === 'encerrada' && conv(r.conversation_id).motivo_atendimento, 'conversa da IA parada é encerrada sozinha');

// ---- Recuperação de compra parada ----
db.prepare("INSERT INTO products (tenant_id, nome, preco, estoque) VALUES (?, 'Camiseta', 59.9, 10)").run(tid);
fila.push(tool('calcular_frete', { cep: '25600000', itens: [{ produto: 'Camiseta', quantidade: 2 }] }), fala('Motoboy R$ 10.'));
r = await msg('5524900000006', 'Quanto fica o frete para 25600000?', 'Lia');
const jobs = db.prepare("SELECT * FROM jobs WHERE tipo = 'carrinho_parado' AND status = 'pendente'").all();
check(jobs.length === 2 && JSON.parse(jobs[0].payload).resumo === '2x Camiseta', 'frete consultado agenda 2 tentativas de recuperação');
fila.push(fala('Lia, quer que eu finalize seu pedido das 2 camisetas?'));
const rec = await HANDLERS.carrinho_parado(JSON.parse(jobs[0].payload));
check(enviados.at(-1).to === '5524900000006' && enviados.at(-1).text.body.includes('finalize'), `IA retoma a compra parada (${rec})`);
fila.push(fala('Ótimo!'));
await msg('5524900000006', 'Quero sim');
check(await HANDLERS.carrinho_parado(JSON.parse(jobs[1].payload)) === 'cliente respondeu', 'não insiste se o cliente respondeu');

// ---- Campanhas ----
const cts = db.prepare('SELECT id, telefone FROM contacts WHERE tenant_id = ?').all(tid);
db.prepare("INSERT INTO contacts (tenant_id, telefone, nome) VALUES (?, '5524900000009', 'Zé Erro')").run(tid);
fila.push(fala('ok'));
r = await msg('5524900000005', 'SAIR');
check(r.respostas[0].includes('não vai mais receber') && db.prepare("SELECT optout FROM contacts WHERE telefone = '5524900000005'").get().optout === 1, '"SAIR" tira o contato das campanhas');
const alvo = publico(tid, {});
check(alvo.length === cts.length && !alvo.some((c) => c.telefone === '5524900000005'), 'público exclui quem saiu');
db.prepare("INSERT INTO leads (tenant_id, contact_id, etapa) VALUES (?, ?, 'perdido')").run(tid, cts[0].id);
check(publico(tid, { etapas: ['perdido'] }).length === 1, 'filtro por etapa do CRM');
process.env.CAMPANHA_LOTE = '3';
const cid = db.prepare(`INSERT INTO campaigns (tenant_id, nome, modelo, variaveis, texto, filtro, agendada_para) VALUES (?, 'Black', 'promo_black', ?, 'Oi {nome}, 20% off!', '{}', datetime('now'))`)
  .run(tid, JSON.stringify(['{nome}', '20%'])).lastInsertRowid;
db.prepare("INSERT INTO jobs (tipo, payload, executar_em) VALUES ('campanha_lote', ?, datetime('now'))").run(JSON.stringify({ campaign_id: cid }));
await rodarJobs();
let cp = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(cid);
check(cp.status === 'enviando' && db.prepare("SELECT COUNT(*) n FROM campaign_sends WHERE campaign_id = ? AND status != 'pendente'").get(cid).n === 3, 'envia em lotes');
const tpl = enviados.find((e) => e.type === 'template');
check(tpl.template.name === 'promo_black' && tpl.template.components[0].parameters[1].text === '20%' && !/\{nome\}/.test(tpl.template.components[0].parameters[0].text), 'modelo com variáveis preenchidas ({nome} vira o nome)');
db.prepare("UPDATE jobs SET executar_em = datetime('now') WHERE tipo = 'campanha_lote' AND status = 'pendente'").run();
for (let i = 0; i < 4; i++) { await rodarJobs(); db.prepare("UPDATE jobs SET executar_em = datetime('now') WHERE tipo = 'campanha_lote' AND status = 'pendente'").run(); }
cp = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(cid);
const st = db.prepare("SELECT SUM(status='enviado') e, SUM(status='falhou') f FROM campaign_sends WHERE campaign_id = ?").get(cid);
check(cp.status === 'concluida' && st.f === 1 && db.prepare("SELECT erro FROM campaign_sends WHERE status = 'falhou'").get().erro.includes('Template'), 'concluída; falha da Meta registrada por contato');
const lia = db.prepare("SELECT * FROM contacts WHERE telefone = '5524900000006'").get();
check(db.prepare("SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.contact_id = ? AND m.conteudo LIKE '📣 Campanha \"Black\": Oi Lia, 20% off!'").get(lia.id), 'campanha fica no histórico para a IA continuar');
fila.push(fala('Que bom! Quer aproveitar os 20%?'));
await msg('5524900000006', 'Quero aproveitar');
check(db.prepare('SELECT respondeu_em FROM campaign_sends WHERE campaign_id = ? AND contact_id = ?').get(cid, lia.id).respondeu_em, 'resposta à campanha contabilizada');
const ch = db.prepare("INSERT INTO charges (tenant_id, contact_id, token, descricao, valor) VALUES (?, ?, 'cob_x', 'Pedido', 119.8)").run(tid, lia.id).lastInsertRowid;
await confirmarPagamentoCobranca(db.prepare('SELECT * FROM charges WHERE id = ?').get(ch));
check(db.prepare('SELECT comprou_valor FROM campaign_sends WHERE campaign_id = ? AND contact_id = ?').get(cid, lia.id).comprou_valor === 119.8, 'venda atribuída à campanha');

console.log(`\n${ok} verificações da operação passaram.`);
process.exit(0);
