// Links de campanha: um número de WhatsApp só, uma frase pronta por canal (Instagram, Google, panfleto...).
// A pessoa abre o link, a mensagem já vem escrita, ela só envia. A AVA reconhece a frase, marca a origem
// no CRM e o relatório mostra contatos e vendas por canal.
import express from 'express';
import QRCode from 'qrcode';
import { db, logActivity } from './db.js';
import { pode } from './auth.js';
import { garantirLead } from './vendas.js';

db.exec(`CREATE TABLE IF NOT EXISTS links_campanha (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  nome TEXT NOT NULL,
  frase TEXT NOT NULL,
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
)`);
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
const addCols = (t, lista) => { const tem = cols(t); for (const [c, d] of lista) if (!tem.includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); };
addCols('conversations', [['link_id', 'INTEGER']]);
addCols('leads', [['link_id', 'INTEGER']]);

// Sugestões para começar (a empresa edita ou apaga).
export const SUGESTOES = [
  ['Instagram', 'Oi! Vim pelo Instagram e quero saber mais.'],
  ['Google', 'Oi! Encontrei vocês no Google e quero saber mais.'],
  ['Facebook', 'Oi! Vim pelo Facebook e quero saber mais.'],
  ['Panfleto / QR Code', 'Oi! Vi o panfleto de vocês e quero saber mais.'],
  ['Indicação', 'Oi! Fui indicado por um amigo e quero saber mais.'],
];

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

export function numeroDaEmpresa(t) {
  const n = db.prepare('SELECT telefone FROM whatsapp_numbers WHERE tenant_id = ? AND telefone IS NOT NULL ORDER BY principal DESC, id LIMIT 1').get(t.id);
  return String(n?.telefone || t.telefone_responsavel || '').replace(/\D/g, '') || null;
}
export const urlLink = (numero, frase) => (numero ? `https://wa.me/${numero}?text=${encodeURIComponent(frase)}` : null);

/** Acha o link cuja frase está na mensagem (tolerante a acento, pontuação e maiúsculas). Frase mais longa ganha. */
export function acharLink(tenantId, texto) {
  const t = norm(texto); if (!t) return null;
  const ls = db.prepare('SELECT * FROM links_campanha WHERE tenant_id = ? AND ativo = 1').all(tenantId)
    .map((l) => ({ ...l, n: norm(l.frase) })).filter((l) => l.n.length >= 6).sort((a, b) => b.n.length - a.n.length);
  return ls.find((l) => t.includes(l.n)) || null;
}

/** Chamado a cada mensagem de cliente no WhatsApp. Marca a origem da conversa e do negócio. */
export function marcarOrigem(tenant, contact, conv, texto) {
  const l = acharLink(tenant.id, texto); if (!l) return null;
  if (!conv.link_id) { db.prepare('UPDATE conversations SET link_id = ? WHERE id = ?').run(l.id, conv.id); conv.link_id = l.id; }
  const lead = garantirLead(tenant, contact, conv);
  // Primeiro canal que trouxe o cliente fica no negócio (não troca se ele voltar por outro link).
  if (lead && !lead.link_id) {
    db.prepare('UPDATE leads SET link_id = ? WHERE id = ?').run(l.id, lead.id);
    logActivity(tenant.id, lead.id, `🔗 Chegou pelo link "${l.nome}"`, { autor: 'sistema' });
  }
  return l;
}

export function contextoLink(conv) {
  if (!conv?.link_id) return '';
  const l = db.prepare('SELECT nome, frase FROM links_campanha WHERE id = ?').get(conv.link_id);
  return l ? `O cliente chegou pelo link de campanha "${l.nome}" (a primeira mensagem dele foi escrita pronta: "${l.frase}"). Não comente a frase; cumprimente e siga a qualificação.` : '';
}

/** Contatos, negócios, vendas e valor recebido por link. */
export function relatorioLinks(tenantId, dias = 90) {
  const desde = `-${Math.max(1, Math.min(3650, Number(dias) || 90))} days`;
  return db.prepare(`SELECT l.id, l.nome, l.frase, l.ativo, l.criado_em,
      (SELECT COUNT(DISTINCT c.contact_id) FROM conversations c WHERE c.link_id = l.id AND c.iniciada_em >= datetime('now', ?)) contatos,
      (SELECT COUNT(*) FROM leads x WHERE x.link_id = l.id AND x.criado_em >= datetime('now', ?)) negocios,
      (SELECT COUNT(*) FROM leads x WHERE x.link_id = l.id AND x.etapa = 'fechado' AND x.criado_em >= datetime('now', ?)) vendas,
      (SELECT COALESCE(SUM(ch.valor), 0) FROM charges ch JOIN leads x ON x.contact_id = ch.contact_id
         WHERE x.link_id = l.id AND ch.status = 'pago' AND ch.tenant_id = l.tenant_id AND x.criado_em >= datetime('now', ?)) recebido
    FROM links_campanha l WHERE l.tenant_id = ? ORDER BY l.id`).all(desde, desde, desde, desde, tenantId);
}

export function linksRouter(canSee) {
  const r = express.Router();
  const okT = (req, res, tid) => { if (!canSee(req, tid)) { res.sendStatus(403); return false; } return true; };
  const edita = (req, res) => { if (pode(req.user, 'configurar')) return true; res.status(403).json({ erro: 'Sem permissão' }); return false; };
  const validar = (tid, b, id = 0) => {
    const nome = String(b.nome || '').trim().slice(0, 60); const frase = String(b.frase || '').trim().slice(0, 200);
    if (!nome) throw new Error('Dê um nome ao canal (ex.: Instagram).');
    if (norm(frase).length < 12) throw new Error('A frase precisa ter pelo menos 12 letras, para não confundir com uma mensagem comum.');
    for (const o of db.prepare('SELECT id, nome, frase FROM links_campanha WHERE tenant_id = ? AND id != ?').all(tid, id)) {
      const a = norm(o.frase), n = norm(frase);
      if (a === n || a.includes(n) || n.includes(a)) throw new Error(`Essa frase se confunde com a do canal "${o.nome}". Use uma frase diferente.`);
    }
    return { nome, frase };
  };
  r.get('/tenants/:id/links', async (req, res) => {
    if (!okT(req, res, req.params.id)) return;
    const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id); if (!t) return res.sendStatus(404);
    const numero = numeroDaEmpresa(t);
    const links = await Promise.all(relatorioLinks(t.id, req.query.dias).map(async (l) => {
      const url = urlLink(numero, l.frase);
      return { ...l, url, qr: url ? await QRCode.toString(url, { type: 'svg', margin: 1, width: 220 }) : null };
    }));
    res.json({ numero, links, sugestoes: SUGESTOES });
  });
  r.post('/tenants/:id/links', (req, res) => {
    if (!okT(req, res, req.params.id) || !edita(req, res)) return;
    try {
      const tid = Number(req.params.id);
      if (db.prepare('SELECT COUNT(*) n FROM links_campanha WHERE tenant_id = ?').get(tid).n >= 50) throw new Error('Limite de 50 links.');
      const { nome, frase } = validar(tid, req.body || {});
      const x = db.prepare('INSERT INTO links_campanha (tenant_id, nome, frase) VALUES (?, ?, ?)').run(tid, nome, frase);
      res.status(201).json({ id: Number(x.lastInsertRowid) });
    } catch (e) { res.status(400).json({ erro: e.message }); }
  });
  const carregar = (req, res) => {
    const l = db.prepare('SELECT * FROM links_campanha WHERE id = ?').get(req.params.id);
    if (!l) { res.sendStatus(404); return null; }
    return okT(req, res, l.tenant_id) && edita(req, res) ? l : null;
  };
  r.put('/links/:id', (req, res) => {
    const l = carregar(req, res); if (!l) return;
    try {
      const b = req.body || {};
      const v = (b.nome !== undefined || b.frase !== undefined) ? validar(l.tenant_id, { nome: b.nome ?? l.nome, frase: b.frase ?? l.frase }, l.id) : l;
      db.prepare('UPDATE links_campanha SET nome = ?, frase = ?, ativo = ? WHERE id = ?').run(v.nome, v.frase, b.ativo !== undefined ? (b.ativo ? 1 : 0) : l.ativo, l.id);
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ erro: e.message }); }
  });
  r.delete('/links/:id', (req, res) => {
    const l = carregar(req, res); if (!l) return;
    db.prepare('DELETE FROM links_campanha WHERE id = ?').run(l.id);
    res.json({ ok: true });
  });
  return r;
}
