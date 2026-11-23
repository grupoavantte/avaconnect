// Motor de IA: chama a API da Anthropic (Claude) com ferramentas.
// Sem ANTHROPIC_API_KEY, roda em modo demonstração (regras simples) para testes.

import { ferramentasVendas, promptVendas } from './vendas.js';
import { ferramentasLoja, promptLoja } from './loja.js';
import { ferramentasArquivos, promptArquivos } from './arquivos.js';
import { ferramentasFicha } from './ficha.js';
import { ferramentaPassagem, promptPassagem } from './agents.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
// Modelo barato como padrão; plano Premium pode usar um modelo mais forte (opcional).
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const MODEL_PREMIUM = process.env.ANTHROPIC_MODEL_PREMIUM || MODEL;
const modelFor = (tenant) => (tenant._modelo === 'avancado' || (tenant._modelo === undefined && tenant.plano === 'premium') ? MODEL_PREMIUM : MODEL);
export const AI_MODE = process.env.ANTHROPIC_API_KEY ? 'claude' : 'demo';

export const TOOLS = [
  {
    name: 'registrar_lead',
    description:
      'Registra ou atualiza o cliente no CRM sempre que ele demonstrar interesse em comprar, pedir orçamento, ' +
      'informar o nome, a empresa ou detalhes da necessidade. Pode ser chamada várias vezes na mesma conversa.',
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string', description: 'Nome do cliente, se informado' },
        empresa: { type: 'string', description: 'Empresa do cliente, se informada' },
        email: { type: 'string', description: 'E-mail, se informado' },
        interesse: { type: 'string', description: 'Produto ou serviço de interesse' },
        etapa: { type: 'string', enum: ['novo', 'qualificado', 'proposta'], description: 'novo = só curiosidade; qualificado = necessidade e prazo claros; proposta = pediu orçamento formal' },
        resumo: { type: 'string', description: 'Resumo curto da necessidade (quantidade, prazo, cidade, etc.)' },
        valor_estimado: { type: 'number', description: 'Valor estimado em reais, se for possível inferir pela base de conhecimento' },
      },
      required: ['interesse', 'etapa', 'resumo'],
    },
  },
  {
    name: 'agendar_retorno',
    description:
      'Cria uma tarefa de retorno no CRM quando o cliente pede para ser contatado depois (ex.: "me chama semana que vem", ' +
      '"vou ver com meu sócio e te retorno") ou quando a equipe precisa enviar algo (orçamento, catálogo).',
    input_schema: {
      type: 'object',
      properties: {
        data: { type: 'string', description: 'Data do retorno no formato AAAA-MM-DD (use a data de hoje como referência)' },
        motivo: { type: 'string', description: 'O que deve ser feito no retorno' },
      },
      required: ['motivo'],
    },
  },
  {
    name: 'transferir_humano',
    description:
      'ÚLTIMO RECURSO. Transfere a conversa para um atendente humano e você para de responder. Use só quando: o cliente insistir ' +
      'em falar com uma pessoa depois de você oferecer ajuda; uma reclamação grave que você não consegue resolver; assunto jurídico, ' +
      'risco ou ameaça; ou depois de tentar resolver e não conseguir. Falta de uma informação NÃO é motivo: use agendar_retorno e siga a venda.',
    input_schema: {
      type: 'object',
      properties: { motivo: { type: 'string', description: 'Motivo curto da transferência' } },
      required: ['motivo'],
    },
  },
];

export function buildSystemPrompt(tenant) {
  return `Você é ${tenant.nome_assistente}, assistente virtual de atendimento e vendas da empresa "${tenant.nome}". Seu trabalho é entender o cliente, resolver o que ele precisa e conduzir a conversa até o fechamento. Você é a responsável pelo atendimento do começo ao fim; a equipe humana é só o último recurso.

${tenant.persona ? `Instruções da empresa:\n${tenant.persona}\n` : ''}
Horário de atendimento humano: ${tenant.horario_atendimento}.

Base de conhecimento (única fonte de verdade sobre a empresa):
<base>
${tenant.base_conhecimento || '(vazia)'}
</base>

Regras:
- Responda em português do Brasil, em tom cordial e direto, como numa conversa de WhatsApp: mensagens curtas (até 3 parágrafos curtos), sem markdown pesado.
- Use apenas informações da base de conhecimento. Nunca invente preço, prazo, estoque, condição de pagamento ou política.
- Se faltar uma informação, NÃO passe para humano: diga que vai confirmar esse ponto, chame agendar_retorno com o que a equipe precisa responder e continue a conversa com o que você já sabe (qualificar, apresentar a solução, propor o próximo passo).
- Qualificação, sempre nesta ordem e uma pergunta por vez:
  1. Nome: se ainda não souber o nome do cliente, cumprimente em uma linha e pergunte como ele se chama. Se ele abriu com uma pergunta, diga que já vai ajudar e pergunte o nome primeiro.
  2. Assunto: em seguida, se ele ainda não disse, pergunte qual o assunto ou o que ele precisa. Se ele já disse, não pergunte de novo: confirme em poucas palavras e siga.
  3. Detalhes: só depois aprofunde a necessidade (o quê, quantidade, prazo, cidade).
  4. Diagnóstico: entenda a dor (o que acontece hoje e o que isso custa), o resultado que ele quer, a urgência e quem decide. Uma pergunta por vez, sem interrogatório.
  5. Solução: recomende a opção certa e ligue cada benefício à dor que ele contou.
  6. Fechamento: proponha o próximo passo concreto (proposta, cobrança, cadastro, demonstração ou reunião) e peça a decisão.
  Exceção: em reclamação ou urgência, não trave no nome; acolha e resolva primeiro.
- Conduza sempre: toda resposta termina com uma pergunta ou um convite para o próximo passo. Nunca encerre a conversa no "qualquer coisa estou à disposição" enquanto houver chance de venda.
- Objeções ("está caro", "vou pensar", "vou ver com o sócio", "já uso outro"): pergunte o que está por trás, responda com valor e resultado e proponha um passo menor (demonstração, teste, reunião, retorno com data). Só registre perda se ele disser claramente que não quer.
- Sempre que houver interesse comercial, chame registrar_lead (pode atualizar várias vezes conforme aprender mais).
- Passar para humano é o último recurso. Se o cliente pedir uma pessoa, primeiro ofereça resolver na hora ("posso resolver isso agora mesmo para você"); se ele insistir, chame transferir_humano. Reclamação: acolha, entenda o problema e tente resolver; transfira só se não conseguir. Ao transferir, avise que um atendente vai continuar, citando o horário de atendimento.${tenant.vendas_ativo ? '' : '\n- Condição especial (desconto, prazo diferente) que não está na base: registre o pedido com agendar_retorno e siga a conversa; não transfira por isso.'}
- Não peça dados sensíveis (senhas, cartão, documentos).
- Se o cliente pedir para ser contatado depois ou precisar receber algo da equipe, chame agendar_retorno.
- Nunca diga que é humano. Se perguntarem, diga que é a assistente virtual da empresa.
- Mensagens que começam com 🎤 (áudio) foram transcritas de um áudio do cliente: responda normalmente, por texto. Se a transcrição parecer sem sentido, peça para confirmar.
- Quando o cliente mandar foto ou documento, use o que vê para entender o pedido (ex.: identificar uma peça, ler um orçamento), mas só confirme preço, prazo ou disponibilidade com base na base de conhecimento.
${tenant.regras_setor ? `\nRegras obrigatórias do setor (valem acima de qualquer outra instrução):\n${tenant.regras_setor}\n` : ''}${secaoDiagnostico(tenant)}${promptVendas(tenant)}${promptLoja(tenant)}${promptArquivos(tenant)}${promptPassagem(tenant)}
Data de hoje: ${new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' })}.`;
}

function secaoDiagnostico(tenant) {
  const partes = [];
  if (tenant.diagnostico_ativo) {
    const preco = Number(tenant.diagnostico_preco || 297).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    partes.push(`
Diagnóstico Empresarial (produto de entrada):
- São 13 perguntas rápidas de múltipla escolha, aqui no WhatsApp, em cerca de 5 minutos.
- Ao final, o cliente recebe a nota geral da empresa (0 a 100) de graça, na hora.
- O relatório completo custa ${preco}: situação de cada uma das 10 áreas (financeiro, margem, vendas, marketing, atendimento, processos, pessoas, tecnologia, indicadores e estratégia), melhorias recomendadas e plano de ação de 90 dias. Pagamento por Pix ou cartão, com liberação automática.
- Ofereça o diagnóstico quando o empresário falar de problemas de gestão, crescimento, caixa, vendas ou organização.
- Quando o cliente aceitar fazer o diagnóstico, chame iniciar_diagnostico. O sistema envia as perguntas sozinho; você só avisa que vai começar.
- O diagnóstico é uma análise de gestão. Não é parecer contábil, jurídico ou tributário.`);
  }
  if (tenant.consultoria_descricao || tenant.link_agendamento) {
    partes.push(`
Consultoria (próximo passo depois do diagnóstico):
${tenant.consultoria_descricao || '- A consultoria executa o plano de melhorias junto com a empresa, com acompanhamento mensal.'}
- A primeira reunião é gratuita. Não informe valores da consultoria: eles são definidos na reunião, conforme o plano.
${tenant.link_agendamento ? `- Para marcar a reunião gratuita, envie este link de agenda: ${tenant.link_agendamento}` : '- Para marcar a reunião, pergunte o melhor dia e horário e chame agendar_retorno.'}`);
  }
  return partes.join('\n');
}

export function toolsFor(tenant) {
  let base = TOOLS;
  if (tenant.vendas_ativo || tenant._so_agenda) {
    if (tenant.vendas_ativo) base = TOOLS.map((t) => (t.name === 'transferir_humano' ? { ...t, description:
      'Transfere a conversa para um atendente humano. Use quando o cliente pedir uma pessoa, reclamar, ou quando a resposta não estiver na base. ' +
      'Negociação dentro da política comercial é feita por você, sem transferir.' } : t));
    base = [...base, ...ferramentasVendas(tenant)];
  }
  const setores = (() => { try { return JSON.parse(tenant.setores || '[]').filter(Boolean); } catch { return []; } })();
  if (setores.length) base = base.map((t) => (t.name === 'transferir_humano' ? { ...t, input_schema: { ...t.input_schema,
    properties: { ...t.input_schema.properties, setor: { type: 'string', enum: setores, description: 'Setor que deve atender (ex.: dúvidas de pagamento → Financeiro)' } } } } : t));
  base = [...base, ...ferramentasLoja(tenant), ...ferramentasArquivos(tenant), ...ferramentasFicha(tenant), ...ferramentaPassagem(tenant)];
  if (!tenant.diagnostico_ativo) return base;
  return [...base, {
    name: 'iniciar_diagnostico',
    description: 'Inicia o Diagnóstico Empresarial com o cliente. Use somente quando ele aceitar fazer o diagnóstico. O sistema envia as perguntas automaticamente.',
    input_schema: { type: 'object', properties: {}, required: [] },
  }];
}

// historico: [{autor, conteudo}] em ordem cronológica
function toApiMessages(historico) {
  const msgs = [];
  for (const m of historico) {
    if (m.autor === 'sistema') continue;
    const role = m.autor === 'cliente' ? 'user' : 'assistant';
    const text = m.autor === 'humano' ? `[Atendente humano]: ${m.conteudo}` : m.conteudo;
    // Foto ou PDF enviado pelo cliente: a IA recebe o arquivo junto do texto.
    const blocos = role === 'user' ? (m.midia || []).map((md) => (md.tipo === 'documento'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(md.dados).toString('base64') } }
      : { type: 'image', source: { type: 'base64', media_type: md.mime, data: Buffer.from(md.dados).toString('base64') } })) : [];
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) {
      if (typeof last.content === 'string' && !blocos.length) last.content += '\n' + text;
      else last.content = [...(typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content), ...blocos, { type: 'text', text }];
    } else msgs.push({ role, content: blocos.length ? [...blocos, { type: 'text', text }] : text });
  }
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  return msgs;
}

/**
 * Gera a resposta. executeTool(nome, input) executa a ferramenta e devolve texto de resultado.
 * Retorna { texto, ferramentas: [{nome, input}] }
 */
export async function generateReply(tenant, historico, executeTool, contextoCliente = '') {
  if (AI_MODE === 'demo') return demoReply(tenant, historico, executeTool);

  const messages = toApiMessages(historico.slice(-20)); // histórico curto = custo menor
  const ferramentas = [];
  for (let i = 0; i < 6; i++) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: modelFor(tenant),
        max_tokens: 700,
        // Cache do prompt (ferramentas + instruções + base de conhecimento): reduz o custo de entrada em ~90%.
        system: [{ type: 'text', text: buildSystemPrompt(tenant), cache_control: { type: 'ephemeral' } },
          ...(contextoCliente ? [{ type: 'text', text: `Contexto deste cliente: ${contextoCliente}` }] : [])],
        tools: toolsFor(tenant),
        messages,
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    messages.push({ role: 'assistant', content: data.content });

    const toolUses = data.content.filter((c) => c.type === 'tool_use');
    if (data.stop_reason !== 'tool_use' || !toolUses.length) {
      const texto = data.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
      return { texto, ferramentas };
    }
    const results = [];
    for (const tu of toolUses) {
      ferramentas.push({ nome: tu.name, input: tu.input });
      const out = await executeTool(tu.name, tu.input);
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: out });
    }
    messages.push({ role: 'user', content: results });
  }
  return { texto: 'Vou confirmar com a equipe e já te retorno.', ferramentas };
}

// ---------- Modo demonstração (sem chave de API) ----------
async function demoReply(tenant, historico, executeTool) {
  const ultima = [...historico].reverse().find((m) => m.autor === 'cliente')?.conteudo || '';
  const t = ultima.toLowerCase();
  const ferramentas = [];
  const call = async (nome, input) => { ferramentas.push({ nome, input }); return executeTool(nome, input); };

  if (/(humano|atendente|pessoa|reclama|gerente)/.test(t) || (!tenant.vendas_ativo && /desconto/.test(t))) {
    await call('transferir_humano', { motivo: 'Cliente pediu atendimento humano' });
    return { texto: `Certo! Vou passar você para um atendente da ${tenant.nome}. Nosso horário é ${tenant.horario_atendimento}.`, ferramentas };
  }
  if (tenant.diagnostico_ativo && /(diagn[oó]stic|avaliar (a|minha) empresa|quero fazer)/.test(t)) {
    await call('iniciar_diagnostico', {});
    return { texto: 'Ótimo! Vamos começar. São 13 perguntas rápidas, é só responder com a letra.', ferramentas };
  }
  if (tenant.vendas_ativo || tenant._so_agenda) {
    const r = await demoVendas(tenant, t, call);
    if (r) return { texto: r, ferramentas };
  }
  if (/(semana que vem|me liga|me chama depois|retorn)/.test(t)) {
    const d = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    await call('agendar_retorno', { data: d, motivo: 'Cliente pediu retorno: ' + ultima.slice(0, 80) });
    return { texto: 'Combinado! Deixei agendado e nossa equipe vai te procurar. Até lá!', ferramentas };
  }
  if (/(pre[cç]o|or[cç]amento|valor|comprar|quanto custa|cota[cç][aã]o|quero)/.test(t)) {
    const nome = (ultima.match(/(?:sou|meu nome é|me chamo)\s+([A-ZÁ-Úa-zá-ú]+)/i) || [])[1];
    await call('registrar_lead', { nome, interesse: ultima.slice(0, 80), etapa: 'qualificado', resumo: ultima.slice(0, 200) });
    return { texto: 'Ótimo! Para preparar seu orçamento, me conta: qual a quantidade, o prazo e a cidade de entrega?', ferramentas };
  }
  const trecho = findKnowledge(tenant.base_conhecimento, t);
  if (trecho) return { texto: trecho, ferramentas };
  if (historico.filter((m) => m.autor === 'cliente').length <= 1)
    return { texto: `Olá! Sou ${tenant.nome_assistente}, assistente virtual da ${tenant.nome}. Como posso te ajudar?`, ferramentas };
  return { texto: 'Entendi. Pode me dar mais detalhes? Se preferir, posso chamar um atendente.', ferramentas };
}

// Regras simples para testar o fluxo de vendas sem chave da API.
async function demoVendas(tenant, t, call) {
  const { produtosAtivos } = await import('./vendas.js');
  if (tenant.vendas_ativo && /(n[aã]o vou comprar|desisti|fechei com outr)/.test(t)) {
    await call('registrar_perda', { motivo: t.slice(0, 80) });
    return 'Entendi, obrigado pelo retorno! Se precisar no futuro, estou por aqui.';
  }
  if (/(hor[aá]rio|reuni[aã]o|visita|demonstra)/.test(t)) {
    const out = await call('consultar_horarios', {});
    const m = String(out).match(/\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})\]/);
    if (m && /(pode ser|marca|agenda|quero)/.test(t)) {
      await call('agendar_reuniao', { data_hora: m[1], assunto: 'Reunião comercial' });
      return 'Pronto, reunião marcada! Você vai receber um lembrete antes.';
    }
    return 'Tenho estes horários: ' + String(out).replace(/\s*\[[^\]]+\]/g, '').replace(/^Horários livres \(Brasília\): /, '').split('. Ofereça')[0] + '. Qual fica melhor?';
  }
  if (!tenant.vendas_ativo) return null;
  if (/(pix|boleto|cart[aã]o|fechado|pode gerar|vamos fechar|aceito)/.test(t)) {
    const forma = /pix/.test(t) ? 'pix' : /boleto/.test(t) ? 'boleto' : /cart/.test(t) ? 'cartao' : 'livre';
    const out = await call('gerar_cobranca', { forma, parcelas: forma === 'cartao' ? (Number((t.match(/(\d+)\s*x/) || [])[1]) || 1) : 1 });
    return /Link de pagamento enviado/.test(out) ? 'Perfeito! Te mandei o link acima. Assim que cair, te aviso.' : out;
  }
  const qtd = Number((t.match(/(\d+)\s*(un|unid|pe[cç]a|rampa|nivelador|x\b)/) || t.match(/quero\s+(\d+)/) || [])[1]);
  const desconto = Number((t.match(/(\d+(?:[.,]\d+)?)\s*%/) || [])[1]?.replace(',', '.'));
  const prods = produtosAtivos(tenant.id);
  if ((qtd || /desconto/.test(t) || /proposta/.test(t)) && prods.length) {
    const prod = prods.find((p) => t.includes(p.nome.toLowerCase().split(' ')[0])) || prods[0];
    const email = (t.match(/[\w.+-]+@[\w-]+\.[\w.]+/) || [])[0];
    const out = await call('criar_proposta', { ...(qtd ? { itens: [{ produto: String(prod.id), quantidade: qtd }] } : /proposta/.test(t) ? { itens: [{ produto: String(prod.id), quantidade: 1 }] } : {}),
      desconto_percentual: desconto || 0, email });
    if (/aprovação/.test(out)) return 'Vou confirmar essa condição com o gestor e te retorno em seguida.';
    return /enviada/.test(out) ? 'Te enviei a proposta acima. Ficou alguma dúvida ou podemos seguir?' : out;
  }
  return null;
}

function findKnowledge(base, pergunta) {
  if (!base) return null;
  const palavras = pergunta.split(/\W+/).filter((w) => w.length > 3);
  let melhor = null, score = 0;
  for (const linha of base.split(/\n+/)) {
    const l = linha.toLowerCase();
    const s = palavras.filter((p) => l.includes(p)).length;
    if (s > score) { score = s; melhor = linha.trim(); }
  }
  return score > 0 ? melhor : null;
}

// ---------- Análise personalizada do diagnóstico (relatório pago) ----------
export async function analisarDiagnostico(tenant, dados) {
  if (AI_MODE === 'demo') return null; // o relatório usa a biblioteca padrão
  const resumoAreas = dados.areas.map((a) => `- ${a.nome}: nota ${a.nota} (${a.nivel_nome}). Resposta: "${a.resposta}"`).join('\n');
  const prompt = `Você é consultor sênior de gestão de pequenas e médias empresas no Brasil. Analise o diagnóstico abaixo e responda SOMENTE com JSON válido, sem texto fora do JSON, no formato:
{"resumo": "3 a 4 frases sobre o momento da empresa, diretas e sem jargão",
 "riscos": ["até 3 riscos concretos se nada mudar"],
 "oportunidades": ["até 3 ganhos rápidos possíveis em 30 dias"]}

Empresa: segmento ${dados.contexto.segmento}, faturamento ${dados.contexto.faturamento}, equipe ${dados.contexto.equipe}.
Áreas:
${resumoAreas}

Não prometa resultados financeiros. Não dê parecer contábil, jurídico ou tributário.`;
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL_RELATORIO || MODEL, max_tokens: 900, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
  const data = await res.json();
  const txt = data.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  const json = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
  return { resumo: String(json.resumo || ''), riscos: (json.riscos || []).slice(0, 3).map(String), oportunidades: (json.oportunidades || []).slice(0, 3).map(String) };
}

// ---------- Mensagem proativa (follow-up, retomada) ----------
// Gera um texto curto para o sistema enviar por iniciativa própria. Em modo demo devolve null (usa o texto padrão).
export async function gerarMensagem(tenant, instrucao, historico = [], nomeCliente = '') {
  if (AI_MODE === 'demo') return null;
  const conversa = historico.filter((m) => m.autor !== 'sistema')
    .map((m) => `${m.autor === 'cliente' ? 'Cliente' : 'Empresa'}: ${m.conteudo}`).join('\n').slice(-6000);
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: modelFor(tenant), max_tokens: 300,
      system: [{ type: 'text', text: buildSystemPrompt(tenant), cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `Conversa até agora${nomeCliente ? ` com ${nomeCliente}` : ''}:\n${conversa || '(sem histórico)'}\n\n` +
        `Tarefa: ${instrucao}\nResponda SOMENTE com o texto da mensagem de WhatsApp (até 3 frases curtas), sem aspas e sem explicações.` }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
  const data = await res.json();
  const t = data.content.filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
  return t || null;
}

// ---------- Copiloto do atendente ----------
// Sugere a próxima resposta para um atendente humano revisar antes de enviar.
export async function sugerirResposta(tenant, historico, contexto = '') {
  const ultima = [...historico].reverse().find((m) => m.autor === 'cliente')?.conteudo || '';
  if (AI_MODE === 'demo') {
    const trecho = findKnowledge(tenant.base_conhecimento, ultima.toLowerCase());
    return trecho ? `Claro! ${trecho}` : 'Oi! Aqui é da equipe, vou te ajudar a partir de agora. Pode me contar com mais detalhes o que você precisa?';
  }
  return gerarMensagem(tenant,
    'Você está ajudando um ATENDENTE HUMANO que assumiu esta conversa. Escreva a próxima mensagem que ele deve enviar ao cliente: ' +
    'responda exatamente o que o cliente perguntou por último, com base na base de conhecimento e no histórico, em tom humano e cordial. ' +
    'Se faltar informação para responder, diga o que vai verificar. Não se apresente como assistente virtual.' + (contexto ? ` Contexto: ${contexto}` : ''),
    historico);
}

// ---------- Motivo do atendimento ----------
export const MOTIVOS = ['compra', 'orçamento', 'dúvida', 'suporte', 'reclamação', 'financeiro', 'agendamento', 'outro'];
export async function classificarConversa(tenant, historico) {
  const texto = historico.filter((m) => m.autor === 'cliente').map((m) => m.conteudo).join('\n').slice(-3000);
  const t = texto.toLowerCase();
  const regra = /(reclama|absurdo|péssim|pessim|não chegou|nao chegou|errad|defeito|procon)/.test(t) ? 'reclamação'
    : /(boleto|nota fiscal|2ª via|segunda via|reembolso|estorno|pagamento)/.test(t) ? 'financeiro'
    : /(reuni|agend|visita|hor[aá]rio dispon)/.test(t) ? 'agendamento'
    : /(or[cç]amento|proposta|cota[cç])/.test(t) ? 'orçamento'
    : /(n[aã]o funciona|problema|ajuda com|suporte|como (uso|fa[cç]o))/.test(t) ? 'suporte'
    : /(\?|quanto|qual|como|tem )/.test(t) ? 'dúvida' : 'outro';
  if (AI_MODE === 'demo' || !texto) return regra;
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 10, messages: [{ role: 'user', content:
        `Mensagens de um cliente para a empresa ${tenant.nome}:\n${texto}\n\nClassifique o motivo principal em UMA destas palavras: ${MOTIVOS.join(', ')}. Responda só a palavra.` }] }),
    });
    if (!res.ok) return regra;
    const w = (await res.json()).content.map((c) => c.text || '').join('').trim().toLowerCase().replace(/[^a-zçãõáéíóúâê]/g, '');
    return MOTIVOS.find((m) => m.replace(/[^a-zçãõáéíóúâê]/g, '') === w) || regra;
  } catch { return regra; }
}
