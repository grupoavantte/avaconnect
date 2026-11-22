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

// ---- Funil de diagnóstico, pagamentos e cadências ----
const tenantCols = db.prepare('PRAGMA table_info(tenants)').all().map((c) => c.name);
for (const [col, def] of [
  ['diagnostico_ativo', 'INTEGER NOT NULL DEFAULT 0'],
  ['diagnostico_preco', 'REAL NOT NULL DEFAULT 297'],
  ['link_agendamento', 'TEXT'],                    // link da agenda para a reunião gratuita (Google Agenda, Calendly...)
  ['consultoria_descricao', 'TEXT'],               // como a IA apresenta a consultoria
  ['wa_template_followup', 'TEXT'],                // nome do modelo aprovado na Meta para o contato D+1
]) if (!tenantCols.includes(col)) db.exec(`ALTER TABLE tenants ADD COLUMN ${col} ${def}`);

db.exec(`
CREATE TABLE IF NOT EXISTS diagnostics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'em_andamento',     -- em_andamento | aguardando_pagamento | pago | cancelado
  etapa INTEGER NOT NULL DEFAULT 0,                -- índice da próxima pergunta
  respostas TEXT NOT NULL DEFAULT '{}',            -- JSON {id_pergunta: valor}
  nota_geral INTEGER,
  notas TEXT,                                      -- JSON {area: nota}
  valor REAL,
  pagamento_ref TEXT,                              -- id do link/cobrança no gateway
  pagamento_url TEXT,
  token TEXT NOT NULL UNIQUE,                      -- acesso ao relatório
  relatorio_ia TEXT,                               -- análise personalizada gerada pela IA (JSON)
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  pago_em TEXT
);
CREATE INDEX IF NOT EXISTS idx_diag_contact ON diagnostics(contact_id, status);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL,                              -- followup_consultoria | ...
  payload TEXT NOT NULL DEFAULT '{}',
  executar_em TEXT NOT NULL,                       -- UTC 'AAAA-MM-DD HH:MM:SS'
  status TEXT NOT NULL DEFAULT 'pendente',         -- pendente | feito | erro | cancelado
  resultado TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, executar_em);
`);

// Tabelas comerciais (catálogo, propostas, cobranças, agenda) — criadas aqui para existirem antes de qualquer módulo.
db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  descricao TEXT,
  preco REAL NOT NULL,
  preco_minimo REAL,                -- abaixo disso só com aprovação
  unidade TEXT NOT NULL DEFAULT 'un',
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  numero INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'enviada',   -- aguardando_aprovacao | enviada | aceita | paga | recusada | expirada | substituida
  itens TEXT NOT NULL DEFAULT '[]',
  subtotal REAL NOT NULL DEFAULT 0,          -- pelo preço de tabela
  desconto_percentual REAL NOT NULL DEFAULT 0, -- desconto efetivo sobre a tabela
  frete REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  condicao_pagamento TEXT,
  observacoes TEXT,
  email TEXT,
  validade TEXT,                              -- AAAA-MM-DD
  motivo_aprovacao TEXT,
  autor TEXT NOT NULL DEFAULT 'ia',
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  enviada_em TEXT,
  paga_em TEXT
);
CREATE INDEX IF NOT EXISTS idx_prop_contact ON proposals(contact_id, status);
CREATE TABLE IF NOT EXISTS charges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  proposal_id INTEGER REFERENCES proposals(id) ON DELETE SET NULL,
  token TEXT NOT NULL UNIQUE,
  descricao TEXT NOT NULL,
  valor REAL NOT NULL,
  forma TEXT NOT NULL DEFAULT 'livre',       -- pix | boleto | cartao | livre
  parcelas INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pendente',   -- pendente | pago | vencido | cancelado
  pagamento_ref TEXT,
  pagamento_url TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  pago_em TEXT
);
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  inicio TEXT NOT NULL,                      -- horário de Brasília 'AAAA-MM-DD HH:MM'
  fim TEXT NOT NULL,
  assunto TEXT,
  status TEXT NOT NULL DEFAULT 'agendada',   -- agendada | realizada | cancelada | faltou
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_appt ON appointments(tenant_id, inicio);
`);

export function logActivity(tenantId, leadId, descricao, { tipo = 'sistema', autor = 'sistema', vence_em = null } = {}) {
  return db.prepare('INSERT INTO activities (tenant_id, lead_id, tipo, descricao, vence_em, autor) VALUES (?, ?, ?, ?, ?, ?)')
    .run(tenantId, leadId, tipo, descricao, vence_em, autor).lastInsertRowid;
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
  const { wa_token, painel_token, asaas_api_key, asaas_webhook_token, gateway_config, ...rest } = t;
  const flags = { wa_token_configurado: !!wa_token, asaas_configurado: !!asaas_api_key };
  return withSecrets ? { ...rest, ...flags, painel_token } : { ...rest, ...flags };
}
