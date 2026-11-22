// Teste do AvaShop: foto, frete, pedido, pagamento, estoque, etiqueta, rastreio e passagem entre agentes (APIs simuladas).
process.env.DB_PATH = `/tmp/ava-loja-${Date.now()}.db`;
process.env.ANTHROPIC_API_KEY = 'teste';
const fila = []; const claude = []; const me = [];
const json = (d, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => d, headers: new Map() });
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  if (url.includes('api.anthropic.com')) { claude.push(JSON.parse(opts.body)); return json(fila.shift() || { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Ok!' }] }); }
  if (url.includes('melhorenvio.com.br')) {
    me.push({ url, body: opts.body && JSON.parse(opts.body) });
    if (url.endsWith('/me/shipment/calculate')) return json([{ id: 1, name: 'PAC', price: '22.50', delivery_time: 6, company: { name: 'Correios' } },
      { id: 2, name: 'SEDEX', price: '41.90', delivery_time: 2, company: { name: 'Correios' } }, { id: 3, name: 'X', error: 'indisponível' }]);
    if (url.endsWith('/me/cart')) return json({ id: 'me-ord-1' });
    if (url.endsWith('/me/shipment/tracking')) return json({ 'me-ord-1': { status: 'posted', tracking: 'BR123456789' } });
    return json({});
  }
  throw new Error('URL inesperada ' + url);
};
const tool = (name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't' + Math.random(), name, input }] });
const fala = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });

const { db } = await import('../src/db.js');
const { getCobranca, confirmarPagamentoCobranca } = await import('../src/vendas.js');
const { criarAgente } = await import('../src/agents.js');
const { atualizarPedido } = await import('../src/loja.js');
const { handleIncoming } = await import('../src/engine.js');
const { HANDLERS, rodarJobs } = await import('../src/funil.js');
let ok = 0;
const check = (c, m) => { if (!c) { console.error('FALHOU:', m); process.exit(1); } ok++; console.log('ok -', m); };

const tid = db.prepare(`INSERT INTO tenants (nome, plano, painel_token, loja_ativa, cep_origem, melhorenvio_token, entrega_local, retirada_endereco, parcelas_max, cadencia_ativa)
  VALUES ('Moda Sul', 'profissional', 'tk', 1, '25850000', 'me-token', '{"ceps":"256","taxa":10,"prazo":"hoje","nome":"Motoboy"}', 'Rua A, 10 - Centro', 3, 1)`).run().lastInsertRowid;
const recep = criarAgente(tid, { modelo: 'recepcao', nome: 'AVA' });
const loja = criarAgente(tid, { modelo: 'loja', nome: 'AVA Shop' });
const pid = db.prepare(`INSERT INTO products (tenant_id, nome, preco, descricao, variacoes, peso_g) VALUES (?, 'Camiseta Básica', 59.9, 'Algodão', ?, 250)`)
  .run(tid, JSON.stringify([{ nome: 'M', estoque: 5 }, { nome: 'G', estoque: 0 }])).lastInsertRowid;
db.prepare("INSERT INTO product_images (product_id, tenant_id, mime, dados) VALUES (?, ?, 'image/jpeg', ?)").run(pid, tid, Buffer.from([1, 2, 3]));
const tenant = () => db.prepare('SELECT * FROM tenants WHERE id = ?').get(tid);
const tel = '5524911112222';
const fala1 = async (texto, agentId = null) => handleIncoming(tenant(), { telefone: tel, nome: 'Bia', texto, canal: 'simulador', agentId });

// Passagem: recepção → loja
fila.push(tool('passar_para_agente', { agente_id: loja.id, motivo: 'quer comprar camiseta' }), fala(''), tool('ver_produto', { produto: 'Camiseta' }), fala('Gostou? Qual tamanho?'));
let r = await fala1('Quero comprar uma camiseta', recep.id);
check(claude[0].tools.some((t) => t.name === 'passar_para_agente') && !claude[0].tools.some((t) => t.name === 'criar_pedido'), 'recepção pode passar a conversa, mas não vende');
check(claude.at(-1).system[0].text.includes('VENDEDORA DA LOJA') && claude.at(-1).system[0].text.includes('Camiseta Básica'), 'agente da loja assume com o catálogo');
check(r.respostas.some((m) => m.includes('/img/p/') && m.includes('Camiseta Básica')), 'foto do produto enviada ao cliente');
check(db.prepare('SELECT agent_id FROM conversations WHERE id = ?').get(r.conversation_id).agent_id === loja.id, 'conversa fica com o agente da loja');

// Frete
fila.push(tool('calcular_frete', { cep: '25600-000', itens: [{ produto: 'Camiseta', variacao: 'M', quantidade: 2 }] }), fala('Temos estas opções.'));
await fala1('Tamanho M, 2 unidades. CEP 25600-000');
const res = claude.at(-1).messages.at(-1).content.find((c) => c.type === 'tool_result').content;
check(res.includes('[local] Motoboy: R$') && res.includes('[retirada]') && res.includes('[me_1] PAC (Correios)') && !res.includes('indisponível'), 'frete: motoboy, retirada e Melhor Envio');

// Pedido: esgotado, sem CPF, depois ok
fila.push(tool('criar_pedido', { itens: [{ produto: 'Camiseta', variacao: 'G', quantidade: 1 }], cep: '25600000', entrega: 'me_1', nome: 'Bia Souza' }), fala('Esgotado.'));
await fala1('Quero G');
check(claude.at(-1).messages.at(-1).content[0].content.includes('esgotado'), 'não vende tamanho esgotado');
const end = { rua: 'Rua B', numero: '20', bairro: 'Centro', cidade: 'Petrópolis', uf: 'RJ' };
fila.push(tool('criar_pedido', { itens: [{ produto: 'Camiseta', variacao: 'M', quantidade: 2 }], cep: '25600000', entrega: 'me_1', nome: 'Bia Souza', endereco: end }), fala('Preciso do CPF.'));
await fala1('Pode ser PAC');
check(claude.at(-1).messages.at(-1).content[0].content.includes('CPF'), 'pede CPF para envio por transportadora');
fila.push(tool('criar_pedido', { itens: [{ produto: 'Camiseta', variacao: 'M', quantidade: 2 }], cep: '25600000', entrega: 'me_1', nome: 'Bia Souza', cpf: '529.982.247-25', endereco: end, forma: 'pix' }), fala('Pronto!'));
r = await fala1('CPF 52998224725, pago no Pix');
const o = db.prepare('SELECT * FROM orders WHERE tenant_id = ?').get(tid);
check(o && o.total === 59.9 * 2 + 22.5 && o.status === 'aguardando_pagamento', 'pedido criado com produtos + frete');
check(r.respostas.some((m) => m.includes(`Pedido nº ${o.numero}`) && m.includes('/pagar/') && m.includes('7 dias')), 'cliente recebe resumo, link e aviso do direito de arrependimento');

// Pagamento → estoque, confirmação, etiqueta
await confirmarPagamentoCobranca(db.prepare('SELECT * FROM charges WHERE order_id = ?').get(o.id));
const o2 = db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id);
check(o2.status === 'pago' && o2.me_order_id === 'me-ord-1', 'pago e etiqueta colocada no carrinho do Melhor Envio');
check(JSON.parse(db.prepare('SELECT variacoes FROM products WHERE id = ?').get(pid).variacoes).find((v) => v.nome === 'M').estoque === 3, 'estoque baixado (5 → 3)');
const msgs = db.prepare('SELECT conteudo FROM messages WHERE conversation_id = ? ORDER BY id').all(r.conversation_id).map((m) => m.conteudo);
check(msgs.some((m) => m.includes(`Pagamento do pedido nº ${o.numero} confirmado`)) && !msgs.some((m) => m.startsWith('✅ Pagamento confirmado! Obrigado pela confiança')), 'confirmação específica do pedido (sem mensagem duplicada)');
const cart = me.find((x) => x.url.endsWith('/me/cart')).body;
check(cart.service === 1 && cart.to.document === '52998224725' && cart.to.postal_code === '25600000', 'etiqueta com serviço, CPF e CEP do cliente');

// Rastreio automático
await HANDLERS.rastrear_pedido({ order_id: o.id, n: 1 });
const o3 = db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id);
check(o3.status === 'enviado' && o3.rastreio === 'BR123456789', 'rastreio automático marca como enviado');
check(db.prepare('SELECT conteudo FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1').get(r.conversation_id).conteudo.includes('BR123456789'), 'cliente recebe o código de rastreio');
await atualizarPedido(o3, 'entregue');
check(db.prepare('SELECT status FROM orders WHERE id = ?').get(o.id).status === 'entregue', 'pedido entregue');

// Consultar pedido
fila.push(tool('consultar_pedido', {}), fala('Já foi entregue!'));
await fala1('Cadê meu pedido?');
check(claude.at(-1).messages.at(-1).content[0].content.includes('entregue'), 'IA consulta o pedido');

// Variações completas: Cor × Tamanho com preços, promoção, estoque, foto e combinação desligada
const tenis = db.prepare(`INSERT INTO products (tenant_id, nome, preco, atributos, variacoes) VALUES (?, 'Tênis Run', 199.9, ?, ?)`).run(tid,
  JSON.stringify([{ nome: 'Cor', opcoes: ['Preto', 'Branco'] }, { nome: 'Tamanho', opcoes: ['39', '40'] }]),
  JSON.stringify([
    { nome: 'Preto / 39', opcoes: { Cor: 'Preto', Tamanho: '39' }, preco: 199.9, estoque: 2 },
    { nome: 'Preto / 40', opcoes: { Cor: 'Preto', Tamanho: '40' }, preco: 219.9, preco_promocional: 189.9, estoque: 1, sku: 'RUN-P40', peso_g: 900 },
    { nome: 'Branco / 39', opcoes: { Cor: 'Branco', Tamanho: '39' }, preco: 209.9, estoque: 0 },
    { nome: 'Branco / 40', opcoes: { Cor: 'Branco', Tamanho: '40' }, preco: 209.9, estoque: 5, ativo: false },
  ])).lastInsertRowid;
const fotoBranca = db.prepare("INSERT INTO product_images (product_id, tenant_id, mime, dados) VALUES (?, ?, 'image/jpeg', ?)").run(tenis, tid, Buffer.from([9])).lastInsertRowid;
db.prepare("INSERT INTO product_images (product_id, tenant_id, mime, dados) VALUES (?, ?, 'image/jpeg', ?)").run(tenis, tid, Buffer.from([8]));
const v = JSON.parse(db.prepare('SELECT variacoes FROM products WHERE id = ?').get(tenis).variacoes); v[2].foto_id = Number(fotoBranca);
db.prepare('UPDATE products SET variacoes = ? WHERE id = ?').run(JSON.stringify(v), tenis);
const { montarItens, casarVariacao } = await import('../src/loja.js');
const pt = db.prepare('SELECT * FROM products WHERE id = ?').get(tenis);
check(casarVariacao(pt, 'preto 40')?.nome === 'Preto / 40' && casarVariacao(pt, '40 preto')?.nome === 'Preto / 40' && casarVariacao(pt, 'Preto/39')?.nome === 'Preto / 39', 'entende a combinação em qualquer ordem ("40 preto")');
check(casarVariacao(pt, 'preto') === null, 'combinação incompleta não é escolhida sozinha');
const it = montarItens(tid, [{ produto: 'Tênis Run', variacao: 'preto 40', quantidade: 1 }])[0];
check(it.preco === 189.9 && it.sku === 'RUN-P40' && it.peso_g === 900, 'preço promocional, SKU e peso da combinação');
let er = ''; try { montarItens(tid, [{ produto: 'Tênis Run', variacao: 'branco 40', quantidade: 1 }]); } catch (e) { er = e.message; }
check(er.includes('Não encontrei'), 'combinação desligada não é vendida');
er = ''; try { montarItens(tid, [{ produto: 'Tênis Run', variacao: 'preto 40', quantidade: 2 }]); } catch (e) { er = e.message; }
check(er.includes('Só temos 1'), 'estoque por combinação respeitado');
er = ''; try { montarItens(tid, [{ produto: 'Tênis Run', quantidade: 1 }]); } catch (e) { er = e.message; }
check(er.includes('Cor: Preto, Branco') && er.includes('Tamanho: 39, 40'), 'IA pergunta pelos atributos');
fila.push(tool('ver_produto', { produto: 'Tênis Run', variacao: 'branco 39' }), fala('Essa está esgotada.'));
r = await fala1('Tem o branco 39?');
check(r.respostas.some((m) => m.includes(`/img/p/${fotoBranca}`) && m.includes('Branco / 39') && m.includes('esgotado')), 'mostra a foto e a situação da combinação pedida');
fila.push(fala('ok'));
await fala1('Quais tênis?');
const sysT = claude.at(-1).system[0].text;
check(sysT.includes('Tênis Run: de R$') && sysT.includes('• Preto / 40: R$') && sysT.includes('(promoção)') && !sysT.includes('Branco / 40'), 'catálogo da IA com preço por combinação e sem as desligadas');

// Plano sem vendas não tem loja
const ess = db.prepare("INSERT INTO tenants (nome, plano, painel_token, loja_ativa) VALUES ('Mini', 'essencial', 'tk2', 1)").run().lastInsertRowid;
criarAgente(ess, { modelo: 'loja', nome: 'X' });
await handleIncoming(db.prepare('SELECT * FROM tenants WHERE id = ?').get(ess), { telefone: '1', texto: 'oi', canal: 'simulador' });
check(!claude.at(-1).tools.some((t) => t.name === 'criar_pedido'), 'Essencial não tem loja');

console.log(`\n${ok} verificações do AvaShop passaram.`);
