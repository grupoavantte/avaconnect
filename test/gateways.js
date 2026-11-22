// Teste dos gateways de pagamento (Asaas, Mercado Pago, Pagar.me, Pix direto) e do plano anual. APIs simuladas.
process.env.DB_PATH = `/tmp/ava-gw-${Date.now()}.db`;
process.env.ASAAS_API_KEY = '$aact_avantte';
process.env.PUBLIC_URL = 'https://ava.teste';
const chamadas = [];
const json = (d, ok = true, status = ok ? 200 : 400) => ({ ok, status, json: async () => d, headers: new Map() });
globalThis.fetch = async (url, opts = {}) => {
  url = String(url); const body = opts.body ? JSON.parse(opts.body) : null;
  chamadas.push({ url, method: opts.method || 'GET', body, headers: opts.headers || {} });
  if (url.includes('api.mercadopago.com/checkout/preferences')) return json({ id: 'pref_1', init_point: 'https://mp.test/checkout/pref_1' });
  if (url.includes('api.mercadopago.com/v1/payments/999')) return json({ id: 999, status: 'approved', external_reference: globalThis.TOKEN_MP, transaction_amount: 100 });
  if (url.includes('api.mercadopago.com/v1/payments/998')) return json({ id: 998, status: 'pending', external_reference: globalThis.TOKEN_MP });
  if (url.includes('api.mercadopago.com/users/me')) return opts.headers.authorization === 'Bearer APP_USR-bom' ? json({ nickname: 'LOJA' }) : json({ message: 'invalid token' }, false, 401);
  if (url.includes('api.pagar.me/core/v5/orders') && opts.method === 'POST') return json({ id: 'or_1', code: body.code, checkouts: [{ payment_url: 'https://pagar.me/checkout/or_1' }] });
  if (url.includes('api.pagar.me/core/v5/orders/or_1')) return json({ id: 'or_1', code: globalThis.TOKEN_PG, status: 'paid', amount: 5000 });
  if (url.includes('api.asaas.com/v3/paymentLinks')) return json({ id: 'lnk_1', url: 'https://asaas.test/i/1' });
  if (url.includes('api.asaas.com/v3/customers')) return json({ id: 'cus_1' });
  if (url.includes('api.asaas.com/v3/subscriptions')) return json({ id: 'sub_' + (globalThis.SUBN = (globalThis.SUBN || 0) + 1) });
  if (url.includes('api.asaas.com/v3/payments?subscription=sub_3')) return json({ data: [{ dueDate: new Date(Date.now() - 15 * 864e5).toISOString().slice(0, 10), invoiceUrl: 'https://asaas.test/f/9' }] });
  if (url.includes('api.asaas.com/v3/payments?')) return json({ data: [] });
  if (url.includes('graph.facebook.com')) return json({ messages: [{ id: 'w1' }] });
  throw new Error('URL inesperada ' + url);
};

const http = await import('node:http');
const express = (await import('express')).default;
const { db } = await import('../src/db.js');
const { criarCobranca, modoPagamento } = await import('../src/payments.js');
const { pixCopiaCola, normalizarChavePix, rotasGateways, recebimentoRouter, possivelComprovante } = await import('../src/gateways.js');
const { PLANS } = await import('../src/plans.js');
const { cadastrar, ativarConta, eventoAssinatura, conferirInadimplencia, situacaoConta } = await import('../src/cadastro.js');
let ok = 0;
const check = (c, m) => { if (!c) { console.error('FALHOU:', m); process.exit(1); } ok++; console.log('ok -', m); };

// ---- Pix (BR Code) ----
const crc = (s) => { let c = 0xffff; for (const b of Buffer.from(s)) { c ^= b << 8; for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff; } return c.toString(16).toUpperCase().padStart(4, '0'); };
check(crc('00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***6304') === '1D3D', 'CRC confere com o exemplo oficial do Banco Central');
const pix = pixCopiaCola({ chave: 'loja@exemplo.com', nome: 'Loja Exemplo Ltda', cidade: 'São Paulo', valor: 129.9, txid: 'abc123' });
check(pix.startsWith('000201') && pix.includes('0014br.gov.bcb.pix0116loja@exemplo.com') && pix.includes('5406129.90') && pix.includes('5917LOJA EXEMPLO LTDA') && pix.includes('6009SAO PAULO'), 'Pix copia e cola com chave, valor, nome e cidade');
check(pix.slice(-4) === crc(pix.slice(0, -4)), 'Pix com código verificador válido');
check(normalizarChavePix('(24) 99999-8888') === '+5524999998888' && normalizarChavePix('123.456.789-09') === '12345678909' && normalizarChavePix('12.345.678/0001-95') === '12345678000195', 'chave Pix normalizada (celular, CPF, CNPJ)');

// ---- Cobrança no gateway de cada empresa ----
const novo = (nome, gateway, cfg) => db.prepare('INSERT INTO tenants (nome, plano, painel_token, gateway, gateway_config) VALUES (?, ?, ?, ?, ?)').run(nome, 'profissional', 'tk' + Math.random(), gateway, cfg ? JSON.stringify(cfg) : null).lastInsertRowid;
const T = (id) => db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
const tMP = novo('Loja MP', 'mercadopago', { access_token: 'APP_USR-bom' });
const tPG = novo('Loja PG', 'pagarme', { secret_key: 'sk_teste' });
const tPX = novo('Loja Pix', 'pix', { chave: 'loja@exemplo.com', nome: 'Loja Pix', cidade: 'Campinas' });
const tSem = novo('Sem conta', null, null);
check(modoPagamento(T(tMP)) === 'mercadopago' && modoPagamento(T(tPG)) === 'pagarme' && modoPagamento(T(tPX)) === 'pix', 'cada empresa usa o gateway que escolheu');
let r = await criarCobranca(T(tMP), { token: 'cob_mp1', valor: 100, descricao: 'Pedido 1', forma: 'pix' });
let c = chamadas.at(-1);
check(r.url === 'https://mp.test/checkout/pref_1' && c.headers.authorization === 'Bearer APP_USR-bom' && c.body.external_reference === 'cob_mp1'
  && c.body.notification_url === `https://ava.teste/webhooks/mercadopago/${tMP}` && c.body.payment_methods.excluded_payment_types.some((x) => x.id === 'credit_card'), 'Mercado Pago: link com a credencial da loja, aviso automático e só Pix');
r = await criarCobranca(T(tPG), { token: 'cob_pg1', valor: 50, descricao: 'Pedido 2', forma: 'livre', cliente: { nome: 'Ana', telefone: '5524999990000' } });
c = chamadas.at(-1);
check(r.url === 'https://pagar.me/checkout/or_1' && c.headers.authorization === 'Basic ' + Buffer.from('sk_teste:').toString('base64') && c.body.code === 'cob_pg1'
  && c.body.items[0].amount === 5000 && c.body.payments[0].checkout.accepted_payment_methods.join() === 'pix,boleto,credit_card' && c.body.customer.phones.mobile_phone.area_code === '24', 'Pagar.me: checkout em centavos, código da cobrança e telefone do cliente');
r = await criarCobranca(T(tPX), { token: 'cob_px1', valor: 80, descricao: 'Pedido 3' });
check(r.gateway === 'pix' && r.url === 'https://ava.teste/pix/cob_px1' && r.pix.includes('540580.00'), 'Pix direto: página do QR Code e copia e cola com o valor');
let erro = ''; try { await criarCobranca(T(tSem), { token: 'x', valor: 1, descricao: 'x' }); } catch (e) { erro = e.message; }
check(erro.includes('Recebimentos'), 'sem forma de recebimento: avisa onde configurar');

// ---- Avisos dos gateways, página do Pix e configuração (servidor de verdade) ----
const app = express();
app.use((req, _res, next) => { req.user = { admin: true }; next(); });
rotasGateways(app);
app.use('/api', express.json(), recebimentoRouter(() => true));
const srv = app.listen(0); const porta = srv.address().port;
const req = (metodo, path, corpo) => new Promise((ok2) => {
  const q = http.request({ host: '127.0.0.1', port: porta, path, method: metodo, headers: { 'content-type': 'application/json' } }, (res) => {
    let d = ''; res.on('data', (x) => (d += x)); res.on('end', () => ok2({ status: res.statusCode, body: d }));
  }); if (corpo) q.write(JSON.stringify(corpo)); q.end();
});
const ct = db.prepare("INSERT INTO contacts (tenant_id, telefone, nome) VALUES (?, '5524988887777', 'Ana')").run(tMP).lastInsertRowid;
globalThis.TOKEN_MP = 'cob_mpw';
db.prepare("INSERT INTO charges (tenant_id, contact_id, token, descricao, valor, gateway) VALUES (?, ?, 'cob_mpw', 'Pedido MP', 100, 'mercadopago')").run(tMP, ct);
await req('POST', `/webhooks/mercadopago/${tMP}`, { type: 'payment', data: { id: '998' } });
await new Promise((x) => setTimeout(x, 150));
check(db.prepare("SELECT status FROM charges WHERE token = 'cob_mpw'").get().status === 'pendente', 'aviso de pagamento pendente não confirma nada');
await req('POST', `/webhooks/mercadopago/${tMP}?type=payment&data.id=999`, {});
await new Promise((x) => setTimeout(x, 200));
check(db.prepare("SELECT status FROM charges WHERE token = 'cob_mpw'").get().status === 'pago' && chamadas.some((x) => x.url.endsWith('/v1/payments/999')), 'Mercado Pago aprovado: confere na API e confirma a cobrança');
const nAntes = chamadas.length;
await req('POST', `/webhooks/mercadopago/${tPG}?type=payment&data.id=999`, {});
await new Promise((x) => setTimeout(x, 100));
check(chamadas.length === nAntes, 'aviso no endereço de empresa que não usa esse gateway é ignorado');
const ct2 = db.prepare("INSERT INTO contacts (tenant_id, telefone, nome) VALUES (?, '5524988886666', 'Bia')").run(tPG).lastInsertRowid;
globalThis.TOKEN_PG = 'cob_pgw';
db.prepare("INSERT INTO charges (tenant_id, contact_id, token, descricao, valor, gateway) VALUES (?, ?, 'cob_pgw', 'Pedido PG', 50, 'pagarme')").run(tPG, ct2);
await req('POST', `/webhooks/pagarme/${tPG}`, { type: 'order.paid', data: { id: 'or_1', status: 'paid' } });
await new Promise((x) => setTimeout(x, 200));
check(db.prepare("SELECT status FROM charges WHERE token = 'cob_pgw'").get().status === 'pago', 'Pagar.me pago: confere o pedido na API e confirma');
const ct3 = db.prepare("INSERT INTO contacts (tenant_id, telefone, nome) VALUES (?, '5524988885555', 'Caio')").run(tPX).lastInsertRowid;
db.prepare("INSERT INTO charges (tenant_id, contact_id, token, descricao, valor, gateway, pix_copia_cola, pagamento_url) VALUES (?, ?, 'cob_pxw', 'Pedido Pix', 80, 'pix', ?, 'x')").run(tPX, ct3, pix);
let pg = await req('GET', '/pix/cob_pxw');
check(pg.status === 200 && pg.body.includes('<svg') && pg.body.includes('Pix copia e cola') && pg.body.includes('R$&nbsp;80,00') === false && pg.body.includes('80,00'), 'página do Pix com QR Code e copia e cola');
db.prepare("UPDATE tenants SET telefone_responsavel = '5524999990000', wa_phone_number_id = 'PN', wa_token = 'tok' WHERE id = ?").run(tPX);
const antes = chamadas.length;
const avisou = await possivelComprovante(T(tPX), db.prepare('SELECT * FROM contacts WHERE id = ?').get(ct3), { type: 'image' });
check(avisou && chamadas.slice(antes).some((x) => x.url.includes('graph.facebook.com') && JSON.stringify(x.body).includes('comprovante')), 'cliente manda imagem com Pix em aberto: equipe é avisada para conferir');
let rr = await req('PUT', `/api/tenants/${tSem}/recebimento`, { gateway: 'mercadopago', config: { access_token: 'APP_USR-ruim' } });
check(rr.status === 400 && JSON.parse(rr.body).erro.includes('401'), 'credencial inválida é recusada no teste');
rr = await req('PUT', `/api/tenants/${tSem}/recebimento`, { gateway: 'mercadopago', config: { access_token: 'APP_USR-bom' } });
check(rr.status === 200 && modoPagamento(T(tSem)) === 'mercadopago', 'credencial válida: gateway ativado');
rr = await req('GET', `/api/tenants/${tSem}/recebimento`);
const info = JSON.parse(rr.body);
check(info.ativo === 'mercadopago' && info.config.access_token === '••••-bom' && info.gateways.length === 4, 'configuração mostra a chave mascarada e as 4 opções');
rr = await req('PUT', `/api/tenants/${tSem}/recebimento`, { gateway: 'mercadopago', config: { access_token: '••••-bom' } });
check(rr.status === 200 && JSON.parse(T(tSem).gateway_config).access_token === 'APP_USR-bom', 'salvar sem redigitar mantém a chave');
srv.close();

// ---- Plano anual ----
db.prepare("INSERT INTO tenants (id, nome, plano, painel_token) VALUES (999, 'Avantte', 'premium', 'tk_avt')").run();
process.env.ASAAS_TENANT_ID = '999';
const p = PLANS.profissional;
check(p.preco_anual === p.preco_mensal * 10, 'anual = 10 mensalidades (2 meses grátis)');
const cad = await cadastrar({ plano: 'profissional', ciclo: 'anual', empresa: 'Clínica Sol', nome: 'Rita Souza', email: 'rita@sol.com', whatsapp: '24999991234',
  cpf_cnpj: '11.222.333/0001-81', senha: 'Senha1234', aceite: true }, '1.1.1.1');
const cob = db.prepare('SELECT * FROM charges WHERE signup_tenant_id = ?').get(cad.tenant_id);
check(cob.valor === p.implantacao + p.preco_anual && cob.descricao.includes('plano anual') && T(cad.tenant_id).ciclo === 'anual', 'cadastro anual cobra implantação + ano');
await ativarConta(cad.tenant_id);
const sub = chamadas.filter((x) => x.url.includes('/subscriptions')).at(-1).body;
const mesQueVem = (m) => { const d = new Date(Date.now() - 3 * 3600e3); d.setUTCMonth(d.getUTCMonth() + m); return d.toISOString().slice(0, 7); };
check(sub.cycle === 'YEARLY' && sub.value === p.preco_anual && sub.nextDueDate.startsWith(mesQueVem(12)), 'assinatura anual no Asaas, renovando em 12 meses');
await eventoAssinatura({ pago: true }, { subscription: 'sub_1', dueDate: '2027-11-21' });
check(T(cad.tenant_id).proximo_vencimento === '2028-11-21', 'pagamento da renovação anual empurra o vencimento 1 ano');
// ---- Contrato de 12 meses em 12x (padrão) ----
const cad2 = await cadastrar({ plano: 'essencial', ciclo: 'mensal', empresa: 'Loja Mês', nome: 'Lia Ramos', email: 'lia@mes.com', whatsapp: '24999995678', cpf_cnpj: '529.982.247-25', senha: 'Senha1234', aceite: true }, '1.1.1.2');
const cob2 = db.prepare('SELECT * FROM charges WHERE signup_tenant_id = ?').get(cad2.tenant_id);
check(T(cad2.tenant_id).ciclo === 'contrato' && cob2.valor === PLANS.essencial.implantacao + PLANS.essencial.preco_mensal, 'mensal sem fidelidade não é mais vendido: vira contrato 12x');
check(cob2.descricao.startsWith('Assessoria comercial com inteligência artificial') && cob2.descricao.includes('parcela 1 de 12'), 'cobrança descrita como assessoria (bate com a nota)');
await ativarConta(cad2.tenant_id);
const sub2 = chamadas.filter((x) => x.url.includes('/subscriptions')).at(-1).body;
const t2 = T(cad2.tenant_id);
check(sub2.cycle === 'MONTHLY' && sub2.value === PLANS.essencial.preco_mensal && sub2.nextDueDate.startsWith(mesQueVem(1)) && sub2.description.includes('contrato de 12 meses'), 'assinatura mensal das parcelas do contrato');
check(t2.contrato_fim && t2.contrato_fim.startsWith(mesQueVem(12)), 'contrato termina em 12 meses');
const sx2 = situacaoConta(cad2.tenant_id);
check(sx2.garantia_ate && sx2.ciclo === 'contrato', 'situação mostra garantia de 30 dias');
const fim = t2.contrato_fim;
await eventoAssinatura({ pago: true }, { subscription: t2.asaas_subscription_id, dueDate: fim });
check(T(cad2.tenant_id).contrato_fim === `${Number(fim.slice(0, 4)) + 1}${fim.slice(4)}`, 'parcela após o fim renova o contrato por mais 12 meses');

// ---- Bloqueio por inadimplência (10 dias) ----
const diaRel = (d) => new Date(Date.now() - 3 * 3600e3 + d * 864e5).toISOString().slice(0, 10);
await eventoAssinatura({ vencido: true }, { subscription: t2.asaas_subscription_id, dueDate: diaRel(-3), invoiceUrl: 'https://asaas.test/f/2' });
let s2 = situacaoConta(cad2.tenant_id);
check(s2.cobranca_status === 'atrasada' && s2.bloqueio_em === diaRel(7) && s2.fatura_aberta_url === 'https://asaas.test/f/2', 'atraso marca a data do bloqueio (vencimento + 10 dias)');
const { HANDLERS } = await import('../src/ganchos.js');
check(await HANDLERS.suspender_inadimplente({ tenant_id: cad2.tenant_id }) === 'ainda no prazo', 'não bloqueia antes dos 10 dias');
db.prepare("UPDATE tenants SET atraso_desde = '2026-11-01' WHERE id = ?").run(cad2.tenant_id);
check(await HANDLERS.suspender_inadimplente({ tenant_id: cad2.tenant_id }) === 'suspensa' && T(cad2.tenant_id).status === 'pausado', 'bloqueia depois de 10 dias sem pagamento');
await eventoAssinatura({ pago: true }, { subscription: t2.asaas_subscription_id, dueDate: diaRel(-3) });
check(T(cad2.tenant_id).status === 'ativo' && T(cad2.tenant_id).cobranca_status === 'em_dia', 'pagou: liberado sozinho');
// Rede de segurança: aviso do Asaas perdido → conferência acha a parcela vencida e bloqueia.
check(T(cad.tenant_id).asaas_subscription_id === 'sub_1', 'anual ficou com sub_1');
const cad3 = await cadastrar({ plano: 'essencial', empresa: 'Oficina Zé', nome: 'Zé Lima', email: 'ze@of.com', whatsapp: '24999997777', cpf_cnpj: '390.533.447-05', senha: 'Senha1234', aceite: true }, '1.1.1.3');
await ativarConta(cad3.tenant_id);
check(T(cad3.tenant_id).asaas_subscription_id === 'sub_3', 'terceira assinatura');
const nb = await conferirInadimplencia();
check(nb === 1 && T(cad3.tenant_id).status === 'pausado' && T(cad3.tenant_id).cobranca_status === 'suspensa' && T(cad3.tenant_id).fatura_aberta_url === 'https://asaas.test/f/9', 'conferência diária bloqueia parcela vencida há mais de 10 dias');
check(T(cad2.tenant_id).status === 'ativo' && T(cad.tenant_id).status === 'ativo', 'quem está em dia não é bloqueado');

console.log(`\n${ok} verificações dos gateways e do plano anual passaram.`);
process.exit(0);
