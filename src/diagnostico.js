// Diagnóstico Empresarial no WhatsApp: perguntas, nota, prévia grátis e relatório pago.
import crypto from 'node:crypto';
import { db, logActivity } from './db.js';

const LETRAS = ['A', 'B', 'C', 'D', 'E'];
const PONTOS = [10, 40, 70, 100];

// Perguntas de contexto (não entram na nota)
export const CONTEXTO = [
  { id: 'segmento', texto: 'Qual o segmento da sua empresa?', opcoes: ['Indústria', 'Comércio', 'Serviços', 'E-commerce', 'Agro'] },
  { id: 'faturamento', texto: 'Qual o faturamento médio por mês?', opcoes: ['Até R$ 50 mil', 'De R$ 50 mil a R$ 200 mil', 'De R$ 200 mil a R$ 1 milhão', 'Acima de R$ 1 milhão'] },
  { id: 'equipe', texto: 'Quantas pessoas trabalham na empresa?', opcoes: ['Até 5', 'De 6 a 20', 'De 21 a 50', 'Mais de 50'] },
];

// Uma pergunta por área. Opções da pior para a melhor prática.
export const AREAS = [
  { id: 'financeiro', nome: 'Gestão financeira', texto: 'Como a empresa controla contas a pagar e a receber?',
    opcoes: ['Não controlo, vai de cabeça', 'Caderno ou planilha, muitas vezes desatualizada', 'Planilha ou sistema atualizado toda semana', 'Sistema atualizado todo dia, com conciliação bancária'] },
  { id: 'margem', nome: 'Margem e lucro', texto: 'Você sabe quanto sobra de lucro em cada venda?',
    opcoes: ['Não sei', 'Tenho uma ideia aproximada', 'Sei a margem dos principais produtos', 'Sei a margem de cada produto e acompanho todo mês'] },
  { id: 'comercial', nome: 'Vendas e funil comercial', texto: 'Como a empresa acompanha os orçamentos enviados?',
    opcoes: ['Não acompanha', 'Quando alguém lembra', 'Lista ou planilha, e alguém cobra o retorno', 'CRM com etapas, responsável e data de retorno'] },
  { id: 'marketing', nome: 'Marketing e geração de clientes', texto: 'De onde vêm os novos clientes?',
    opcoes: ['Só indicação, sem ação nossa', 'Redes sociais, sem frequência', 'Redes e anúncios com alguma frequência', 'Plano de marketing com metas e custo por cliente medido'] },
  { id: 'atendimento', nome: 'Atendimento ao cliente', texto: 'Quanto tempo um cliente espera por resposta no WhatsApp?',
    opcoes: ['Horas ou até dias', 'Até 1 hora em horário comercial', 'Poucos minutos em horário comercial', 'Resposta imediata, inclusive fora do horário'] },
  { id: 'processos', nome: 'Processos e operação', texto: 'As principais tarefas da empresa estão padronizadas?',
    opcoes: ['Cada um faz de um jeito', 'Algumas, mas só na cabeça das pessoas', 'Os principais processos estão escritos', 'Processos escritos, treinados e revisados'] },
  { id: 'pessoas', nome: 'Pessoas e liderança', texto: 'Como você acompanha o desempenho da equipe?',
    opcoes: ['Não acompanho', 'Conversas informais', 'Metas para alguns cargos', 'Metas, indicadores e reuniões periódicas para todos'] },
  { id: 'tecnologia', nome: 'Tecnologia e sistemas', texto: 'Como estão os sistemas da empresa?',
    opcoes: ['Quase tudo no papel e no WhatsApp', 'Planilhas soltas', 'Tem sistema de gestão (ERP), mas mal aproveitado', 'ERP integrado e bem usado, com automações'] },
  { id: 'indicadores', nome: 'Indicadores e decisões', texto: 'Como são tomadas as decisões importantes?',
    opcoes: ['Pela intuição', 'Olhando o saldo do banco', 'Com alguns relatórios mensais', 'Com indicadores acompanhados toda semana'] },
  { id: 'estrategia', nome: 'Estratégia e dependência do dono', texto: 'Quanto a empresa depende de você no dia a dia?',
    opcoes: ['Para tudo: se eu parar, ela para', 'Para a maioria das decisões', 'Só para decisões estratégicas', 'Funciona sem mim, com metas e plano anual'] },
];

export const PERGUNTAS = [...CONTEXTO.map((p) => ({ ...p, contexto: true })), ...AREAS];

// Biblioteca de situações e melhorias por área (base do relatório; a IA personaliza por cima).
export const BIBLIOTECA = {
  financeiro: {
    critico: 'O controle de contas a pagar e a receber é informal. Isso causa atrasos, juros, cobranças esquecidas e falta de visão do caixa futuro.',
    atencao: 'Existe controle, mas sem rotina fixa. Os números chegam atrasados e não permitem prever falta de caixa com antecedência.',
    bom: 'O controle financeiro é organizado. O próximo passo é usar esses dados para planejar, e não só registrar.',
    melhorias: ['Centralizar contas a pagar e a receber em um único sistema', 'Criar rotina diária de lançamento e conciliação bancária', 'Montar um fluxo de caixa projetado para 90 dias'],
  },
  margem: {
    critico: 'A empresa vende sem saber quanto lucra em cada venda. É comum faturar bem e não sobrar dinheiro no fim do mês.',
    atencao: 'A margem é conhecida só por aproximação. Alguns produtos podem estar dando prejuízo sem ninguém perceber.',
    bom: 'A margem é acompanhada. Vale revisar a precificação com frequência para proteger o resultado da inflação de custos.',
    melhorias: ['Calcular o custo real e a margem de cada produto ou serviço', 'Revisar a tabela de preços com base na margem mínima desejada', 'Acompanhar a margem de contribuição todo mês'],
  },
  comercial: {
    critico: 'Orçamentos são enviados e esquecidos. Grande parte das vendas se perde por falta de retorno, não por preço.',
    atencao: 'Existe algum acompanhamento, mas depende da memória das pessoas. Sem rotina, as oportunidades esfriam.',
    bom: 'O funil comercial está estruturado. O próximo nível é medir a conversão por etapa e por vendedor.',
    melhorias: ['Implantar um CRM com etapas, responsável e data de próximo contato', 'Definir uma cadência de retorno para todo orçamento enviado', 'Medir a taxa de conversão e o ticket médio todo mês'],
  },
  marketing: {
    critico: 'A empresa depende de indicação. Não há controle sobre quantos clientes novos chegam, e o crescimento fica imprevisível.',
    atencao: 'Existe presença digital, mas sem constância nem medição. É difícil saber o que traz cliente de verdade.',
    bom: 'O marketing gera clientes de forma previsível. Vale reduzir o custo por cliente e aumentar a recompra.',
    melhorias: ['Definir o cliente ideal e a proposta de valor da empresa', 'Criar um calendário fixo de conteúdo e campanhas', 'Medir o custo e a origem de cada cliente novo'],
  },
  atendimento: {
    critico: 'A demora no atendimento faz o cliente procurar o concorrente. Cada hora sem resposta é venda perdida.',
    atencao: 'O atendimento funciona no horário comercial, mas fora dele a empresa fica invisível, e é aí que muitos clientes pesquisam.',
    bom: 'O atendimento é rápido. O próximo passo é padronizar as respostas e registrar cada contato para vender mais.',
    melhorias: ['Responder em minutos com um assistente de IA no WhatsApp, 24 horas', 'Padronizar as respostas das perguntas mais comuns', 'Registrar todo atendimento no CRM para não perder o histórico'],
  },
  processos: {
    critico: 'Cada pessoa faz de um jeito. Os erros se repetem, o retrabalho é alto e a empresa não consegue crescer sem bagunça.',
    atencao: 'Parte do conhecimento está só na cabeça das pessoas. Se alguém sai, a operação sofre.',
    bom: 'Os processos estão documentados. Vale automatizar as tarefas repetitivas e medir a produtividade.',
    melhorias: ['Mapear e escrever os 5 processos mais importantes', 'Treinar a equipe e definir um responsável por processo', 'Automatizar as tarefas repetitivas'],
  },
  pessoas: {
    critico: 'Sem metas nem acompanhamento, a equipe não sabe o que é esperado. O desempenho depende da boa vontade de cada um.',
    atencao: 'Há metas em alguns cargos, mas sem rotina de acompanhamento. Os problemas aparecem tarde.',
    bom: 'A equipe tem metas e acompanhamento. O próximo passo é desenvolver líderes para tirar peso do dono.',
    melhorias: ['Definir metas claras para cada função', 'Criar uma reunião semanal curta de acompanhamento', 'Preparar líderes para assumir decisões do dia a dia'],
  },
  tecnologia: {
    critico: 'A gestão roda em papel e WhatsApp. Informações se perdem, e é impossível ter números confiáveis.',
    atencao: 'As ferramentas existem, mas não conversam entre si. Há trabalho manual e retrabalho de digitação.',
    bom: 'Os sistemas são bem usados. Vale integrar o que falta e usar IA para ganhar tempo nas rotinas.',
    melhorias: ['Escolher e implantar um sistema de gestão adequado ao porte', 'Integrar vendas, estoque e financeiro', 'Usar IA para automatizar atendimento e relatórios'],
  },
  indicadores: {
    critico: 'As decisões são tomadas no escuro. Problemas só aparecem quando o caixa aperta.',
    atencao: 'Existem alguns relatórios, mas chegam tarde para corrigir o rumo.',
    bom: 'A empresa decide com dados. Vale definir metas por indicador e revisar o plano todo trimestre.',
    melhorias: ['Definir os 5 a 7 indicadores principais do negócio', 'Montar um painel atualizado toda semana', 'Criar uma reunião mensal de resultados com plano de ação'],
  },
  estrategia: {
    critico: 'A empresa depende totalmente do dono. Isso limita o crescimento e coloca o negócio em risco se ele precisar se afastar.',
    atencao: 'O dono ainda concentra a maioria das decisões e não sobra tempo para pensar no futuro do negócio.',
    bom: 'A empresa tem autonomia. O próximo passo é um plano estratégico de médio prazo com metas de crescimento.',
    melhorias: ['Delegar decisões operacionais com regras claras', 'Montar um plano anual com metas e prioridades', 'Separar o papel de dono do papel de gestor'],
  },
};

export const nivel = (nota) => (nota < 40 ? 'critico' : nota < 70 ? 'atencao' : 'bom');
export const NIVEL_NOME = { critico: 'Crítico', atencao: 'Atenção', bom: 'Bom' };

export function formatarPergunta(i) {
  const p = PERGUNTAS[i];
  const total = PERGUNTAS.length;
  return `*${i + 1}/${total}* ${p.texto}\n\n${p.opcoes.map((o, k) => `${LETRAS[k]}) ${o}`).join('\n')}\n\nResponda com a letra.`;
}

function lerResposta(texto, pergunta) {
  const t = String(texto || '').trim();
  const m = t.match(/^\(?\s*([a-eA-E1-5])\s*[).:-]?(\s|$)/);
  let idx = -1;
  if (m) idx = /\d/.test(m[1]) ? Number(m[1]) - 1 : LETRAS.indexOf(m[1].toUpperCase());
  if (idx < 0) {
    const low = t.toLowerCase();
    idx = pergunta.opcoes.findIndex((o) => low.length > 3 && o.toLowerCase().includes(low));
  }
  return idx >= 0 && idx < pergunta.opcoes.length ? idx : -1;
}

export function calcularNotas(respostas) {
  const notas = {};
  for (const a of AREAS) notas[a.id] = PONTOS[respostas[a.id]] ?? 0;
  const geral = Math.round(Object.values(notas).reduce((s, n) => s + n, 0) / AREAS.length);
  return { notas, geral };
}

export function getDiagnosticoAtivo(contactId) {
  return db.prepare("SELECT * FROM diagnostics WHERE contact_id = ? AND status = 'em_andamento' ORDER BY id DESC LIMIT 1").get(contactId);
}

export function iniciarDiagnostico(tenant, contact, conv) {
  const atual = getDiagnosticoAtivo(contact.id);
  if (atual) return atual;
  const r = db.prepare('INSERT INTO diagnostics (tenant_id, contact_id, conversation_id, valor, token) VALUES (?, ?, ?, ?, ?)')
    .run(tenant.id, contact.id, conv.id, tenant.diagnostico_preco, crypto.randomBytes(16).toString('hex'));
  return db.prepare('SELECT * FROM diagnostics WHERE id = ?').get(r.lastInsertRowid);
}

export function upsertLeadDiagnostico(tenant, contact, conv, etapa, extra = {}) {
  db.prepare(`INSERT INTO leads (tenant_id, contact_id, conversation_id, nome, interesse, etapa, resumo, valor_estimado, origem, criado_em)
    VALUES (?, ?, ?, ?, 'Diagnóstico empresarial', ?, ?, ?, 'whatsapp', datetime('now'))
    ON CONFLICT(tenant_id, contact_id) DO UPDATE SET interesse = excluded.interesse, etapa = excluded.etapa,
      resumo = COALESCE(excluded.resumo, leads.resumo), valor_estimado = COALESCE(excluded.valor_estimado, leads.valor_estimado),
      fechado_em = CASE WHEN excluded.etapa = 'fechado' THEN datetime('now') ELSE leads.fechado_em END, atualizado_em = datetime('now')`)
    .run(tenant.id, contact.id, conv?.id ?? null, contact.nome || null, etapa, extra.resumo || null, extra.valor ?? null);
  return db.prepare('SELECT id FROM leads WHERE tenant_id = ? AND contact_id = ?').get(tenant.id, contact.id);
}

/**
 * Processa uma resposta durante o diagnóstico. Retorna { mensagens: [texto], concluido: diag|null }.
 */
export function responderDiagnostico(diag, texto) {
  if (/^(parar|cancelar|sair)$/i.test(String(texto).trim())) {
    db.prepare("UPDATE diagnostics SET status = 'cancelado' WHERE id = ?").run(diag.id);
    return { mensagens: ['Tudo bem, pausei o diagnóstico. Quando quiser retomar, é só pedir.'], concluido: null };
  }
  const p = PERGUNTAS[diag.etapa];
  const idx = lerResposta(texto, p);
  if (idx < 0) return { mensagens: [`Não entendi. Responda só com a letra (${LETRAS.slice(0, p.opcoes.length).join(', ')}).\n\n${formatarPergunta(diag.etapa)}`], concluido: null };

  const respostas = { ...JSON.parse(diag.respostas), [p.id]: idx };
  const prox = diag.etapa + 1;
  if (prox < PERGUNTAS.length) {
    db.prepare('UPDATE diagnostics SET respostas = ?, etapa = ? WHERE id = ?').run(JSON.stringify(respostas), prox, diag.id);
    return { mensagens: [formatarPergunta(prox)], concluido: null };
  }
  const { notas, geral } = calcularNotas(respostas);
  db.prepare("UPDATE diagnostics SET respostas = ?, etapa = ?, notas = ?, nota_geral = ?, status = 'aguardando_pagamento' WHERE id = ?")
    .run(JSON.stringify(respostas), prox, JSON.stringify(notas), geral, diag.id);
  return { mensagens: [], concluido: db.prepare('SELECT * FROM diagnostics WHERE id = ?').get(diag.id) };
}

// Prévia grátis: nota geral e onde estão os problemas, sem o detalhe.
export function mensagemPrevia(diag, tenant) {
  const notas = JSON.parse(diag.notas);
  const ord = AREAS.map((a) => ({ ...a, nota: notas[a.id] })).sort((x, y) => x.nota - y.nota);
  const criticos = ord.filter((a) => nivel(a.nota) === 'critico');
  const atencao = ord.filter((a) => nivel(a.nota) === 'atencao');
  const piores = ord.slice(0, 3).map((a) => `• ${a.nome}`).join('\n');
  return `✅ *Diagnóstico concluído!*\n\n*Nota geral da sua empresa: ${diag.nota_geral}/100*\n` +
    `${criticos.length} área(s) em nível crítico e ${atencao.length} em atenção.\n\nAs áreas que mais precisam de cuidado agora:\n${piores}\n\n` +
    `No *relatório completo* você recebe a situação de cada uma das 10 áreas, as melhorias recomendadas e um plano de ação de 90 dias.`;
}

export function mensagemPagamento(diag, url) {
  const valor = Number(diag.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  return `Para liberar o relatório completo, o investimento é de *${valor}* (Pix ou cartão):\n${url}\n\nAssim que o pagamento for confirmado, eu te envio o relatório aqui mesmo.`;
}

export function dadosRelatorio(diag) {
  const notas = JSON.parse(diag.notas || '{}');
  const respostas = JSON.parse(diag.respostas || '{}');
  const areas = AREAS.map((a) => {
    const n = notas[a.id] ?? 0; const nv = nivel(n);
    return { id: a.id, nome: a.nome, nota: n, nivel: nv, nivel_nome: NIVEL_NOME[nv], resposta: a.opcoes[respostas[a.id]],
      situacao: BIBLIOTECA[a.id][nv], melhorias: BIBLIOTECA[a.id].melhorias };
  });
  const contexto = Object.fromEntries(CONTEXTO.map((c) => [c.id, c.opcoes[respostas[c.id]]]));
  const prioridades = [...areas].sort((x, y) => x.nota - y.nota).slice(0, 3);
  const plano = [
    { fase: 'Dias 1 a 30', foco: prioridades[0].nome, acoes: prioridades[0].melhorias.slice(0, 2) },
    { fase: 'Dias 31 a 60', foco: prioridades[1].nome, acoes: [prioridades[0].melhorias[2], ...prioridades[1].melhorias.slice(0, 2)] },
    { fase: 'Dias 61 a 90', foco: prioridades[2].nome, acoes: [prioridades[1].melhorias[2], ...prioridades[2].melhorias.slice(0, 2)] },
  ];
  return { areas, contexto, prioridades, plano, ia: diag.relatorio_ia ? JSON.parse(diag.relatorio_ia) : null };
}

// Contexto do cliente para a IA (ex.: no contato de follow-up e na conversa sobre consultoria).
export function contextoClienteIA(contactId) {
  const d = db.prepare("SELECT * FROM diagnostics WHERE contact_id = ? AND status IN ('aguardando_pagamento','pago') ORDER BY id DESC LIMIT 1").get(contactId);
  if (!d) return '';
  const { prioridades } = dadosRelatorio(d);
  return `Este cliente fez o Diagnóstico Empresarial: nota geral ${d.nota_geral}/100. ` +
    `Áreas mais fracas: ${prioridades.map((p) => `${p.nome} (${p.nota})`).join(', ')}. ` +
    (d.status === 'pago' ? 'Ele já pagou e recebeu o relatório completo. O próximo passo é a reunião gratuita de consultoria.' : 'Ele ainda não pagou o relatório completo.');
}

export function registrarConclusao(tenant, contact, conv, diag) {
  const lead = upsertLeadDiagnostico(tenant, contact, conv, 'proposta', { resumo: `Diagnóstico concluído: nota ${diag.nota_geral}/100`, valor: diag.valor });
  logActivity(tenant.id, lead.id, `Concluiu o diagnóstico (nota ${diag.nota_geral}/100). Link de pagamento enviado.`, { autor: 'ia' });
}
