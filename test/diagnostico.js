// Teste do funil do diagnóstico. Rodar com o servidor em FOLLOWUP_DELAY_MIN=0.
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN = process.env.ADMIN_TOKEN || 'troque-este-token';
let ok = 0;
const check = (c, m) => { if (!c) { console.error('FALHOU:', m); process.exit(1); } ok++; console.log('ok -', m); };
const call = async (path, { method = 'GET', body } = {}) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + ADMIN }, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null) };
};

const t = (await call('/api/tenants', { method: 'POST', body: { nome: 'Avantte', diagnostico_ativo: true, link_agendamento: 'https://agenda.exemplo/avantte' } })).data;
check(t.diagnostico_ativo === 1, 'empresa com diagnóstico ativo');
const tel = '55219' + Date.now().toString().slice(-8);
const say = async (texto) => (await call(`/api/tenants/${t.id}/simulate`, { method: 'POST', body: { texto, telefone: tel, nome: 'Marcos Silva' } })).data;

let r = await say('Oi, quero fazer o diagnóstico da minha empresa');
check(r.respostas.some((m) => m.includes('1/13')), 'IA inicia o diagnóstico e envia a 1ª pergunta');
r = await say('banana');
check(r.respostas[0].startsWith('Não entendi'), 'resposta inválida pede de novo');
const respostas = ['A', 'B', 'C', 'A', 'b', '2', 'A', 'D', 'B', 'A', 'C', 'B', 'A'];
for (let i = 0; i < respostas.length; i++) r = await say(respostas[i]);
check(r.diagnostico === 'concluido', 'diagnóstico concluído após 13 respostas');
check(r.respostas[0].includes('Nota geral da sua empresa'), 'prévia grátis com a nota geral');
check(r.respostas[1].includes('/pagar/'), 'link de pagamento enviado');

const lista = (await call(`/api/tenants/${t.id}/diagnosticos`)).data;
const d = lista[0];
check(d.status === 'aguardando_pagamento' && d.nota_geral >= 0, 'diagnóstico aguardando pagamento');
const antes = await fetch(`${BASE}/relatorio/${d.token}`).then((x) => x.text());
check(antes.includes('quase pronto') && !antes.includes('Situação e melhorias'), 'relatório bloqueado antes do pagamento');

const pg = await fetch(`${BASE}/pagar/${d.token}/simular`, { method: 'POST', redirect: 'manual' });
check(pg.status === 302, 'pagamento simulado');
const rel = await fetch(`${BASE}/relatorio/${d.token}`).then((x) => x.text());
check(rel.includes('Situação e melhorias por área') && rel.includes('Plano de ação de 90 dias'), 'relatório completo liberado');
check((await call(`/api/diagnosticos/${d.id}/confirmar-pagamento`, { method: 'POST' })).data.jaPago, 'confirmação é idempotente');

let leads = (await call(`/api/tenants/${t.id}/leads`)).data;
check(leads[0].etapa === 'fechado' && leads[0].valor_estimado === 297, 'lead fechado com R$297');

await new Promise((x) => setTimeout(x, 1200));
const jobs = (await call('/api/jobs/rodar', { method: 'POST' })).data;
check(jobs.executados >= 1, 'follow-up D+1 executado');
leads = (await call(`/api/tenants/${t.id}/leads`)).data;
check(leads[0].interesse.startsWith('Consultoria') && leads[0].etapa === 'qualificado', 'lead vira oportunidade de consultoria');
const conv = (await call(`/api/conversations/${r.conversation_id}`)).data;
check(conv.mensagens.some((m) => m.conteudo.includes('reunião gratuita') && m.conteudo.includes('agenda.exemplo')), 'mensagem de consultoria com link de agenda');

console.log(`\n${ok} verificações do funil passaram.`);
