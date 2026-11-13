// Motor de IA: chama a API da Anthropic (Claude) com ferramentas.
// Sem ANTHROPIC_API_KEY, roda em modo demonstração (regras simples) para testes.

const API_URL = 'https://api.anthropic.com/v1/messages';
// Modelo barato como padrão; plano Premium pode usar um modelo mais forte (opcional).
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const MODEL_PREMIUM = process.env.ANTHROPIC_MODEL_PREMIUM || MODEL;
const modelFor = (tenant) => (tenant.plano === 'premium' ? MODEL_PREMIUM : MODEL);
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
      'Transfere a conversa para um atendente humano. Use quando o cliente pedir uma pessoa, reclamar, ' +
      'pedir negociação de preço/condição especial, ou quando a resposta não estiver na base de conhecimento.',
    input_schema: {
      type: 'object',
      properties: { motivo: { type: 'string', description: 'Motivo curto da transferência' } },
      required: ['motivo'],
    },
  },
];

export function buildSystemPrompt(tenant) {
  return `Você é ${tenant.nome_assistente}, assistente virtual de atendimento da empresa "${tenant.nome}" no WhatsApp.

${tenant.persona ? `Instruções da empresa:\n${tenant.persona}\n` : ''}
Horário de atendimento humano: ${tenant.horario_atendimento}.

Base de conhecimento (única fonte de verdade sobre a empresa):
<base>
${tenant.base_conhecimento || '(vazia)'}
</base>

Regras:
- Responda em português do Brasil, em tom cordial e direto, como numa conversa de WhatsApp: mensagens curtas (até 3 parágrafos curtos), sem markdown pesado.
- Use apenas informações da base de conhecimento. Nunca invente preço, prazo, estoque, condição de pagamento ou política. Se não souber, diga que vai confirmar com a equipe e use transferir_humano.
- Faça uma pergunta por vez para entender a necessidade (o quê, quantidade, prazo, cidade).
- Sempre que houver interesse comercial, chame registrar_lead (pode atualizar várias vezes conforme aprender mais).
- Se o cliente pedir uma pessoa, reclamar ou pedir condição especial, chame transferir_humano e avise que um atendente vai continuar, citando o horário de atendimento.
- Não peça dados sensíveis (senhas, cartão, documentos).
- Se o cliente pedir para ser contatado depois ou precisar receber algo da equipe, chame agendar_retorno.
- Nunca diga que é humano. Se perguntarem, diga que é a assistente virtual da empresa.

Data de hoje: ${new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' })}.`;
}

// historico: [{autor, conteudo}] em ordem cronológica
function toApiMessages(historico) {
  const msgs = [];
  for (const m of historico) {
    if (m.autor === 'sistema') continue;
    const role = m.autor === 'cliente' ? 'user' : 'assistant';
    const text = m.autor === 'humano' ? `[Atendente humano]: ${m.conteudo}` : m.conteudo;
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) last.content += '\n' + text;
    else msgs.push({ role, content: text });
  }
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  return msgs;
}

/**
 * Gera a resposta. executeTool(nome, input) executa a ferramenta e devolve texto de resultado.
 * Retorna { texto, ferramentas: [{nome, input}] }
 */
export async function generateReply(tenant, historico, executeTool) {
  if (AI_MODE === 'demo') return demoReply(tenant, historico, executeTool);

  const messages = toApiMessages(historico.slice(-20)); // histórico curto = custo menor
  const ferramentas = [];
  for (let i = 0; i < 4; i++) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: modelFor(tenant),
        max_tokens: 500,
        // Cache do prompt (ferramentas + instruções + base de conhecimento): reduz o custo de entrada em ~90%.
        system: [{ type: 'text', text: buildSystemPrompt(tenant), cache_control: { type: 'ephemeral' } }],
        tools: TOOLS,
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
  const call = async (nome, input) => { ferramentas.push({ nome, input }); await executeTool(nome, input); };

  if (/(humano|atendente|pessoa|reclama|gerente|desconto)/.test(t)) {
    await call('transferir_humano', { motivo: 'Cliente pediu atendimento humano' });
    return { texto: `Certo! Vou passar você para um atendente da ${tenant.nome}. Nosso horário é ${tenant.horario_atendimento}.`, ferramentas };
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
