// Mídia recebida no WhatsApp: áudio (transcrição), foto e documento (a IA vê), localização.
import { db } from './db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL,
  tipo TEXT NOT NULL,            -- imagem | documento | audio
  mime TEXT,
  nome TEXT,
  dados BLOB,                    -- guardado só para imagem e PDF pequenos (a IA usa no atendimento)
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_media_msg ON media(message_id);
`);

const GRAPH = `https://graph.facebook.com/${process.env.WA_GRAPH_VERSION || 'v21.0'}`;
const MAX_BYTES = 8 * 1024 * 1024;
const IMG_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// Transcrição por API compatível com OpenAI (OpenAI Whisper, Groq etc.).
const TRANSCRICAO_URL = process.env.TRANSCRICAO_URL || 'https://api.groq.com/openai/v1/audio/transcriptions';
const TRANSCRICAO_MODELO = process.env.TRANSCRICAO_MODELO || 'whisper-large-v3';
export const TRANSCRICAO_ATIVA = () => !!process.env.TRANSCRICAO_API_KEY;

/** Baixa a mídia da Meta. Retorna { buffer, mime } ou lança erro. */
export async function baixarMidia(tenant, mediaId) {
  const token = tenant.wa_token || process.env.WA_DEFAULT_TOKEN;
  if (!token) throw new Error('sem token do WhatsApp');
  const info = await fetch(`${GRAPH}/${mediaId}`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
  if (!info?.url) throw new Error('mídia não encontrada');
  if (info.file_size && info.file_size > MAX_BYTES) throw new Error('arquivo grande demais');
  const res = await fetch(info.url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`download ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_BYTES) throw new Error('arquivo grande demais');
  return { buffer, mime: (info.mime_type || res.headers.get('content-type') || '').split(';')[0] };
}

export async function transcrever(buffer, mime) {
  const ext = mime.includes('mpeg') ? 'mp3' : mime.includes('mp4') ? 'm4a' : mime.includes('wav') ? 'wav' : 'ogg';
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime || 'audio/ogg' }), `audio.${ext}`);
  form.append('model', TRANSCRICAO_MODELO);
  form.append('language', 'pt');
  const res = await fetch(TRANSCRICAO_URL, { method: 'POST', headers: { authorization: `Bearer ${process.env.TRANSCRICAO_API_KEY}` }, body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `transcrição ${res.status}`);
  return String(data.text || '').trim();
}

/**
 * Converte a mensagem recebida em texto para a conversa + mídia para a IA.
 * m: { tipo, texto, mediaId, mime, legenda, nomeArquivo, local }
 * Retorna { texto, midia: { tipo, mime, nome, buffer } | null }
 */
export async function prepararEntrada(tenant, m) {
  if (!m.tipo || m.tipo === 'text' || m.tipo === 'button' || m.tipo === 'interactive') return { texto: m.texto, midia: null };
  if (m.tipo === 'location') {
    const l = m.local || {};
    return { texto: `📍 Localização enviada: ${[l.name, l.address].filter(Boolean).join(' — ') || ''} (${l.latitude}, ${l.longitude})`.trim(), midia: null };
  }
  if (m.tipo === 'audio') {
    if (!TRANSCRICAO_ATIVA()) return { texto: '[O cliente enviou um áudio, mas a transcrição não está ativa. Peça com gentileza que ele escreva a mensagem.]', midia: null };
    try {
      const { buffer, mime } = await baixarMidia(tenant, m.mediaId);
      const t = await transcrever(buffer, mime);
      return { texto: t ? `🎤 (áudio) ${t}` : '[Áudio sem fala reconhecível. Peça para o cliente repetir ou escrever.]', midia: null };
    } catch (e) {
      console.error('[midia] áudio', e.message);
      return { texto: '[O cliente enviou um áudio que não consegui ouvir. Peça com gentileza que ele escreva ou mande de novo.]', midia: null };
    }
  }
  if (m.tipo === 'image' || m.tipo === 'document') {
    const rotulo = m.tipo === 'image' ? '📷 Imagem enviada' : `📎 Documento enviado${m.nomeArquivo ? `: ${m.nomeArquivo}` : ''}`;
    const texto = `${rotulo}${m.legenda ? ` — ${m.legenda}` : ''}`;
    try {
      const { buffer, mime } = await baixarMidia(tenant, m.mediaId);
      const visivel = IMG_MIMES.includes(mime) || mime === 'application/pdf';
      return { texto: visivel ? texto : `${texto} [formato ${mime} não pode ser lido; peça uma foto ou PDF]`,
        midia: visivel ? { tipo: mime === 'application/pdf' ? 'documento' : 'imagem', mime, nome: m.nomeArquivo || null, buffer } : null };
    } catch (e) {
      console.error('[midia] arquivo', e.message);
      return { texto: `${texto} [não consegui abrir o arquivo; peça para reenviar]`, midia: null };
    }
  }
  if (m.tipo === 'sticker' || m.tipo === 'reaction') return { texto: m.tipo === 'reaction' ? `[Reagiu com ${m.texto || 'um emoji'}]` : '[figurinha]', midia: null };
  return { texto: `[O cliente enviou ${m.tipo === 'video' ? 'um vídeo' : 'um conteúdo'} que não consigo abrir. Peça que descreva por escrito ou envie uma foto.]`, midia: null };
}

export function salvarMidia(tenantId, messageId, midia) {
  if (!midia) return;
  db.prepare('INSERT INTO media (message_id, tenant_id, tipo, mime, nome, dados) VALUES (?, ?, ?, ?, ?, ?)')
    .run(messageId, tenantId, midia.tipo, midia.mime, midia.nome, midia.buffer);
}

/** Blocos de mídia (Claude) das últimas mensagens do cliente, para anexar ao histórico. */
export function midiasDaConversa(conversationId, limite = 3) {
  return db.prepare(`SELECT md.message_id, md.tipo, md.mime, md.dados FROM media md JOIN messages m ON m.id = md.message_id
    WHERE m.conversation_id = ? AND md.dados IS NOT NULL ORDER BY md.id DESC LIMIT ?`).all(conversationId, limite);
}
