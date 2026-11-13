// Teste de ponta a ponta. Requer o servidor rodando (npm start) em BASE_URL.
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN = process.env.ADMIN_TOKEN || 'troque-este-token';
let ok = 0;
const check = (cond, msg) => { if (!cond) { console.error('FALHOU:', msg); process.exit(1); } ok++; console.log('ok -', msg); };
const call = async (path, { token = ADMIN, method = 'GET', body } = {}) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null) };
};

const t = (await call('/api/tenants', { method: 'POST', body: {
  nome: 'Iron Equipamentos (teste)', plano: 'essencial', wa_phone_number_id: 'PNID_TESTE_' + Date.now(),
  base_conhecimento: 'Rampa niveladora hidráulica: capacidade de 6 a 12 toneladas, prazo de fabricação de 20 dias úteis.\nEntregamos em todo o Brasil.',
} })).data;
check(t.id && t.painel_token, 'empresa criada com token de painel');

const s1 = (await call(`/api/tenants/${t.id}/simulate`, { method: 'POST', body: { texto: 'Olá', telefone: '5511999990001' } })).data;
check(s1.respostas.length === 1 && s1.status === 'ia', 'IA respondeu a saudação');
const s2 = (await call(`/api/tenants/${t.id}/simulate`, { method: 'POST', body: { texto: 'Quero um orçamento de rampa niveladora, sou Carlos', telefone: '5511999990001' } })).data;
check(s2.conversation_id === s1.conversation_id, 'mesma conversa mantida');
const leads = (await call(`/api/tenants/${t.id}/leads`)).data;
check(leads.length === 1, 'lead registrado no CRM');
const s3 = (await call(`/api/tenants/${t.id}/simulate`, { method: 'POST', body: { texto: 'Quero falar com um atendente', telefone: '5511999990001' } })).data;
check(s3.status === 'humano', 'transbordo para humano');
const s4 = (await call(`/api/tenants/${t.id}/simulate`, { method: 'POST', body: { texto: 'Alô?', telefone: '5511999990001' } })).data;
check(s4.respostas.length === 0, 'IA silencia com humano no controle');
check((await call(`/api/conversations/${s1.conversation_id}/reply`, { method: 'POST', body: { texto: 'Oi Carlos, aqui é o João.' } })).status === 200, 'humano responde pelo painel');

// Webhook no formato da Meta
const wa = await fetch(BASE + '/webhooks/whatsapp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
  entry: [{ changes: [{ value: { metadata: { phone_number_id: t.wa_phone_number_id }, contacts: [{ wa_id: '5521988880000', profile: { name: 'Marina' } }],
    messages: [{ from: '5521988880000', id: 'wamid.TESTE' + Date.now(), type: 'text', text: { body: 'Vocês entregam no Brasil todo?' } }] } }] }] }) });
check(wa.status === 200, 'webhook aceito');
await new Promise((r) => setTimeout(r, 400));
const convs = (await call(`/api/tenants/${t.id}/conversations`)).data;
check(convs.some((c) => c.telefone === '5521988880000' && c.contato_nome === 'Marina'), 'mensagem do webhook virou conversa');

// Isolamento entre empresas
const other = (await call('/api/tenants', { method: 'POST', body: { nome: 'Outra empresa' } })).data;
check((await call(`/api/tenants/${t.id}/leads`, { token: other.painel_token })).status === 403, 'cliente não vê dados de outra empresa');
check((await call(`/api/tenants/${t.id}/leads`, { token: t.painel_token })).status === 200, 'cliente vê os próprios dados');
check((await call(`/api/tenants/${t.id}`, { token: t.painel_token, method: 'PUT', body: { plano: 'premium' } })).data.plano === 'essencial', 'cliente não altera o próprio plano');

// ---------- CRM ----------
const tk = t.painel_token;
const nl = await call(`/api/tenants/${t.id}/leads`, { token: tk, method: 'POST', body: { nome: 'Paulo', empresa: 'Transportes Sul', telefone: '(24) 99999-1234', interesse: 'Nivelador de doca', valor_estimado: 38000 } });
check(nl.status === 201 && nl.data.origem === 'manual', 'lead manual cadastrado');
check((await call(`/api/tenants/${t.id}/leads`, { token: tk, method: 'POST', body: { telefone: '24999991234' } })).status === 409, 'telefone duplicado bloqueado');
check((await call(`/api/leads/${nl.data.id}/activities`, { token: tk, method: 'POST', body: { tipo: 'tarefa', descricao: 'Enviar proposta', vence_em: '2020-01-01' } })).status === 201, 'tarefa criada');
check((await call(`/api/leads/${nl.data.id}/activities`, { token: tk, method: 'POST', body: { tipo: 'nota', descricao: 'Cliente pediu 2 unidades' } })).status === 201, 'nota criada');
check((await call(`/api/leads/${nl.data.id}`, { token: tk, method: 'PUT', body: { etapa: 'fechado' } })).data.fechado_em, 'lead fechado com data');
const ficha = (await call(`/api/leads/${nl.data.id}`, { token: tk })).data;
check(ficha.atividades.length >= 4 && ficha.atividades.some((a) => a.descricao.includes('fechado')), 'histórico registra mudança de etapa');
const stats = (await call(`/api/tenants/${t.id}/crm-stats`, { token: tk })).data;
check(stats.ganhos_mes === 1 && stats.valor_ganho_mes === 38000 && stats.tarefas_atrasadas === 1, 'métricas do funil corretas');
const busca = (await call(`/api/tenants/${t.id}/leads?q=Transportes`, { token: tk })).data;
check(busca.length === 1, 'busca de leads');
const tasks = (await call(`/api/tenants/${t.id}/tasks`, { token: tk })).data;
check(tasks.length === 1, 'lista de tarefas');
check((await call(`/api/activities/${tasks[0].id}`, { token: tk, method: 'PUT', body: { concluida: true } })).status === 200, 'tarefa concluída');
const csv = await fetch(`${BASE}/api/tenants/${t.id}/leads.csv`, { headers: { authorization: 'Bearer ' + tk } });
check(csv.status === 200 && (await csv.text()).includes('Transportes Sul'), 'exportação CSV');
const ret = (await call(`/api/tenants/${t.id}/simulate`, { method: 'POST', body: { texto: 'Pode me chamar semana que vem?', telefone: '5511977770000' } })).data;
check(ret.ferramentas.some((f) => f.nome === 'agendar_retorno'), 'IA agendou retorno');
check((await call(`/api/tenants/${t.id}/tasks`, { token: tk })).data.some((a) => a.autor === 'ia'), 'tarefa da IA aparece na lista');
check((await call(`/api/leads/${nl.data.id}`, { token: other.painel_token })).status === 403, 'ficha protegida entre empresas');

console.log(`\n${ok} verificações passaram.`);
