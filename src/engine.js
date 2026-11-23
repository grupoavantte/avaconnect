import { possivelComprovante } from './gateways.js';
import { contextoCanal, contarConversa, vincularCodigoSite } from './canais.js';
import { sendEmail } from './email.js';
import { distribuir, entrarNaCarteira, antesDeAtender } from './operacao.js';
// Orquestra uma mensagem recebida: contato -> conversa -> IA/humano -> resposta.
import { db, bumpUsage, getUsage, logActivity } from './db.js';
import { getPlan } from './plans.js';
import { generateReply } from './ai.js';
import { sendText } from './whatsapp.js';
import { getDiagnosticoAtivo, iniciarDiagnostico, responderDiagnostico, formatarPergunta, contextoClienteIA, upsertLeadDiagnostico } from './diagnostico.js';
import { concluirDiagnostico } from './funil.js';
import { executarFerramentaVendas, contextoVendas, agendarReengajamento, agendarEm, aprovarProposta } from './vendas.js';
import { executarFerramentaLoja } from './loja.js';
import { sendImage } from './whatsapp.js';
import { efetivo, efetivoDoContato, getAgente, numeroPorPhoneId } from './agents.js';
import { telefonesAprovadores } from './auth.js';
import { prepararEntrada, salvarMidia, midiasDaConversa } from './midia.js';

const NOVA_CONVERSA_HORAS = 24;

function upsertContact(tenantId, telefone, nome) {
  db.prepare(`INSERT INTO contacts (tenant_id, telefone, nome) VALUES (?, ?, ?)
    ON CONFLICT(tenant_id, telefone) DO UPDATE SET nome = COALESCE(contacts.nome, excluded.nome)`)
    .run(tenantId, telefone, nome || null);
  return db.prepare('SELECT * FROM contacts WHERE tenant_id = ? AND telefone = ?').get(tenantId, telefone);
}

function openConversation(tenant, contact, canal, { agentId = null, numeroId = null } = {}) {
  const atual = db.prepare(`SELECT * FROM conversations WHERE contact_id = ? AND status != 'encerrada'
    AND ultima_mensagem_em > datetime('now', ?) ORDER BY id DESC LIMIT 1`)
    .get(contact.id, `-${NOVA_CONVERSA_HORAS} hours`);
  if (atual) return { conv: atual, nova: false };
  const r = db.prepare('INSERT INTO conversations (tenant_id, contact_id, canal, agent_id, numero_id) VALUES (?, ?, ?, ?, ?)')
    .run(tenant.id, contact.id, canal, agentId, numeroId);
  contarConversa(tenant.id, canal); // site, formulário e e-mail não consomem o limite de conversas de WhatsApp
  return { conv: db.prepare('SELECT * FROM conversations WHERE id = ?').get(r.lastInsertRowid), nova: true };
}

export function addMessage(conversationId, autor, conteudo, waId = null) {
  const r = db.prepare('INSERT INTO messages (conversation_id, autor, conteudo, wa_id) VALUES (?, ?, ?, ?)')
    .run(conversationId, autor, conteudo, waId);
  db.prepare("UPDATE conversations SET ultima_mensagem_em = datetime('now') WHERE id = ?").run(conversationId);
  return Number(r.lastInsertRowid);
}

function makeToolExecutor(tenant, contact, conv, enviar, enviarImagem) {
  return async (nome, input) => {
    const venda = await executarFerramentaVendas({ tenant, contact, conv, enviar }, nome, input);
    if (venda !== null) return venda;
    const loja = await executarFerramentaLoja({ tenant, contact, conv, enviar, enviarImagem }, nome, input);
    if (loja !== null) return loja;
    if (nome === 'passar_para_agente') {
      const ag = getAgente(input.agente_id);
      if (!ag || ag.tenant_id !== tenant.id || !ag.ativo) return 'Agente inválido.';
      db.prepare('UPDATE conversations SET agent_id = ? WHERE id = ?').run(ag.id, conv.id);
      addMessage(conv.id, 'sistema', `Conversa passada para ${ag.nome} (${ag.funcao}): ${input.motivo}`);
      conv._passagem = { agente: ag, motivo: input.motivo };
      return `Conversa passada para ${ag.nome}. Não responda mais nada: ${ag.nome} vai continuar o atendimento agora.`;
    }
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
      if (input.nome) db.prepare('UPDATE contacts SET nome = ?, nome_confirmado = 1 WHERE id = ?').run(input.nome, contact.id);
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
      const actId = logActivity(tenant.id, lead.id, `Retornar contato: ${input.motivo}`, { tipo: 'tarefa', autor: 'ia', vence_em: data });
      if (tenant.vendas_ativo && data) {
        // A própria IA retoma o contato no dia combinado, às 10h (Brasília).
        const quando = new Date(`${data.slice(0, 10)}T${data.length > 10 ? data.slice(11, 16) : '10:00'}:00-03:00`);
        if (quando > new Date()) agendarEm('retorno_cliente', { contact_id: contact.id, motivo: input.motivo, activity_id: actId }, quando);
        return `Retorno agendado para ${data}. Eu mesma vou chamar o cliente nesse dia. Confirme a ele com naturalidade.`;
      }
      return `Retorno agendado${data ? ' para ' + data : ''}. Confirme ao cliente que a equipe vai retornar.`;
    }
    if (nome === 'transferir_humano') {
      db.prepare("UPDATE conversations SET motivo_transbordo = ? WHERE id = ?").run(input.motivo, conv.id);
      const u = await distribuir(tenant, conv, contact, { setor: input.setor, motivo: input.motivo });
      const s = db.prepare('SELECT setor FROM conversations WHERE id = ?').get(conv.id).setor;
      addMessage(conv.id, 'sistema', `Transferida${s ? ` para ${s}` : ''}${u ? ` · ${u.nome}` : ' (fila)'}: ${input.motivo}`);
      const lead = db.prepare('SELECT id FROM leads WHERE tenant_id = ? AND contact_id = ?').get(tenant.id, contact.id);
      if (lead) logActivity(tenant.id, lead.id, `Conversa transferida${s ? ` para ${s}` : ''}${u ? ` (${u.nome})` : ''}: ${input.motivo}`, { autor: 'ia' });
      return 'Conversa transferida. Avise o cliente que um atendente vai continuar.';
    }
    if (nome === 'iniciar_diagnostico') {
      if (!tenant.diagnostico_ativo) return 'Diagnóstico não disponível para esta empresa.';
      iniciarDiagnostico(tenant, contact, conv);
      const lead = upsertLeadDiagnostico(tenant, contact, conv, 'qualificado', {});
      logActivity(tenant.id, lead.id, 'Começou o Diagnóstico Empresarial', { autor: 'ia' });
      return 'Diagnóstico iniciado. O sistema vai enviar a primeira pergunta logo após sua mensagem. Diga apenas, em uma frase curta, que vão começar e que é só responder com a letra.';
    }
    return 'Ferramenta desconhecida.';
  };
}

/**
 * Processa uma mensagem de cliente. Retorna { conversation_id, respostas: [texto], status }.
 */
export async function handleIncoming(tenantBase, { telefone, nome, texto, waId = null, canal = 'whatsapp', phoneNumberId = null, agentId = null, entrada = null }) {
  // Número que recebeu a mensagem e agente responsável por ele.
  const numero = phoneNumberId ? numeroPorPhoneId(phoneNumberId) : null;
  let tenant = efetivo(tenantBase, { numero, agent: getAgente(agentId) });
  if (waId && db.prepare('SELECT 1 FROM messages WHERE wa_id = ?').get(waId)) {
    return { duplicada: true, respostas: [] };
  }
  // Comandos do gestor pelo WhatsApp: "APROVAR 12" / "RECUSAR 12" (proposta nº 12).
  const cmd = String(texto || '').trim().match(/^(aprovar|recusar)\s+#?(\d+)\b/i);
  if (cmd && telefonesAprovadores(tenantBase).includes(String(telefone).replace(/\D/g, ''))) {
    const p = db.prepare('SELECT * FROM proposals WHERE tenant_id = ? AND numero = ?').get(tenant.id, Number(cmd[2]));
    const r = p ? await aprovarProposta(p, cmd[1].toLowerCase() === 'aprovar', 'gestor (WhatsApp)') : { erro: 'Proposta não encontrada' };
    const msg = r.erro ? `Não deu: ${r.erro}.` : `Feito: proposta nº ${cmd[2]} ${r.status === 'enviada' ? 'aprovada e enviada ao cliente' : 'recusada; avisei o cliente'}.`;
    if (canal === 'whatsapp') await sendText(tenant, telefone, msg);
    return { comando: true, respostas: [msg] };
  }

  // Áudio, foto, documento ou localização viram texto (e a imagem/PDF vai junto para a IA ver).
  let midia = null;
  if (entrada && entrada.tipo && !['text', 'button', 'interactive'].includes(entrada.tipo)) {
    if (waId && db.prepare('SELECT 1 FROM messages WHERE wa_id = ?').get(waId)) return { duplicada: true, respostas: [] };
    ({ texto, midia } = await prepararEntrada(tenant, entrada));
  }

  const contact = upsertContact(tenant.id, telefone, nome);
  if (canal === 'whatsapp') vincularCodigoSite(tenant, contact, texto); // veio do chat do site com o código S123
  // Nota da pesquisa de satisfação, "SAIR" das campanhas e respostas a campanhas.
  const pre = await antesDeAtender(tenant, contact, texto, canal);
  if (pre?.tratada) {
    if (canal === 'whatsapp') await sendText(tenant, telefone, pre.resposta);
    return { conversation_id: pre.conversation_id ?? null, respostas: [pre.resposta], status: 'encerrada', pesquisa: !!pre.conversation_id };
  }
  const { conv } = openConversation(tenant, contact, canal, { agentId: tenant._agent_id ?? null, numeroId: tenant._numero_id ?? null });
  // Conversa em andamento continua com o agente que começou (salvo se o simulador pediu outro).
  if (!agentId && conv.agent_id && conv.agent_id !== tenant._agent_id && getAgente(conv.agent_id)?.ativo) {
    tenant = efetivo(tenantBase, { numero, agent: getAgente(conv.agent_id) });
  } else if (tenant._agent_id && conv.agent_id !== tenant._agent_id) {
    db.prepare('UPDATE conversations SET agent_id = ? WHERE id = ?').run(tenant._agent_id, conv.id);
  }
  const msgId = addMessage(conv.id, 'cliente', texto, waId);
  salvarMidia(tenant.id, msgId, midia);
  if (entrada?.tipo === 'image' || entrada?.tipo === 'document') possivelComprovante(tenant, contact, { type: entrada.tipo }).catch(() => {});

  const saida = [];
  const enviar = async (t) => {
    addMessage(conv.id, 'ia', t);
    saida.push(t);
    if (canal === 'whatsapp') await sendText(tenant, telefone, t);
  };
  const enviarImagem = async (url, legenda = '') => {
    addMessage(conv.id, 'ia', `📷 ${legenda || 'Foto'} ${url}`.trim());
    saida.push(`📷 ${legenda || 'Foto'} ${url}`.trim());
    if (canal === 'whatsapp') await sendImage(tenant, telefone, url, legenda);
  };

  if (tenant.status !== 'ativo' && canal !== 'simulador') return { conversation_id: conv.id, respostas: [], status: conv.status };

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

  // Diagnóstico em andamento: o próprio sistema conduz as perguntas (sem custo de IA).
  const diagAtivo = tenant.diagnostico_ativo ? getDiagnosticoAtivo(contact.id) : null;
  if (diagAtivo) {
    const r = responderDiagnostico(diagAtivo, texto);
    for (const m of r.mensagens) await enviar(m);
    let enviadas = r.mensagens;
    if (r.concluido) enviadas = await concluirDiagnostico(tenant, contact, { ...conv, canal }, r.concluido);
    return { conversation_id: conv.id, respostas: enviadas, status: conv.status, diagnostico: r.concluido ? 'concluido' : 'em_andamento' };
  }

  const historico = db.prepare('SELECT id, autor, conteudo FROM messages WHERE conversation_id = ? ORDER BY id').all(conv.id);
  for (const md of midiasDaConversa(conv.id)) { const h = historico.find((x) => x.id === md.message_id); if (h) (h.midia ||= []).push(md); }
  let resposta;
  try {
    const contexto = [contextoCanal(canal, contact), contextoClienteIA(contact.id), tenant.vendas_ativo ? contextoVendas(contact.id) : ''].filter(Boolean).join(' ');
    resposta = await generateReply(tenant, historico, makeToolExecutor(tenant, contact, conv, enviar, enviarImagem), contexto);
    // Passagem para outro agente: ele responde em seguida, na mesma mensagem do cliente.
    if (conv._passagem) {
      if (resposta.texto) await enviar(resposta.texto);
      const { agente, motivo } = conv._passagem; delete conv._passagem;
      tenant = efetivo(tenantBase, { numero, agent: agente });
      const hist2 = db.prepare('SELECT id, autor, conteudo FROM messages WHERE conversation_id = ? ORDER BY id').all(conv.id);
      const r2 = await generateReply(tenant, hist2, makeToolExecutor(tenant, contact, conv, enviar, enviarImagem),
        `${contexto} Você acabou de receber esta conversa de outro agente. Motivo: ${motivo}. Continue sem repetir saudação longa.`.trim());
      resposta = { texto: r2.texto, ferramentas: [...(resposta.ferramentas || []), ...(r2.ferramentas || [])] };
    }
  } catch (e) {
    console.error('[ia] erro', e.message);
    db.prepare("UPDATE conversations SET status = 'humano', motivo_transbordo = 'Falha da IA' WHERE id = ?").run(conv.id);
    resposta = { texto: 'Recebi sua mensagem! Um atendente vai te responder em instantes.', ferramentas: [] };
  }
  bumpUsage(tenant.id, 'mensagens_ia');
  if (resposta.texto) await enviar(resposta.texto);
  if (resposta.ferramentas?.some((f) => f.nome === 'iniciar_diagnostico') && getDiagnosticoAtivo(contact.id)) {
    await enviar(formatarPergunta(getDiagnosticoAtivo(contact.id).etapa));
  }
  const respostas = saida;

  const status = db.prepare('SELECT status FROM conversations WHERE id = ?').get(conv.id).status;
  if (status === 'ia' && ['whatsapp', 'simulador'].includes(canal)) agendarReengajamento(tenant, contact);
  return { conversation_id: conv.id, respostas, ferramentas: resposta.ferramentas, status };
}

// Resposta de um atendente humano pelo painel.
export async function humanReply(conv, texto, userId = null) {
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(conv.contact_id);
  const tenant = efetivoDoContato(db.prepare('SELECT * FROM tenants WHERE id = ?').get(conv.tenant_id), contact.id);
  addMessage(conv.id, 'humano', texto);
  if (conv.status !== 'humano' || (userId && !conv.atendente_id)) db.prepare("UPDATE conversations SET status = 'humano', atendente_id = COALESCE(atendente_id, ?) WHERE id = ?").run(userId, conv.id);
  entrarNaCarteira(conv, userId);
  if (conv.canal === 'whatsapp') await sendText(tenant, contact.telefone, texto);
  if (conv.canal === 'email' && contact.email) {
    const assunto = db.prepare("SELECT conteudo FROM messages WHERE conversation_id = ? AND autor = 'cliente' ORDER BY id LIMIT 1").get(conv.id)?.conteudo.match(/^Assunto: (.+)$/m)?.[1];
    await sendEmail(tenant, { to: contact.email, subject: assunto ? (/^re:/i.test(assunto) ? assunto : `Re: ${assunto}`) : `Contato com ${tenant.nome}`,
      html: `<div style="font-family:Arial,sans-serif;font-size:15px;white-space:pre-wrap">${texto.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</div>`, text: texto });
  }
  // canal 'site': a mensagem aparece no balão do visitante (o chat busca as novas a cada poucos segundos)
}
