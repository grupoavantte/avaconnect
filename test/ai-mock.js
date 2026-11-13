// Testa o caminho do Claude (com ferramentas) simulando a API da Anthropic.
process.env.ANTHROPIC_API_KEY = 'teste';
const calls = [];
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  calls.push(body);
  const first = calls.length === 1;
  return {
    ok: true,
    json: async () => first
      ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'registrar_lead', input: { interesse: 'rampa', etapa: 'qualificado', resumo: '2 rampas' } }] }
      : { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Registrei seu pedido!' }] },
  };
};
const { generateReply } = await import('../src/ai.js');
const executed = [];
const r = await generateReply({ nome: 'X', nome_assistente: 'AVA', plano: 'essencial', horario_atendimento: '8-18', persona: '', base_conhecimento: 'Rampas' },
  [{ autor: 'cliente', conteudo: 'quero 2 rampas' }], async (n, i) => { executed.push(n); return 'ok'; });
const assert = (c, m) => { if (!c) { console.error('FALHOU:', m); process.exit(1); } console.log('ok -', m); };
assert(r.texto === 'Registrei seu pedido!', 'resposta final em texto');
assert(executed[0] === 'registrar_lead', 'ferramenta executada');
assert(calls[0].model === 'claude-haiku-5-5', 'Haiku como modelo padrão');
assert(calls[0].system[0].cache_control?.type === 'ephemeral', 'cache de prompt ativado');
assert(calls[1].messages.at(-1).content[0].type === 'tool_result', 'resultado da ferramenta devolvido à IA');
