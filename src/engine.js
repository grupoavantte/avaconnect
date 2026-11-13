// Orquestra uma mensagem recebida: contato -> conversa -> IA/humano -> resposta.
import { db, bumpUsage, getUsage, logActivity } from './db.js';
import { getPlan } from './plans.js';
import { generateReply } from './ai.js';
import { sendText } from './whatsapp.js';

const NOVA_CONVERSA_HORAS = 24;

function upsertContact(tenantId, telefone, nome) {
  db.prepare(`INSERT INTO contacts (tenant_id, telefone, nome) VALUES (?, ?, ?)
    ON CONFLICT(tenant_id, telefone) DO UPDATE SET nome = COALESCE(contacts.nome, excluded.nome)`)
    .run(tenantId, telefone, nome || null);
  return db.prepare('SELECT * FROM contacts WHERE tenant_id = ? AND telefone = ?').get(tenantId, telefone);
}

function openConversation(tenant, contact, canal) {
  const atual = db.prepare(`SELECT * FROM conversations WHERE contact_id = ? AND status != 'encerrada'
    AND ultima_mensagem_em > datetime('now', ?) ORDER BY id DESC LIMIT 1`)
    .get(contact.id, `-${NOVA_CONVERSA_HORAS} hours`);
  if (atual) return { conv: atual, nova: false };
  const r = db.prepare('INSERT INTO conversations (tenant_id, contact_id, canal) VALUES (?, ?, ?)')
    .run(tenant.id, contact.id, canal);
  bumpUsage(tenant.id, 'conversas');
  return { conv: db.prepare('SELECT * FROM conversations WHERE id = ?').get(r.lastInsertRowid), nova: true };
}

export function addMessage(conversationId, autor, conteudo, waId = null) {
  db.prepare('INSERT INTO messages (conversation_id, autor, conteudo, wa_id) VALUES (?, ?, ?, ?)')
    .run(conversationId, autor, conteudo, waId);
  db.prepare("UPDATE conversations SET ultima_mensagem_em = datetime('now') WHERE id = ?").run(conversationId);
}

function makeToolExecutor(tenant, contact, conv) {
  return async (nome, input) => {
    if (nome === 'registrar_lead') {
      const antes = db.prepare('SELECT id, etapa FROM leads WHERE tenant_id = ? AND contact_id = ?').get(tenant.id, contact.id);
      // A IA só avança etapas abertas; nunca reabre fechado/perdido nem volta etapa.
      const ordem = { novo: 0, qualificado: 1, proposta: 2 };
      const etapa = antes && (['fechado', 'perdido'].includes(antes.etapa) || (ordem[antes.etapa] ?? 0) > (ordem[input.etapa] ?? 0))
        ? antes.etapa : (input.etapa || 'novo');
      db.prepare(`INSERT INTO leads (tenant_id, contact_id, conversation_id, nome, empresa, email, interesse, etapa, resumo, valor_estimado, origem, criado_em)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(tenant_id, contact_id) DO UPDATE SET
          conversation_id = excluded.conversation_id,
          nome = COALESCE(excluded.nome, leads.nome),
          empresa = COALESCE(excluded.empresa, leads.empresa),
          email = COALESCE(excluded.email, leads.email),
          interesse = COALESCE(excluded.interesse, leads.interesse),
          etapa = excluded.etapa,
          resumo = COALESCE(excluded.resumo, leads.resumo),
          valor_estimado = COALESCE(excluded.valor_estimado, leads.valor_estimado),
          atualizado_em = datetime('now')`)
        .run(tenant.id, contact.id, conv.id, input.nome || null, input.empresa || null, input.email || null,
          input.interesse || null, etapa, input.resumo || null, input.valor_estimado ?? null,
          conv.canal === 'simulador' ? 'simulador' : 'whatsapp');
      if (input.nome) db.prepare('UPDATE contacts SET nome = ? WHERE id = ?').run(input.nome, contact.id);
      const lead = db.prepare('SELECT id FROM leads WHERE tenant_id = ? AND contact_id = ?').get(tenant.id, contact.id);
      if (!antes) logActivity(tenant.id, lead.id, `Lead criado pela IA: ${input.interesse || ''}`, { autor: 'ia' });
      else if (antes.etapa !== etapa) logActivity(tenant.id, lead.id, `IA moveu de ${antes.etapa} para ${etapa}`, { autor: 'ia' });
      return 'Lead registrado no CRM.';
    }
    if (nome === 'agendar_retorno') {
      let lead = db.prepare('SELECT id FROM leads WHERE tenant_id = ? AND contact_id = ?').get(tenant.id, contact.id);
      if (!lead) {
        db.prepare(`INSERT INTO leads (tenant_id, contact_id, conversation_id, etapa, origem, criado_em) VALUES (?, ?, ?, 'novo', ?, datetime('now'))`)
          .run(tenant.id, contact.id, conv.id, conv.canal === 'simulador' ? 'simulador' : 'whatsapp');
        lead = db.prepare('SELECT id FROM leads WHERE tenant_id = ? AND contact_id = ?').get(tenant.id, contact.id);
      }
      const data = /^\d{4}-\d{2}-\d{2}/.test(input.data || '') ? input.data.slice(0, 16) : null;
      logActivity(tenant.id, lead.id, `Retornar contato: ${input.motivo}`, { tipo: 'tarefa', autor: 'ia', vence_em: data });
      return `Retorno agendado${data ? ' para ' + data : ''}. Confirme ao cliente que a equipe vai retornar.`;
    }
    if (nome === 'transferir_humano') {
      db.prepare("UPDATE conversations SET status = 'humano', motivo_transbordo = ? WHERE id = ?").run(input.motivo, conv.id);
      addMessage(conv.id, 'sistema', `Transferida para humano: ${input.motivo}`);
      const lead = db.prepare('SELECT id FROM leads WHERE tenant_id = ? AND contact_id = ?').get(tenant.id, contact.id);
      if (lead) logActivity(tenant.id, lead.id, `Conversa transferida para atendente: ${input.motivo}`, { autor: 'ia' });
      if (tenant.telefone_responsavel && conv.canal === 'whatsapp') {
        await sendText(tenant, tenant.telefone_responsavel,
          `AVA Connect: ${contact.nome || contact.telefone} precisa de um atendente. Motivo: ${input.motivo}`);
      }
      return 'Conversa transferida. Avise o cliente que um atendente vai continuar.';
    }
    return 'Ferramenta desconhecida.';
  };
}

/**
 * Processa uma mensagem de cliente. Retorna { conversation_id, respostas: [texto], status }.
 */
export async function handleIncoming(tenant, { telefone, nome, texto, waId = null, canal = 'whatsapp' }) {
  if (waId && db.prepare('SELECT 1 FROM messages WHERE wa_id = ?').get(waId)) {
    return { duplicada: true, respostas: [] };
  }
  const contact = upsertContact(tenant.id, telefone, nome);
  const { conv } = openConversation(tenant, contact, canal);
  addMessage(conv.id, 'cliente', texto, waId);

  const enviar = async (t) => {
    addMessage(conv.id, 'ia', t);
    if (canal === 'whatsapp') await sendText(tenant, telefone, t);
  };

  if (tenant.status !== 'ativo') return { conversation_id: conv.id, respostas: [], status: conv.status };

  // Conversa já com humano: a IA fica em silêncio.
  if (conv.status === 'humano') return { conversation_id: conv.id, respostas: [], status: 'humano' };

  // Limite do plano.
  const plano = getPlan(tenant.plano);
  if (getUsage(tenant.id).conversas > plano.conversas_mes) {
    const msg = `Obrigado pelo contato! Um atendente da ${tenant.nome} vai te responder em breve.`;
    db.prepare("UPDATE conversations SET status = 'humano', motivo_transbordo = 'Limite do plano atingido' WHERE id = ?").run(conv.id);
    await enviar(msg);
    return { conversation_id: conv.id, respostas: [msg], status: 'humano', limite_atingido: true };
  }

  const historico = db.prepare('SELECT autor, conteudo FROM messages WHERE conversation_id = ? ORDER BY id').all(conv.id);
  let resposta;
  try {
    resposta = await generateReply(tenant, historico, makeToolExecutor(tenant, contact, conv));
  } catch (e) {
    console.error('[ia] erro', e.message);
    db.prepare("UPDATE conversations SET status = 'humano', motivo_transbordo = 'Falha da IA' WHERE id = ?").run(conv.id);
    resposta = { texto: 'Recebi sua mensagem! Um atendente vai te responder em instantes.', ferramentas: [] };
  }
  bumpUsage(tenant.id, 'mensagens_ia');
  if (resposta.texto) await enviar(resposta.texto);

  const status = db.prepare('SELECT status FROM conversations WHERE id = ?').get(conv.id).status;
  return { conversation_id: conv.id, respostas: resposta.texto ? [resposta.texto] : [], ferramentas: resposta.ferramentas, status };
}

// Resposta de um atendente humano pelo painel.
export async function humanReply(conv, texto) {
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(conv.tenant_id);
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(conv.contact_id);
  addMessage(conv.id, 'humano', texto);
  if (conv.status === 'ia') db.prepare("UPDATE conversations SET status = 'humano' WHERE id = ?").run(conv.id);
  if (conv.canal === 'whatsapp') await sendText(tenant, contact.telefone, texto);
}
