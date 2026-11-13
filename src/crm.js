// CRM do AVA Connect: leads, funil, atividades/tarefas, métricas e exportação.
import express from 'express';
import { db, logActivity } from './db.js';

export const ETAPAS = ['novo', 'qualificado', 'proposta', 'fechado', 'perdido'];
const EDITAVEIS = ['nome', 'empresa', 'email', 'interesse', 'etapa', 'resumo', 'valor_estimado', 'responsavel', 'tags', 'motivo_perda'];
const TIPOS = ['nota', 'tarefa', 'ligacao', 'whatsapp', 'reuniao'];

export function crmRouter(canSee) {
  const r = express.Router();

  const loadLead = (req, res) => {
    const l = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
    if (!l) { res.sendStatus(404); return null; }
    if (!canSee(req, l.tenant_id)) { res.sendStatus(403); return null; }
    return l;
  };
  const autorDe = (req) => (req.user.admin ? 'Avantte' : 'atendente');

  // Lista com busca, filtro e próxima tarefa pendente
  r.get('/tenants/:id/leads', (req, res) => {
    if (!canSee(req, req.params.id)) return res.sendStatus(403);
    const q = `%${(req.query.q || '').trim()}%`;
    const rows = db.prepare(`SELECT l.*, ct.telefone, ct.nome contato_nome,
        (SELECT MIN(vence_em) FROM activities a WHERE a.lead_id = l.id AND a.tipo = 'tarefa' AND a.concluida = 0) proxima_tarefa,
        (SELECT COUNT(*) FROM activities a WHERE a.lead_id = l.id AND a.tipo = 'tarefa' AND a.concluida = 0) tarefas_abertas
      FROM leads l JOIN contacts ct ON ct.id = l.contact_id
      WHERE l.tenant_id = ? ${req.query.etapa ? 'AND l.etapa = ?' : ''}
        AND (? = '%%' OR l.nome LIKE ? OR l.empresa LIKE ? OR ct.telefone LIKE ? OR l.interesse LIKE ? OR l.tags LIKE ?)
      ORDER BY l.atualizado_em DESC LIMIT 1000`)
      .all(...[req.params.id, req.query.etapa].filter(Boolean), q, q, q, q, q, q);
    res.json(rows);
  });

  // Lead criado manualmente (telefone obrigatório: o contato é a chave do WhatsApp)
  r.post('/tenants/:id/leads', (req, res) => {
    if (!canSee(req, req.params.id)) return res.sendStatus(403);
    const b = req.body || {};
    const telefone = String(b.telefone || '').replace(/\D/g, '');
    if (telefone.length < 10) return res.status(400).json({ erro: 'Informe o telefone com DDD' });
    if (b.etapa && !ETAPAS.includes(b.etapa)) return res.status(400).json({ erro: 'Etapa inválida' });
    db.prepare(`INSERT INTO contacts (tenant_id, telefone, nome) VALUES (?, ?, ?)
      ON CONFLICT(tenant_id, telefone) DO UPDATE SET nome = COALESCE(excluded.nome, contacts.nome)`).run(req.params.id, telefone, b.nome || null);
    const ct = db.prepare('SELECT id FROM contacts WHERE tenant_id = ? AND telefone = ?').get(req.params.id, telefone);
    if (db.prepare('SELECT 1 FROM leads WHERE tenant_id = ? AND contact_id = ?').get(req.params.id, ct.id))
      return res.status(409).json({ erro: 'Já existe um lead com esse telefone' });
    const info = db.prepare(`INSERT INTO leads (tenant_id, contact_id, nome, empresa, email, interesse, etapa, resumo, valor_estimado, responsavel, tags, origem, criado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', datetime('now'))`)
      .run(req.params.id, ct.id, b.nome || null, b.empresa || null, b.email || null, b.interesse || null, b.etapa || 'novo',
        b.resumo || null, b.valor_estimado ? Number(b.valor_estimado) : null, b.responsavel || null, b.tags || null);
    logActivity(Number(req.params.id), info.lastInsertRowid, 'Lead cadastrado manualmente', { autor: autorDe(req) });
    res.status(201).json(db.prepare('SELECT * FROM leads WHERE id = ?').get(info.lastInsertRowid));
  });

  // Ficha completa
  r.get('/leads/:id', (req, res) => {
    const l = loadLead(req, res); if (!l) return;
    const contato = db.prepare('SELECT * FROM contacts WHERE id = ?').get(l.contact_id);
    const atividades = db.prepare('SELECT * FROM activities WHERE lead_id = ? ORDER BY concluida, COALESCE(vence_em, criado_em) DESC, id DESC').all(l.id);
    const conversas = db.prepare('SELECT id, status, canal, iniciada_em, ultima_mensagem_em FROM conversations WHERE contact_id = ? ORDER BY id DESC').all(l.contact_id);
    res.json({ ...l, contato, atividades, conversas });
  });

  r.put('/leads/:id', (req, res) => {
    const l = loadLead(req, res); if (!l) return;
    const b = req.body || {};
    if (b.etapa && !ETAPAS.includes(b.etapa)) return res.status(400).json({ erro: 'Etapa inválida' });
    const campos = EDITAVEIS.filter((f) => b[f] !== undefined);
    if (campos.length) {
      const val = (f) => (b[f] === '' ? null : f === 'valor_estimado' && b[f] != null ? Number(b[f]) : b[f]);
      db.prepare(`UPDATE leads SET ${campos.map((f) => `${f} = ?`).join(', ')}, atualizado_em = datetime('now') WHERE id = ?`)
        .run(...campos.map(val), l.id);
    }
    if (b.etapa && b.etapa !== l.etapa) {
      db.prepare(`UPDATE leads SET fechado_em = CASE WHEN ? IN ('fechado','perdido') THEN datetime('now') ELSE NULL END WHERE id = ?`).run(b.etapa, l.id);
      logActivity(l.tenant_id, l.id, `Etapa: ${l.etapa} → ${b.etapa}${b.etapa === 'perdido' && b.motivo_perda ? ' (' + b.motivo_perda + ')' : ''}`, { autor: autorDe(req) });
    }
    if (b.nome) db.prepare('UPDATE contacts SET nome = ? WHERE id = ?').run(b.nome, l.contact_id);
    res.json(db.prepare('SELECT * FROM leads WHERE id = ?').get(l.id));
  });

  r.delete('/leads/:id', (req, res) => {
    const l = loadLead(req, res); if (!l) return;
    db.prepare('DELETE FROM leads WHERE id = ?').run(l.id);
    res.json({ ok: true });
  });

  // Atividades: nota, tarefa com vencimento, ligação, etc.
  r.post('/leads/:id/activities', (req, res) => {
    const l = loadLead(req, res); if (!l) return;
    const b = req.body || {};
    if (!TIPOS.includes(b.tipo)) return res.status(400).json({ erro: 'Tipo inválido' });
    if (!String(b.descricao || '').trim()) return res.status(400).json({ erro: 'Descreva a atividade' });
    logActivity(l.tenant_id, l.id, String(b.descricao).trim(), { tipo: b.tipo, autor: autorDe(req), vence_em: b.tipo === 'tarefa' ? (b.vence_em || null) : null });
    db.prepare("UPDATE leads SET atualizado_em = datetime('now') WHERE id = ?").run(l.id);
    res.status(201).json({ ok: true });
  });

  r.put('/activities/:id', (req, res) => {
    const a = db.prepare('SELECT * FROM activities WHERE id = ?').get(req.params.id);
    if (!a) return res.sendStatus(404);
    if (!canSee(req, a.tenant_id)) return res.sendStatus(403);
    db.prepare('UPDATE activities SET concluida = ?, vence_em = COALESCE(?, vence_em) WHERE id = ?')
      .run(req.body?.concluida ? 1 : 0, req.body?.vence_em ?? null, a.id);
    res.json({ ok: true });
  });

  // Tarefas da empresa: atrasadas, hoje, próximas
  r.get('/tenants/:id/tasks', (req, res) => {
    if (!canSee(req, req.params.id)) return res.sendStatus(403);
    const rows = db.prepare(`SELECT a.*, l.nome lead_nome, l.empresa, l.etapa, ct.telefone
      FROM activities a JOIN leads l ON l.id = a.lead_id JOIN contacts ct ON ct.id = l.contact_id
      WHERE a.tenant_id = ? AND a.tipo = 'tarefa' AND a.concluida = 0
      ORDER BY a.vence_em IS NULL, a.vence_em LIMIT 500`).all(req.params.id);
    res.json(rows);
  });

  // Métricas do funil
  r.get('/tenants/:id/crm-stats', (req, res) => {
    if (!canSee(req, req.params.id)) return res.sendStatus(403);
    const id = req.params.id;
    const porEtapa = db.prepare('SELECT etapa, COUNT(*) n, COALESCE(SUM(valor_estimado),0) valor FROM leads WHERE tenant_id = ? GROUP BY etapa').all(id);
    const g = (e) => porEtapa.find((x) => x.etapa === e) || { n: 0, valor: 0 };
    const mes = db.prepare(`SELECT
        SUM(criado_em >= date('now','start of month')) novos,
        SUM(etapa = 'fechado' AND fechado_em >= date('now','start of month')) ganhos,
        COALESCE(SUM(CASE WHEN etapa = 'fechado' AND fechado_em >= date('now','start of month') THEN valor_estimado END),0) valor_ganho
      FROM leads WHERE tenant_id = ?`).get(id);
    const atrasadas = db.prepare(`SELECT COUNT(*) n FROM activities WHERE tenant_id = ? AND tipo = 'tarefa' AND concluida = 0
      AND vence_em IS NOT NULL AND vence_em < date('now','localtime')`).get(id).n;
    const decididos = g('fechado').n + g('perdido').n;
    res.json({
      por_etapa: Object.fromEntries(ETAPAS.map((e) => [e, g(e)])),
      pipeline_aberto: g('novo').valor + g('qualificado').valor + g('proposta').valor,
      taxa_conversao: decididos ? Math.round((100 * g('fechado').n) / decididos) : null,
      novos_mes: mes.novos || 0, ganhos_mes: mes.ganhos || 0, valor_ganho_mes: mes.valor_ganho || 0,
      tarefas_atrasadas: atrasadas,
    });
  });

  // Exportação CSV (abre no Excel)
  r.get('/tenants/:id/leads.csv', (req, res) => {
    if (!canSee(req, req.params.id)) return res.sendStatus(403);
    const rows = db.prepare(`SELECT l.nome, l.empresa, ct.telefone, l.email, l.interesse, l.etapa, l.valor_estimado, l.responsavel,
        l.tags, l.origem, l.resumo, l.criado_em, l.atualizado_em
      FROM leads l JOIN contacts ct ON ct.id = l.contact_id WHERE l.tenant_id = ? ORDER BY l.criado_em`).all(req.params.id);
    const cols = ['nome', 'empresa', 'telefone', 'email', 'interesse', 'etapa', 'valor_estimado', 'responsavel', 'tags', 'origem', 'resumo', 'criado_em', 'atualizado_em'];
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`;
    const csv = '﻿' + [cols.join(';'), ...rows.map((r) => cols.map((c) => cell(r[c])).join(';'))].join('\r\n');
    res.set({ 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="leads.csv"' }).send(csv);
  });

  return r;
}
