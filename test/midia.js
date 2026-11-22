// Teste de áudio, imagem, localização e segmentos (sem servidor, com APIs simuladas).
process.env.DB_PATH = `/tmp/ava-midia-${Date.now()}.db`;
process.env.ANTHROPIC_API_KEY = 'teste';
process.env.TRANSCRICAO_API_KEY = 'teste';
const chamadas = { claude: [], transcricao: 0 };
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  const json = (d) => ({ ok: true, status: 200, json: async () => d, headers: new Map([['content-type', 'application/json']]) });
  if (url.includes('graph.facebook.com') && url.endsWith('/messages')) return json({ messages: [{ id: 'x' }] });
  if (url.includes('graph.facebook.com/')) {
    const id = url.split('/').pop().split('?')[0];
    return json({ url: `https://lookaside.fbsbx.com/${id}`, mime_type: id.startsWith('aud') ? 'audio/ogg' : 'image/jpeg', file_size: 10 });
  }
  if (url.includes('lookaside')) return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([255, 216, 255, 1, 2, 3]).buffer, headers: new Map() };
  if (url.includes('audio/transcriptions')) { chamadas.transcricao++; return json({ text: 'quero duas rampas para Volta Redonda' }); }
  if (url.includes('api.anthropic.com')) { chamadas.claude.push(JSON.parse(opts.body)); return json({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Certo!' }] }); }
  throw new Error('URL inesperada ' + url);
};
const { db } = await import('../src/db.js');
await import('../src/vendas.js');
const { aplicarSegmento, criarAgente } = await import('../src/agents.js');
const { handleIncoming } = await import('../src/engine.js');
const { parseWebhook } = await import('../src/whatsapp.js');
let ok = 0;
const check = (c, m) => { if (!c) { console.error('FALHOU:', m); process.exit(1); } ok++; console.log('ok -', m); };

const tid = db.prepare("INSERT INTO tenants (nome, plano, painel_token, wa_phone_number_id, wa_token) VALUES ('Clínica Bem', 'profissional', 'tk', 'PN1', 'EAA')").run().lastInsertRowid;
criarAgente(tid, { modelo: 'recepcao', nome: 'AVA' });
const tenant = () => db.prepare('SELECT * FROM tenants WHERE id = ?').get(tid);

// Webhook com áudio, imagem e localização
const [aud, img, loc] = parseWebhook({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'PN1' }, contacts: [{ wa_id: '5521999', profile: { name: 'Ana' } }], messages: [
  { from: '5521999', id: 'w1', type: 'audio', audio: { id: 'aud1', mime_type: 'audio/ogg' } },
  { from: '5521999', id: 'w2', type: 'image', image: { id: 'img1', mime_type: 'image/jpeg', caption: 'essa peça' } },
  { from: '5521999', id: 'w3', type: 'location', location: { latitude: -22.5, longitude: -43.1, name: 'Galpão' } },
] } }] }] });
check(aud.mediaId === 'aud1' && img.legenda === 'essa peça' && loc.local.name === 'Galpão', 'webhook lê áudio, imagem e localização');

await handleIncoming(tenant(), { telefone: aud.from, nome: aud.nome, texto: aud.texto, waId: aud.waId, entrada: aud });
const m1 = db.prepare("SELECT conteudo FROM messages WHERE wa_id = 'w1'").get().conteudo;
check(m1.startsWith('🎤 (áudio) quero duas rampas') && chamadas.transcricao === 1, 'áudio transcrito e salvo na conversa');

await handleIncoming(tenant(), { telefone: img.from, nome: img.nome, texto: img.texto, waId: img.waId, entrada: img });
check(db.prepare("SELECT conteudo FROM messages WHERE wa_id = 'w2'").get().conteudo.includes('Imagem enviada — essa peça'), 'imagem registrada com a legenda');
check(db.prepare('SELECT COUNT(*) n FROM media WHERE tipo = ?').get('imagem').n === 1, 'imagem guardada para a IA');
const ultima = chamadas.claude.at(-1).messages.at(-1);
check(Array.isArray(ultima.content) && ultima.content.some((b) => b.type === 'image' && b.source.media_type === 'image/jpeg'), 'IA recebe a foto junto com o texto');

await handleIncoming(tenant(), { telefone: loc.from, nome: loc.nome, texto: loc.texto, waId: loc.waId, entrada: loc });
check(db.prepare("SELECT conteudo FROM messages WHERE wa_id = 'w3'").get().conteudo.includes('📍 Localização enviada: Galpão'), 'localização vira texto');
check((await handleIncoming(tenant(), { telefone: aud.from, texto: aud.texto, waId: 'w1', entrada: aud })).duplicada, 'áudio repetido pela Meta é ignorado');

delete process.env.TRANSCRICAO_API_KEY;
await handleIncoming(tenant(), { telefone: aud.from, texto: '[audio recebido]', waId: 'w4', entrada: { ...aud, waId: 'w4' } });
check(db.prepare("SELECT conteudo FROM messages WHERE wa_id = 'w4'").get().conteudo.includes('Peça com gentileza que ele escreva'), 'sem transcrição: IA pede para escrever');

// Segmento saúde: regras do setor vão no prompt
aplicarSegmento(tid, 'saude');
await handleIncoming(tenant(), { telefone: '5521888', texto: 'Estou com dor no peito, o que eu tomo?', canal: 'simulador' });
const sys = chamadas.claude.at(-1).system[0].text;
check(sys.includes('Regras obrigatórias do setor') && sys.includes('Nunca dê diagnóstico') && sys.includes('192'), 'regras da saúde no prompt da IA');
check(sys.includes('recepção da clínica') && sys.includes('Tom de voz: Formal'), 'instruções e tom do segmento no agente');
aplicarSegmento(tid, 'advocacia');
await handleIncoming(tenant(), { telefone: '5521777', texto: 'Vou ganhar a causa?', canal: 'simulador' });
check(chamadas.claude.at(-1).system[0].text.includes('OAB') && !chamadas.claude.at(-1).system[0].text.includes('192'), 'trocar de segmento troca as regras');

console.log(`\n${ok} verificações de mídia e segmentos passaram.`);
