import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DB_PATH = process.env.DB_PATH || path.resolve('data/ava-connect.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  plano TEXT NOT NULL DEFAULT 'essencial',
  status TEXT NOT NULL DEFAULT 'ativo',          -- ativo | pausado | cancelado
  nome_assistente TEXT NOT NULL DEFAULT 'AVA',
  persona TEXT NOT NULL DEFAULT '',
  base_conhecimento TEXT NOT NULL DEFAULT '',
  horario_atendimento TEXT NOT NULL DEFAULT 'Segunda a sexta, 8h às 18h',
  telefone_responsavel TEXT,
  wa_phone_number_id TEXT UNIQUE,
  wa_token TEXT,
  painel_token TEXT NOT NULL UNIQUE,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  telefone TEXT NOT NULL,
  nome TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, telefone)
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'ia',              -- ia | humano | encerrada
  canal TEXT NOT NULL DEFAULT 'whatsapp',         -- whatsapp | simulador
  motivo_transbordo TEXT,
  iniciada_em TEXT NOT NULL DEFAULT (datetime('now')),
  ultima_mensagem_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_conv_tenant ON conversations(tenant_id, ultima_mensagem_em);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  autor TEXT NOT NULL,                             -- cliente | ia | humano | sistema
  conteudo TEXT NOT NULL,
  wa_id TEXT UNIQUE,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id);
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  nome TEXT,
  interesse TEXT,
  etapa TEXT NOT NULL DEFAULT 'novo',             -- novo | qualificado | proposta | fechado | perdido
  resumo TEXT,
  valor_estimado REAL,
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, contact_id)
);
CREATE TABLE IF NOT EXISTS usage (
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mes TEXT NOT NULL,                               -- AAAA-MM
  conversas INTEGER NOT NULL DEFAULT 0,
  mensagens_ia INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, mes)
);
`);

// ---- CRM: colunas extras de leads (migração idempotente) e atividades ----
const leadCols = db.prepare('PRAGMA table_info(leads)').all().map((c) => c.name);
for (const [col, def] of [
  ['empresa', 'TEXT'], ['email', 'TEXT'], ['origem', "TEXT NOT NULL DEFAULT 'whatsapp'"], ['responsavel', 'TEXT'],
  ['tags', 'TEXT'], ['motivo_perda', 'TEXT'], ['criado_em', 'TEXT'], ['fechado_em', 'TEXT'],
]) if (!leadCols.includes(col)) db.exec(`ALTER TABLE leads ADD COLUMN ${col} ${def}`);
db.exec("UPDATE leads SET criado_em = atualizado_em WHERE criado_em IS NULL");

db.exec(`
CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL DEFAULT 'nota',               -- nota | tarefa | ligacao | whatsapp | reuniao | sistema
  descricao TEXT NOT NULL,
  vence_em TEXT,                                   -- só para tarefas (AAAA-MM-DD ou AAAA-MM-DDTHH:MM)
  concluida INTEGER NOT NULL DEFAULT 0,
  autor TEXT NOT NULL DEFAULT 'sistema',           -- ia | atendente | sistema
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_act_lead ON activities(lead_id, id);
CREATE INDEX IF NOT EXISTS idx_act_tasks ON activities(tenant_id, concluida, vence_em);
`);

export function logActivity(tenantId, leadId, descricao, { tipo = 'sistema', autor = 'sistema', vence_em = null } = {}) {
  db.prepare('INSERT INTO activities (tenant_id, lead_id, tipo, descricao, vence_em, autor) VALUES (?, ?, ?, ?, ?, ?)')
    .run(tenantId, leadId, tipo, descricao, vence_em, autor);
}

export const newToken =() => 'ava_' + crypto.randomBytes(18).toString('hex');
export const currentMonth = () => new Date().toISOString().slice(0, 7);

export function bumpUsage(tenantId, field) {
  db.prepare(`INSERT INTO usage (tenant_id, mes, ${field}) VALUES (?, ?, 1)
    ON CONFLICT(tenant_id, mes) DO UPDATE SET ${field} = ${field} + 1`).run(tenantId, currentMonth());
}

export function getUsage(tenantId) {
  return db.prepare('SELECT conversas, mensagens_ia FROM usage WHERE tenant_id = ? AND mes = ?')
    .get(tenantId, currentMonth()) || { conversas: 0, mensagens_ia: 0 };
}

// Remove segredos antes de devolver ao painel.
export function publicTenant(t, { withSecrets = false } = {}) {
  if (!t) return t;
  const { wa_token, painel_token, ...rest } = t;
  return withSecrets
    ? { ...rest, wa_token_configurado: !!wa_token, painel_token }
    : { ...rest, wa_token_configurado: !!wa_token };
}
