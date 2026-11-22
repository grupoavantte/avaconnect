// Funil do diagnóstico: conclusão → cobrança → pagamento → relatório → follow-up D+1 (consultoria).
import { db, logActivity } from './db.js';
import { sendText, sendTemplate } from './whatsapp.js';
import { criarCobrancaDiagnostico, publicUrl } from './payments.js';
import { mensagemPrevia, mensagemPagamento, registrarConclusao, upsertLeadDiagnostico, dadosRelatorio } from './diagnostico.js';
import { analisarDiagnostico } from './ai.js';

const FOLLOWUP_MIN = Number(process.env.FOLLOWUP_DELAY_MIN || 1440); // 24h

function salvarMensagem(convId, autor, conteudo) {
  if (!convId) return;
  db.prepare('INSERT INTO messages (conversation_id, autor, conteudo) VALUES (?, ?, ?)').run(convId, autor, conteudo);
  db.prepare("UPDATE conversations SET ultima_mensagem_em = datetime('now') WHERE id = ?").run(convId);
}

async function enviar(tenant, contact, conv, texto) {
  salvarMensagem(conv?.id, 'ia', texto);
  if (!conv || conv.canal === 'whatsapp') await sendText(tenant, contact.telefone, texto);
}

/** Chamado quando o cliente responde a última pergunta. Retorna as mensagens enviadas. */
export async function concluirDiagnostico(tenant, contact, conv, diag) {
  registrarConclusao(tenant, contact, conv, diag);
  const msgs = [mensagemPrevia(diag, tenant)];
  try {
    const { ref, url } = await criarCobrancaDiagnostico(tenant, diag);
    db.prepare('UPDATE diagnostics SET pagamento_ref = ?, pagamento_url = ? WHERE id = ?').run(ref, url, diag.id);
    msgs.push(mensagemPagamento(diag, url));
  } catch (e) {
    console.error('[pagamento] erro ao criar cobrança', e.message);
    msgs.push('Vou pedir para nossa equipe te enviar o link de pagamento em instantes.');
    db.prepare("UPDATE conversations SET status = 'humano', motivo_transbordo = 'Falha ao gerar link de pagamento' WHERE id = ?").run(conv.id);
  }
  for (const m of msgs) await enviar(tenant, contact, conv, m);
  return msgs;
}

/** Confirma o pagamento (webhook ou simulação). Idempotente. */
export async function confirmarPagamento(diag) {
  if (!diag || diag.status === 'pago') return { jaPago: true };
  if (diag.status !== 'aguardando_pagamento') return { ignorado: diag.status };
  db.prepare("UPDATE diagnostics SET status = 'pago', pago_em = datetime('now') WHERE id = ?").run(diag.id);
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(diag.tenant_id);
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(diag.contact_id);
  const conv = diag.conversation_id ? db.prepare('SELECT * FROM conversations WHERE id = ?').get(diag.conversation_id) : null;

  const lead = upsertLeadDiagnostico(tenant, contact, conv, 'fechado', { valor: diag.valor });
  logActivity(tenant.id, lead.id, `Pagou o diagnóstico (${Number(diag.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}). Relatório liberado.`, { autor: 'sistema' });

  try {
    const analise = await analisarDiagnostico(tenant, dadosRelatorio(diag));
    if (analise) db.prepare('UPDATE diagnostics SET relatorio_ia = ? WHERE id = ?').run(JSON.stringify(analise), diag.id);
  } catch (e) { console.error('[diagnostico] análise da IA falhou, relatório usa a biblioteca', e.message); }

  await enviar(tenant, contact, conv,
    `🎉 Pagamento confirmado! Aqui está o relatório completo do seu diagnóstico:\n${publicUrl()}/relatorio/${diag.token}\n\n` +
    'Nele você vê a situação de cada área, as melhorias recomendadas e o plano de 90 dias. Qualquer dúvida, é só me chamar aqui.');

  agendarJob('followup_consultoria', { diagnostic_id: diag.id }, FOLLOWUP_MIN);
  logActivity(tenant.id, lead.id, 'Contato sobre a consultoria agendado para o dia seguinte', { tipo: 'tarefa', autor: 'sistema',
    vence_em: new Date(Date.now() + FOLLOWUP_MIN * 60000).toISOString().slice(0, 10) });
  return { ok: true };
}

// ---------------- Agendador de tarefas ----------------
export function agendarJob(tipo, payload, minutos) {
  db.prepare("INSERT INTO jobs (tipo, payload, executar_em) VALUES (?, ?, datetime('now', ?))")
    .run(tipo, JSON.stringify(payload), `+${Math.round(minutos)} minutes`);
}

import { HANDLERS, periodicas } from './ganchos.js';
export { HANDLERS };
Object.assign(HANDLERS, {
  async followup_consultoria({ diagnostic_id }) {
    const diag = db.prepare('SELECT * FROM diagnostics WHERE id = ?').get(diagnostic_id);
    if (!diag || diag.status !== 'pago') return 'diagnóstico não está pago';
    const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(diag.tenant_id);
    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(diag.contact_id);
    let conv = diag.conversation_id ? db.prepare('SELECT * FROM conversations WHERE id = ?').get(diag.conversation_id) : null;
    const { prioridades } = dadosRelatorio(diag);
    const nome = (contact.nome || '').split(' ')[0] || 'tudo bem';
    const area = prioridades[0];
    const ultimaDoCliente = db.prepare(`SELECT MAX(m.criado_em) t FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE c.contact_id = ? AND m.autor = 'cliente'`).get(contact.id).t;
    const dentroDaJanela = ultimaDoCliente && (Date.now() - new Date(ultimaDoCliente.replace(' ', 'T') + 'Z')) < 23.5 * 3600e3;

    const texto = `Olá, ${nome}! Aqui é a ${tenant.nome_assistente}, da ${tenant.nome}. 😊\n\n` +
      `Você já conseguiu olhar o seu diagnóstico? O ponto mais urgente foi *${area.nome}* (nota ${area.nota}/100).\n\n` +
      `Nossa equipe pode te mostrar, numa *reunião gratuita*, como colocar o plano de melhorias em prática na sua empresa.` +
      (tenant.link_agendamento ? `\n\nEscolha o melhor horário aqui:\n${tenant.link_agendamento}` : '\n\nQual o melhor dia e horário para você?');

    if (dentroDaJanela) {
      await sendText(tenant, contact.telefone, texto);
    } else if (tenant.wa_template_followup) {
      await sendTemplate(tenant, contact.telefone, tenant.wa_template_followup, [nome, area.nome]);
    } else if (tenant.wa_phone_number_id) {
      const lead = db.prepare('SELECT id FROM leads WHERE tenant_id = ? AND contact_id = ?').get(tenant.id, contact.id);
      if (lead) logActivity(tenant.id, lead.id, 'Ligar ou mandar mensagem oferecendo a reunião de consultoria (fora da janela de 24h e sem modelo aprovado na Meta)',
        { tipo: 'tarefa', autor: 'sistema', vence_em: new Date().toISOString().slice(0, 10) });
      return 'fora da janela de 24h e sem modelo aprovado: tarefa criada para a equipe';
    } else {
      await sendText(tenant, contact.telefone, texto); // modo simulado
    }
    if (!conv || conv.status === 'encerrada') {
      const r = db.prepare("INSERT INTO conversations (tenant_id, contact_id, canal) VALUES (?, ?, 'whatsapp')").run(tenant.id, contact.id);
      conv = { id: r.lastInsertRowid };
    } else db.prepare("UPDATE conversations SET status = 'ia' WHERE id = ?").run(conv.id);
    salvarMensagem(conv.id, 'ia', texto);
    const lead = db.prepare('SELECT id FROM leads WHERE tenant_id = ? AND contact_id = ?').get(tenant.id, contact.id);
    if (lead) {
      db.prepare("UPDATE leads SET interesse = 'Consultoria (pós-diagnóstico)', etapa = 'qualificado', valor_estimado = NULL, fechado_em = NULL, atualizado_em = datetime('now') WHERE id = ?").run(lead.id);
      db.prepare("UPDATE activities SET concluida = 1 WHERE lead_id = ? AND tipo = 'tarefa' AND descricao LIKE 'Contato sobre a consultoria%'").run(lead.id);
      logActivity(tenant.id, lead.id, 'IA ofereceu a reunião gratuita de consultoria', { autor: 'ia' });
    }
    return 'enviado';
  },
});

export async function rodarJobs() {
  for (const p of periodicas) await p().catch((e) => console.error('[periodica]', e.message));
  const due = db.prepare("SELECT * FROM jobs WHERE status = 'pendente' AND executar_em <= datetime('now') ORDER BY id LIMIT 20").all();
  for (const j of due) {
    db.prepare("UPDATE jobs SET status = 'executando' WHERE id = ? AND status = 'pendente'").run(j.id);
    try {
      const r = await HANDLERS[j.tipo]?.(JSON.parse(j.payload));
      db.prepare("UPDATE jobs SET status = 'feito', resultado = ? WHERE id = ?").run(String(r ?? ''), j.id);
    } catch (e) {
      console.error('[jobs] erro', j.tipo, e.message);
      db.prepare("UPDATE jobs SET status = 'erro', resultado = ? WHERE id = ?").run(e.message, j.id);
    }
  }
  return due.length;
}

export function iniciarAgendador() {
  db.prepare("UPDATE jobs SET status = 'pendente' WHERE status = 'executando'").run();
  setInterval(() => rodarJobs().catch((e) => console.error('[jobs]', e)), 60_000).unref();
}
