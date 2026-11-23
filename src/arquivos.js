// Biblioteca de arquivos: fotos, PDFs e vídeos que a IA envia no meio da conversa.
// A empresa sobe o arquivo e escreve em linguagem natural QUANDO ele deve ser enviado
// (ex.: "quando perguntarem preço, mande a tabela"). A IA decide o momento e chama enviar_arquivo.
import crypto from 'node:crypto';
import express from 'express';
import { db, logActivity } from './db.js';
import { publicUrl } from './payments.js';
import { pode } from './auth.js';

db.exec(`CREATE TABLE IF NOT EXISTS arquivos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  nome TEXT NOT NULL,
  quando TEXT,
  legenda TEXT,
  mime TEXT NOT NULL,
  tipo TEXT NOT NULL,
  dados BLOB NOT NULL,
  tamanho INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  ativo INTEGER NOT NULL DEFAULT 1,
  envios INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_arquivos_tenant ON arquivos(tenant_id)');

// Tipos aceitos e limites (os limites seguem o que o WhatsApp oficial aceita).
export const TIPOS = {
  'image/jpeg': { tipo: 'imagem', ext: 'jpg' }, 'image/png': { tipo: 'imagem', ext: 'png' }, 'image/webp': { tipo: 'imagem', ext: 'webp' },
  'video/mp4': { tipo: 'video', ext: 'mp4' },
  'application/pdf': { tipo: 'documento', ext: 'pdf' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { tipo: 'documento', ext: 'docx' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { tipo: 'documento', ext: 'xlsx' },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { tipo: 'documento', ext: 'pptx' },
};
const MB = 1024 * 1024;
export const LIMITE = { imagem: 5 * MB, video: 16 * MB, documento: 15 * MB };
export const MAX_ARQUIVOS = 50;
const ICONE = { imagem: '📷', video: '🎬', documento: '📄' };

const slug = (s) => String(s || 'arquivo').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'arquivo';
export const urlArquivo = (a) => `${publicUrl()}/a/${a.token}/${slug(a.nome)}.${TIPOS[a.mime]?.ext || 'bin'}`;
const semDados = 'id, tenant_id, nome, quando, legenda, mime, tipo, tamanho, token, ativo, envios, criado_em';
export const listarArquivos = (tid, { soAtivos = false } = {}) => tid == null ? [] :
  db.prepare(`SELECT ${semDados} FROM arquivos WHERE tenant_id = ? ${soAtivos ? 'AND ativo = 1' : ''} ORDER BY id`).all(tid);

export function salvarArquivo(tid, { nome, quando, legenda, mime, dados }) {
  const t = TIPOS[mime];
  if (!t) throw new Error('Tipo não aceito. Envie JPG, PNG, WEBP, MP4, PDF, DOCX, XLSX ou PPTX.');
  if (!dados?.length) throw new Error('Arquivo vazio.');
  if (dados.length > LIMITE[t.tipo]) throw new Error(`Arquivo grande demais. Limite para ${t.tipo}: ${LIMITE[t.tipo] / MB} MB.`);
  if (db.prepare('SELECT COUNT(*) n FROM arquivos WHERE tenant_id = ?').get(tid).n >= MAX_ARQUIVOS) throw new Error(`Limite de ${MAX_ARQUIVOS} arquivos. Apague algum para subir outro.`);
  const nm = String(nome || '').trim().slice(0, 80) || 'Arquivo';
  const r = db.prepare('INSERT INTO arquivos (tenant_id, nome, quando, legenda, mime, tipo, dados, tamanho, token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(tid, nm, String(quando || '').trim().slice(0, 400) || null, String(legenda || '').trim().slice(0, 300) || null, mime, t.tipo, dados, dados.length,
      'f' + crypto.randomBytes(12).toString('hex'));
  return db.prepare(`SELECT ${semDados} FROM arquivos WHERE id = ?`).get(r.lastInsertRowid);
}

// ---------- IA ----------
export function ferramentasArquivos(t) {
  const lista = listarArquivos(t.id, { soAtivos: true });
  if (!lista.length) return [];
  return [{
    name: 'enviar_arquivo',
    description: 'Envia ao cliente um arquivo da biblioteca da empresa (foto, PDF, vídeo, tabela, catálogo). Use quando a situação combinar com o "quando enviar" do arquivo ou quando o cliente pedir. Não envie o mesmo arquivo duas vezes na conversa.',
    input_schema: { type: 'object', properties: {
      arquivo_id: { type: 'integer', enum: lista.map((a) => a.id), description: 'Id do arquivo na biblioteca' },
      legenda: { type: 'string', description: 'Frase curta que acompanha o arquivo (opcional)' },
    }, required: ['arquivo_id'] },
  }];
}

export function promptArquivos(t) {
  const lista = listarArquivos(t.id, { soAtivos: true });
  if (!lista.length) return '';
  return `\nArquivos que você pode enviar com enviar_arquivo (envie no momento certo, sem o cliente precisar pedir):
${lista.map((a) => `- [${a.id}] ${ICONE[a.tipo]} ${a.nome}${a.quando ? ` — quando enviar: ${a.quando}` : ''}`).join('\n')}
Depois de enviar, não repita o conteúdo do arquivo; diga em uma frase o que mandou e siga a conversa.\n`;
}

/** ctx.enviarArquivo(arquivo, legenda) entrega no canal da conversa. */
export async function executarFerramentaArquivos(ctx, nome, input) {
  if (nome !== 'enviar_arquivo') return null;
  const a = db.prepare(`SELECT ${semDados} FROM arquivos WHERE id = ? AND tenant_id = ? AND ativo = 1`).get(Number(input.arquivo_id), ctx.tenant.id);
  if (!a) return 'Arquivo não encontrado na biblioteca. Siga sem ele.';
  const ja = ctx.conv && db.prepare('SELECT 1 FROM messages WHERE conversation_id = ? AND autor = ? AND conteudo LIKE ?').get(ctx.conv.id, 'ia', `%/a/${a.token}/%`);
  if (ja) return `${a.nome} já foi enviado nesta conversa. Não envie de novo; pergunte se o cliente conseguiu abrir.`;
  await ctx.enviarArquivo(a, input.legenda || a.legenda || '');
  db.prepare('UPDATE arquivos SET envios = envios + 1 WHERE id = ?').run(a.id);
  const lead = db.prepare('SELECT id FROM leads WHERE contact_id = ?').get(ctx.contact.id);
  if (lead) logActivity(ctx.tenant.id, lead.id, `${ICONE[a.tipo]} AVA enviou o arquivo "${a.nome}"`, { autor: 'ia' });
  return `${a.nome} enviado. Não descreva o arquivo inteiro: diga em uma frase o que mandou e pergunte o que o cliente achou ou se ficou alguma dúvida.`;
}

export const textoArquivo = (a, legenda = '') => `${ICONE[a.tipo]} ${a.nome}${legenda ? ` — ${legenda}` : ''} ${urlArquivo(a)}`;

// ---------- Rotas ----------
export function rotasArquivos(app) {
  // Link público (com token aleatório): a Meta baixa daqui para entregar no WhatsApp; o cliente abre pelo site/e-mail.
  app.get('/a/:token/:nome?', (req, res) => {
    const a = db.prepare('SELECT mime, dados, nome FROM arquivos WHERE token = ?').get(req.params.token);
    if (!a) return res.status(404).send('Arquivo não encontrado.');
    res.set('content-type', a.mime).set('cache-control', 'public, max-age=86400').set('x-content-type-options', 'nosniff');
    if (!a.mime.startsWith('image/') && !a.mime.startsWith('video/')) res.set('content-disposition', `inline; filename="${slug(a.nome)}.${TIPOS[a.mime]?.ext || 'bin'}"`);
    res.send(Buffer.from(a.dados));
  });
}

export function arquivosRouter(canSee) {
  const r = express.Router();
  const okT = (req, res, tid) => { if (!canSee(req, tid)) { res.sendStatus(403); return false; } return true; };
  const podeEditar = (req, res) => { if (pode(req.user, 'configurar')) return true; res.status(403).json({ erro: 'Sem permissão' }); return false; };
  const carregar = (req, res) => {
    const a = db.prepare(`SELECT ${semDados} FROM arquivos WHERE id = ?`).get(req.params.id);
    if (!a) { res.sendStatus(404); return null; }
    return okT(req, res, a.tenant_id) ? a : null;
  };
  r.get('/tenants/:id/arquivos', (req, res) => {
    if (!okT(req, res, req.params.id)) return;
    res.json({ arquivos: listarArquivos(Number(req.params.id)).map((a) => ({ ...a, url: urlArquivo(a) })), limites: LIMITE, max: MAX_ARQUIVOS });
  });
  // Upload binário: o corpo é o próprio arquivo; nome e "quando enviar" vão nos cabeçalhos (codificados).
  r.post('/tenants/:id/arquivos', express.raw({ type: () => true, limit: '17mb' }), (req, res) => {
    if (!okT(req, res, req.params.id) || !podeEditar(req, res)) return;
    try {
      const dec = (h) => { try { return decodeURIComponent(req.get(h) || ''); } catch { return ''; } };
      const mime = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const a = salvarArquivo(Number(req.params.id), { nome: dec('x-nome'), quando: dec('x-quando'), legenda: dec('x-legenda'), mime, dados: Buffer.isBuffer(req.body) ? req.body : null });
      res.status(201).json({ ...a, url: urlArquivo(a) });
    } catch (e) { res.status(400).json({ erro: e.message }); }
  });
  r.put('/arquivos/:id', (req, res) => {
    const a = carregar(req, res); if (!a || !podeEditar(req, res)) return;
    const b = req.body || {};
    db.prepare('UPDATE arquivos SET nome = ?, quando = ?, legenda = ?, ativo = ? WHERE id = ?').run(
      String(b.nome ?? a.nome).trim().slice(0, 80) || a.nome, b.quando !== undefined ? String(b.quando).trim().slice(0, 400) || null : a.quando,
      b.legenda !== undefined ? String(b.legenda).trim().slice(0, 300) || null : a.legenda, b.ativo !== undefined ? (b.ativo ? 1 : 0) : a.ativo, a.id);
    res.json({ ok: true });
  });
  r.delete('/arquivos/:id', (req, res) => {
    const a = carregar(req, res); if (!a || !podeEditar(req, res)) return;
    db.prepare('DELETE FROM arquivos WHERE id = ?').run(a.id);
    res.json({ ok: true });
  });
  return r;
}
