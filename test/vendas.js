// Teste do agente de vendas, ponta a ponta, pelo simulador (modo demonstração da IA).
// Rodar com o servidor em: VENDAS_REENGAJAR_MIN=0 (retomada imediata para testar a cadência).
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN = process.env.ADMIN_TOKEN || 'troque-este-token';
let ok = 0;
const check = (c, m) => { if (!c) { console.error('FALHOU:', m); process.exit(1); } ok++; console.log('ok -', m); };
const call = async (path, { method = 'GET', body, token = ADMIN } = {}) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const RESP = '5524999990000';
const t = (await call('/api/tenants', { method: 'POST', body: { nome: 'Indústria Exemplo (vendas)', plano: 'profissional', telefone_responsavel: RESP } })).data;
const cfg = await call(`/api/tenants/${t.id}`, { method: 'PUT', body: {
  vendas_ativo: 1, desconto_max: 5, desconto_avista: 5, parcelas_max: 6, validade_proposta_dias: 7,
  agenda_dias: '0,1,2,3,4,5,6', agenda_inicio: '00:00', agenda_fim: '23:30', reuniao_minutos: 30, reuniao_local: 'https://meet.exemplo/abc',
  condicoes_pagamento: 'Pix, boleto ou cartão em até 6x', pos_venda_mensagem: 'Seu pedido entra em produção hoje.' } });
check(cfg.status === 200 && cfg.data.vendas_ativo === 1, 'agente de vendas ativado');
check((await call(`/api/tenants/${t.id}`, { method: 'PUT', body: { desconto_max: 80 } })).status === 400, 'limite de desconto da IA travado em 50%');

const prod = await call(`/api/tenants/${t.id}/products`, { method: 'POST', body: { nome: 'Rampa niveladora 8t', preco: 10000, preco_minimo: 9000, unidade: 'un', descricao: 'Hidráulica' } });
check(prod.status === 201, 'produto cadastrado no catálogo');

const sim = (texto, telefone = '5521911112222') => call(`/api/tenants/${t.id}/simulate`, { method: 'POST', body: { texto, telefone, nome: 'Carlos Lima' } }).then((r) => r.data);

await sim('Olá, boa tarde');
let r = await sim('Quero 2 rampas, meu email é carlos@transportes.com');
check(r.ferramentas.some((f) => f.nome === 'criar_proposta'), 'IA montou a proposta');
check(r.respostas.some((m) => m.includes('Proposta nº 1') && m.includes('/proposta/')), 'cliente recebeu resumo e link da proposta');
let props = (await call(`/api/tenants/${t.id}/proposals`)).data;
check(props[0].status === 'enviada' && props[0].total === 20000 && props[0].email === 'carlos@transportes.com', 'proposta registrada com total e e-mail');
const page = await fetch(`${BASE}/proposta/${props[0].token}`).then((x) => x.text());
check(page.includes('Proposta nº 1') && page.includes('Aprovar e pagar'), 'página pública da proposta');
let lead = (await call(`/api/tenants/${t.id}/leads`)).data[0];
check(lead.etapa === 'proposta' && lead.valor_estimado === 20000, 'lead em Proposta com valor');

r = await sim('Consegue 15% de desconto?');
props = (await call(`/api/tenants/${t.id}/proposals`)).data;
check(props[0].status === 'aguardando_aprovacao' && props[0].numero === 2, 'desconto acima do limite vai para aprovação');
check(r.respostas.some((m) => /confirmar/.test(m)), 'IA avisa que vai confirmar com o gestor');

const ap = await sim('APROVAR 2', RESP);
check(ap.respostas[0].includes('aprovada'), 'gestor aprova pelo WhatsApp com "APROVAR 2"');
props = (await call(`/api/tenants/${t.id}/proposals`)).data;
check(props[0].status === 'enviada' && props[0].total === 17000, 'proposta aprovada enviada com 15%');

r = await sim('Fechado, vamos no pix');
const cobs = (await call(`/api/tenants/${t.id}/charges`)).data;
check(cobs.length === 1 && cobs[0].valor === 16150 && cobs[0].forma === 'pix', 'cobrança Pix com 5% à vista (R$16.150)');
check(r.respostas.some((m) => m.includes('/pagar/')), 'link de pagamento enviado no WhatsApp');

const pg = await fetch(`${BASE}/pagar/${cobs[0].token}/simular`, { method: 'POST', redirect: 'manual' });
check(pg.status === 302, 'pagamento simulado');
lead = (await call(`/api/tenants/${t.id}/leads`)).data[0];
check(lead.etapa === 'fechado' && lead.valor_estimado === 16150, 'lead fechado com o valor pago');
const conv = (await call(`/api/conversations/${r.conversation_id}`)).data;
check(conv.mensagens.some((m) => m.conteudo.includes('Pagamento confirmado') && m.conteudo.includes('produção')), 'cliente recebeu confirmação e pós-venda');
const st = (await call(`/api/tenants/${t.id}/vendas-stats`)).data;
check(st.vendido_mes.v === 16150 && st.a_receber.n === 0, 'indicadores de vendas corretos');

// Agenda
r = await sim('Quero marcar uma reunião, pode ser o primeiro horário', '5521933334444');
const ag = (await call(`/api/tenants/${t.id}/appointments`)).data;
check(ag.length === 1 && ag[0].status === 'agendada', 'reunião marcada na agenda');
const livres = (await call(`/api/tenants/${t.id}/horarios`)).data;
check(livres.length > 0 && livres[0].inicio !== ag[0].inicio, 'horário ocupado sai da lista de livres');

// Aceite pela página pública (cartão parcelado)
await sim('Quero 1 rampa', '5521955556666');
props = (await call(`/api/tenants/${t.id}/proposals`)).data;
const p3 = props.find((p) => p.telefone === '5521955556666');
const ac = await fetch(`${BASE}/proposta/${p3.token}/aceitar`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'forma=cartao&parcelas=6' });
check(ac.status === 303 && ac.headers.get('location').includes('/pagar/'), 'cliente aprova na página e vai para o pagamento');
const c3 = (await call(`/api/tenants/${t.id}/charges`)).data.find((c) => c.telefone === '5521955556666');
check(c3.parcelas === 6 && c3.valor === 10000, 'cartão em 6x sem desconto à vista');

// Perda
r = await sim('Não vou comprar, fechei com outro fornecedor', '5521955556666');
lead = (await call(`/api/tenants/${t.id}/leads`)).data.find((l) => l.telefone === '5521955556666');
check(lead.etapa === 'perdido' && lead.motivo_perda, 'perda registrada com motivo');

// Retomada de conversa parada (VENDAS_REENGAJAR_MIN=0)
await sim('Oi, vocês fazem rampa?', '5521977778888');
await new Promise((x) => setTimeout(x, 1100));
await call('/api/jobs/rodar', { method: 'POST' });
const parada = (await call(`/api/tenants/${t.id}/conversations`)).data.find((c) => c.telefone === '5521977778888');
const msgs = (await call(`/api/conversations/${parada.id}`)).data.mensagens;
check(msgs.at(-1).autor === 'ia' && msgs.filter((m) => m.autor === 'ia').length >= 2, 'IA retomou a conversa parada sozinha');

// Isolamento
const outra = (await call('/api/tenants', { method: 'POST', body: { nome: 'Outra' } })).data;
check((await call(`/api/tenants/${t.id}/proposals`, { token: outra.painel_token })).status === 403, 'propostas protegidas entre empresas');
check((await call(`/api/tenants/${t.id}`, { token: t.painel_token, method: 'PUT', body: { asaas_api_key: 'x' } })).data.asaas_configurado === false, 'cliente não altera a conta Asaas');

console.log(`\n${ok} verificações de vendas passaram.`);
