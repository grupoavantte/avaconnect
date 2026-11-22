// Teste do cadastro pelo site, ativação no pagamento e assinatura (rodar o servidor com INADIMPLENCIA_DIAS=0).
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN = process.env.ADMIN_TOKEN || 'troque-este-token';
let ok = 0;
const check = (c, m) => { if (!c) { console.error('FALHOU:', m); process.exit(1); } ok++; console.log('ok -', m); };
const call = async (path, { method = 'GET', body, token = ADMIN } = {}) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const s = Date.now();
const base = { plano: 'profissional', empresa: 'Transportes Sul', nome: 'Carla Souza', email: `carla${s}@sul.com`, whatsapp: '(24) 99876-5432', cpf_cnpj: '529.982.247-25', senha: 'Senha2026x', aceite: true };
const cad = (b) => call('/api/public/cadastro', { method: 'POST', token: null, body: b });

for (const p of ['/cadastro', '/termos', '/privacidade']) check((await fetch(BASE + p)).status === 200, `página ${p}`);
check((await cad({ ...base, cpf_cnpj: '111.111.111-11' })).data.erro.includes('CPF'), 'CPF inválido recusado');
check((await cad({ ...base, senha: 'abc' })).status === 400, 'senha fraca recusada');
check((await cad({ ...base, aceite: false })).data.erro.includes('Termos'), 'exige aceite dos termos');
check((await cad({ ...base, whatsapp: '123' })).status === 400, 'WhatsApp inválido recusado');

const r = await cad(base);
check(r.status === 201 && r.data.token.startsWith('avs_') && r.data.pagamento_url.includes('/pagar/'), 'conta criada com sessão e link de pagamento');
const TK = r.data.token, tid = r.data.tenant_id;
check((await cad(base)).data.erro.includes('já tem conta'), 'e-mail repetido recusado');
const me = (await call('/api/me', { token: TK })).data;
check(me.papel === 'dono' && me.tenantId === tid, 'cliente entra como dono da própria empresa');
let sx = (await call(`/api/tenants/${tid}/situacao`, { token: TK })).data;
check(sx.status === 'pendente' && sx.pagamento_pendente.valor === 1490 + 897, 'conta pendente com total de implantação + 1ª parcela');
check((await call(`/api/tenants/${tid}/agents`, { token: TK })).data[0].habilidades.includes('vendas'), 'agente de vendas criado no Profissional');
const sim = (await call(`/api/tenants/${tid}/simulate`, { method: 'POST', token: TK, body: { texto: 'Oi', telefone: 'sim-cad' } })).data;
check(sim.respostas.length >= 1, 'simulador funciona antes de pagar');
const wh = await fetch(BASE + '/webhooks/whatsapp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
check(wh.status === 200, 'webhook do WhatsApp segue ok');

const avt = (await call('/api/tenants')).data.filter((t) => /^avantte/i.test(t.nome)).sort((a, b) => a.id - b.id)[0];
let lead = (await call(`/api/tenants/${avt.id}/leads`)).data.find((l) => l.email === base.email);
check(lead && lead.etapa === 'proposta' && lead.origem === 'site', 'venda aparece no CRM da Avantte');

const tokCob = r.data.pagamento_url.split('/pagar/')[1];
const pg = await fetch(`${BASE}/pagar/${tokCob}/simular`, { method: 'POST', redirect: 'manual' });
check(pg.status === 302 && pg.headers.get('location').includes('/obrigado/'), 'pagamento simulado');
sx = (await call(`/api/tenants/${tid}/situacao`, { token: TK })).data;
check(sx.status === 'ativo' && sx.assinatura && sx.proximo_vencimento, 'conta ativada e assinatura mensal registrada');
check((await fetch(`${BASE}/obrigado/${tokCob}`).then((x) => x.text())).includes('Conta ativada'), 'página de obrigado leva ao painel');
lead = (await call(`/api/tenants/${avt.id}/leads`)).data.find((l) => l.email === base.email);
check(lead.etapa === 'fechado', 'venda fechada no CRM da Avantte');

// Mensalidade: atraso → suspensão → pagamento → reativação
const subId = `teste-${tid}`;
const hook = (event) => fetch(BASE + '/webhooks/asaas', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ event, payment: { id: 'pay_' + s, subscription: subId, value: 897, dueDate: '2026-11-01', invoiceUrl: 'https://asaas.test/f/1' } }) });
check((await hook('PAYMENT_OVERDUE')).status === 200, 'webhook de mensalidade vencida');
await new Promise((x) => setTimeout(x, 300));
check((await call(`/api/tenants/${tid}/situacao`, { token: TK })).data.cobranca_status === 'atrasada', 'conta marcada em atraso');
await new Promise((x) => setTimeout(x, 1100));
await call('/api/jobs/rodar', { method: 'POST' });
sx = (await call(`/api/tenants/${tid}/situacao`, { token: TK })).data;
check(sx.status === 'pausado' && sx.cobranca_status === 'suspensa', 'assistente pausada após a tolerância');
check((await call('/api/me', { token: TK })).status === 200, 'cliente bloqueado ainda faz login');
const trav = await call(`/api/tenants/${tid}/conversations`, { token: TK });
check(trav.status === 402 && trav.data.bloqueado, 'painel travado: conversas bloqueadas por inadimplência');
check(sx.bloqueado && sx.fatura_aberta_url === 'https://asaas.test/f/1', 'tela de bloqueio recebe o link da parcela em aberto');
await hook('PAYMENT_RECEIVED'); await new Promise((x) => setTimeout(x, 300));
sx = (await call(`/api/tenants/${tid}/situacao`, { token: TK })).data;
check(sx.status === 'ativo' && sx.cobranca_status === 'em_dia' && !sx.fatura_aberta_url, 'pagou: reativada sozinha');
check((await call(`/api/tenants/${tid}/conversations`, { token: TK })).status === 200, 'pagou: painel destravado');

// Segmentos
const segs = (await call('/api/public/segmentos', { token: null })).data;
check(segs.length >= 10 && segs.some((x) => x.id === 'saude' && x.tem_regras), 'lista pública de segmentos');
const r2 = await cad({ ...base, email: `loja${s}@x.com`, segmento: 'comercio', plano: 'essencial' });
const ag2 = (await call(`/api/tenants/${r2.data.tenant_id}/agents`, { token: r2.data.token })).data[0];
check(ag2.instrucoes.includes('vendedora de loja') && !ag2.habilidades.includes('vendas'), 'cadastro aplica o modelo do segmento (respeitando o plano)');
check((await call(`/api/tenants/${r2.data.tenant_id}/segmento`, { method: 'POST', token: r2.data.token, body: { segmento: 'xyz' } })).status === 400, 'segmento inválido recusado');

console.log(`\n${ok} verificações do cadastro passaram.`);
