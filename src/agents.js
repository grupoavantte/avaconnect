import { gatewayDe } from './gateways.js';
// Agentes de IA por empresa, números de WhatsApp, conexões (integrações) e roteiro de implantação.
import express from 'express';
import { db } from './db.js';
import { getPlan } from './plans.js';
import { pode } from './auth.js';
import { EMAIL_MODE } from './email.js';
import { publicUrl } from './payments.js';
import { SEGMENTOS, listaSegmentos } from './segmentos.js';

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,                       -- como se apresenta ao cliente (ex.: AVA)
  funcao TEXT NOT NULL DEFAULT 'Atendimento',
  modelo_base TEXT NOT NULL DEFAULT 'recepcao',
  instrucoes TEXT NOT NULL DEFAULT '',       -- como este agente trabalha (somado às instruções da empresa)
  habilidades TEXT NOT NULL DEFAULT '["transferir"]',
  modelo_ia TEXT NOT NULL DEFAULT 'padrao',  -- padrao | avancado
  padrao INTEGER NOT NULL DEFAULT 0,         -- atende números sem agente definido
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS whatsapp_numbers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nome TEXT NOT NULL DEFAULT 'Principal',
  telefone TEXT,                             -- número exibido (ex.: 5524999990000)
  phone_number_id TEXT NOT NULL UNIQUE,
  waba_id TEXT,
  token TEXT,
  agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  principal INTEGER NOT NULL DEFAULT 0,
  status_teste TEXT,
  testado_em TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
const agCols = db.prepare('PRAGMA table_info(agents)').all().map((c) => c.name);
if (!agCols.includes('tom')) db.exec("ALTER TABLE agents ADD COLUMN tom TEXT NOT NULL DEFAULT 'amigavel'");
const tCols = db.prepare('PRAGMA table_info(tenants)').all().map((c) => c.name);
for (const [col, def] of [['segmento', 'TEXT'], ['cidade', 'TEXT'], ['site', 'TEXT'], ['base_guiada', 'TEXT'], ['onboarding_concluido', 'INTEGER NOT NULL DEFAULT 0'], ['regras_setor', 'TEXT']])
  if (!tCols.includes(col)) db.exec(`ALTER TABLE tenants ADD COLUMN ${col} ${def}`);
const convCols = db.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name);
if (!convCols.includes('agent_id')) db.exec('ALTER TABLE conversations ADD COLUMN agent_id INTEGER');
if (!convCols.includes('numero_id')) db.exec('ALTER TABLE conversations ADD COLUMN numero_id INTEGER');

// Migração: o número que estava na própria empresa vira o número principal.
for (const t of db.prepare("SELECT id, wa_phone_number_id, wa_token FROM tenants WHERE wa_phone_number_id IS NOT NULL AND wa_phone_number_id != ''").all()) {
  if (!db.prepare('SELECT 1 FROM whatsapp_numbers WHERE phone_number_id = ?').get(t.wa_phone_number_id))
    db.prepare("INSERT INTO whatsapp_numbers (tenant_id, nome, phone_number_id, token, principal) VALUES (?, 'Principal', ?, ?, 1)").run(t.id, t.wa_phone_number_id, t.wa_token);
}

export const TONS = {
  formal: 'Formal e respeitoso: trate por "senhor/senhora" quando fizer sentido, sem gírias e sem emojis.',
  amigavel: 'Amigável e profissional: próximo, claro, no máximo um emoji quando combinar.',
  descontraido: 'Descontraído: leve, bem-humorado e direto, pode usar emojis com moderação.',
};

export const HABILIDADES = {
  transferir: 'Passar para um atendente humano',
  agenda: 'Marcar reuniões, visitas e demonstrações',
  vendas: 'Proposta, negociação, cobrança e follow-up',
  diagnostico: 'Aplicar o Diagnóstico Empresarial',
  loja: 'Loja (AvaShop): fotos, frete, pedido e pagamento',
};

export const MODELOS_AGENTE = {
  recepcao: {
    nome: 'Recepção', funcao: 'Atendimento', habilidades: ['transferir', 'agenda'],
    instrucoes: 'Você é a primeira voz da empresa. Cumprimente, entenda rapidamente o que a pessoa precisa, responda dúvidas com a base de conhecimento e registre o contato. Seja calorosa e objetiva.',
  },
  vendas: {
    nome: 'Vendas', funcao: 'Vendedora', habilidades: ['transferir', 'agenda', 'vendas'],
    instrucoes: 'Você é a vendedora da empresa. Seu objetivo é transformar conversas em pedidos pagos: qualifique, recomende, envie a proposta, trate objeções, feche e cobre. Seja consultiva, nunca insistente.',
  },
  posvenda: {
    nome: 'Pós-venda', funcao: 'Suporte e pós-venda', habilidades: ['transferir', 'agenda'],
    instrucoes: 'Você cuida de quem já é cliente: status de pedido, dúvidas de uso, garantia e assistência. Quando houver oportunidade de nova compra, registre o lead. Reclamações vão para um humano.',
  },
  loja: {
    nome: 'Loja', funcao: 'Vendedora da loja (AvaShop)', habilidades: ['transferir', 'loja'],
    instrucoes: 'Você vende os produtos da loja pelo WhatsApp, 24 horas: mostra fotos, tira dúvidas, calcula o frete, fecha o pedido e envia o link de pagamento. Seja rápida, simpática e objetiva.',
  },
  sdr: {
    nome: 'Diagnóstico', funcao: 'Pré-vendas (diagnóstico)', habilidades: ['transferir', 'agenda', 'diagnostico'],
    instrucoes: 'Você qualifica empresários e oferece o Diagnóstico Empresarial como porta de entrada. Depois do diagnóstico, leve para a reunião gratuita.',
  },
};

const habs = (a) => { try { return JSON.parse(a.habilidades); } catch { return []; } };
export const getAgente = (id) => (id ? db.prepare('SELECT * FROM agents WHERE id = ?').get(id) : null);
export const agentePadrao = (tenantId) =>
  db.prepare('SELECT * FROM agents WHERE tenant_id = ? AND ativo = 1 ORDER BY padrao DESC, id LIMIT 1').get(tenantId);

/** Número de WhatsApp pelo phone_number_id da Meta (webhook). */
export function numeroPorPhoneId(phoneNumberId) {
  return db.prepare('SELECT * FROM whatsapp_numbers WHERE phone_number_id = ?').get(phoneNumberId);
}

/**
 * Monta a "empresa efetiva" usada pela IA e pelo envio: dados da empresa + agente + número.
 * Sem agentes cadastrados, mantém o comportamento antigo (todas as habilidades ligadas pela empresa).
 */
export function efetivo(tenant, { agent = null, numero = null } = {}) {
  const plano = getPlan(tenant.plano);
  const t = { ...tenant };
  if (numero) { t.wa_phone_number_id = numero.phone_number_id; t.wa_token = numero.token || tenant.wa_token; t._numero_id = numero.id; }
  if (!agent) agent = (numero?.agent_id && getAgente(numero.agent_id)) || agentePadrao(tenant.id);
  if (!agent) { t.vendas_ativo = tenant.vendas_ativo && plano.vendas ? 1 : 0; t.loja_ativa_efetiva = tenant.loja_ativa && plano.vendas ? 1 : 0; return t; }
  const h = habs(agent);
  t._agent_id = agent.id;
  t._habilidades = h;
  t.nome_assistente = agent.nome;
  t.persona = [tenant.persona, agent.instrucoes && `Sua função: ${agent.funcao}. ${agent.instrucoes}`, TONS[agent.tom] && `Tom de voz: ${TONS[agent.tom]}`].filter(Boolean).join('\n\n');
  t.vendas_ativo = tenant.vendas_ativo && plano.vendas && (h.includes('vendas') || h.includes('agenda')) ? 1 : 0;
  t.diagnostico_ativo = tenant.diagnostico_ativo && h.includes('diagnostico') ? 1 : 0;
  t._modelo = agent.modelo_ia === 'avancado' && plano.modelo_avancado ? 'avancado' : 'padrao';
  t.loja_ativa_efetiva = tenant.loja_ativa && plano.vendas && h.includes('loja') ? 1 : 0;
  // Agenda funciona em qualquer plano, mesmo sem o módulo de vendas.
  if (!t.vendas_ativo && h.includes('agenda')) t._so_agenda = 1;
  return t;
}

/** Empresa efetiva para mensagens que o sistema envia sozinho (follow-up, cobrança), pela última conversa do contato. */
export function efetivoDoContato(tenant, contactId) {
  const c = db.prepare('SELECT agent_id, numero_id FROM conversations WHERE contact_id = ? ORDER BY id DESC LIMIT 1').get(contactId);
  const numero = c?.numero_id ? db.prepare('SELECT * FROM whatsapp_numbers WHERE id = ?').get(c.numero_id) : principal(tenant.id);
  return efetivo(tenant, { agent: getAgente(c?.agent_id), numero });
}
export const principal = (tenantId) =>
  db.prepare('SELECT * FROM whatsapp_numbers WHERE tenant_id = ? ORDER BY principal DESC, id LIMIT 1').get(tenantId);

// Mantém wa_phone_number_id/wa_token da empresa iguais ao número principal (compatibilidade).
export function sincronizarPrincipal(tenantId) {
  const n = principal(tenantId);
  db.prepare('UPDATE tenants SET wa_phone_number_id = ?, wa_token = ? WHERE id = ?').run(n?.phone_number_id ?? null, n?.token ?? null, tenantId);
}

export function criarAgente(tenantId, { modelo = 'recepcao', nome, funcao, instrucoes, habilidades, modelo_ia = 'padrao', padrao } = {}) {
  const m = MODELOS_AGENTE[modelo] || MODELOS_AGENTE.recepcao;
  const temPadrao = db.prepare('SELECT 1 FROM agents WHERE tenant_id = ? AND padrao = 1').get(tenantId);
  const r = db.prepare('INSERT INTO agents (tenant_id, nome, funcao, modelo_base, instrucoes, habilidades, modelo_ia, padrao) VALUES (?,?,?,?,?,?,?,?)')
    .run(tenantId, nome || 'AVA', funcao || m.funcao, modelo, instrucoes ?? m.instrucoes, JSON.stringify((habilidades || m.habilidades).filter((h) => HABILIDADES[h])),
      modelo_ia, padrao ?? (temPadrao ? 0 : 1));
  return getAgente(r.lastInsertRowid);
}

/** Aplica o modelo do segmento: regras do setor + agente padrão (função, instruções, tom, habilidades). */
export function aplicarSegmento(tenantId, segId) {
  const seg = SEGMENTOS[segId]; if (!seg) throw new Error('Segmento inválido');
  const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);
  const plano = getPlan(t.plano);
  const modelo = ['vendas', 'loja'].includes(seg.modelo) && !plano.vendas ? 'recepcao' : seg.modelo;
  const m = MODELOS_AGENTE[modelo];
  db.prepare('UPDATE tenants SET segmento = ?, regras_setor = ?, vendas_ativo = CASE WHEN ? THEN 1 ELSE vendas_ativo END, loja_ativa = CASE WHEN ? THEN 1 ELSE loja_ativa END WHERE id = ?')
    .run(segId, seg.regras || null, modelo === 'vendas' ? 1 : 0, modelo === 'loja' ? 1 : 0, t.id);
  const ag = agentePadrao(t.id);
  const dados = { funcao: m.funcao, instrucoes: seg.instrucoes, tom: seg.tom, habilidades: JSON.stringify(m.habilidades) };
  if (ag) db.prepare('UPDATE agents SET funcao = ?, instrucoes = ?, tom = ?, habilidades = ?, modelo_base = ? WHERE id = ?')
    .run(dados.funcao, dados.instrucoes, dados.tom, dados.habilidades, modelo, ag.id);
  else { const a = criarAgente(t.id, { modelo, nome: 'AVA', instrucoes: seg.instrucoes }); db.prepare('UPDATE agents SET tom = ? WHERE id = ?').run(seg.tom, a.id); }
  return { segmento: segId, modelo };
}

// ---------- Testes de conexão ----------
const GRAPH = `https://graph.facebook.com/${process.env.WA_GRAPH_VERSION || 'v21.0'}`;
async function testarWhatsApp(n) {
  const token = n.token;
  if (!token) return { ok: false, msg: 'Falta o token de acesso' };
  try {
    const r = await fetch(`${GRAPH}/${n.phone_number_id}?fields=display_phone_number,verified_name,quality_rating`, { headers: { authorization: `Bearer ${token}` } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, msg: d.error?.message || `Meta respondeu ${r.status}` };
    return { ok: true, msg: `${d.verified_name || ''} ${d.display_phone_number || ''}`.trim() || 'Conectado', telefone: d.display_phone_number };
  } catch (e) { return { ok: false, msg: 'Sem resposta da Meta: ' + e.message }; }
}
async function testarAsaas(key) {
  if (!key) return { ok: false, msg: 'Chave não cadastrada' };
  const base = process.env.ASAAS_BASE_URL || 'https://api.asaas.com/v3';
  try {
    const r = await fetch(`${base}/finance/balance`, { headers: { access_token: key, 'user-agent': 'ava-connect' } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, msg: d.errors?.[0]?.description || `Asaas respondeu ${r.status}` };
    return { ok: true, msg: 'Conta Asaas conectada' };
  } catch (e) { return { ok: false, msg: 'Sem resposta do Asaas: ' + e.message }; }
}

// ---------- Roteiro de implantação ----------
export function implantacao(tenantId) {
  const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);
  const plano = getPlan(t.plano);
  const n = (sql, ...a) => db.prepare(sql).get(tenantId, ...a).n;
  const agentes = db.prepare('SELECT * FROM agents WHERE tenant_id = ? AND ativo = 1').all(tenantId);
  const vendeAlgum = agentes.some((a) => habs(a).includes('vendas') || habs(a).includes('loja'));
  const lojaAlgum = agentes.some((a) => habs(a).includes('loja'));
  const passos = [
    { id: 'empresa', titulo: 'Dados da empresa e horário', feito: !!(t.nome && t.horario_atendimento), onde: 'config:empresa' },
    { id: 'base', titulo: 'Base de conhecimento (produtos, prazos, formas de pagamento, dúvidas frequentes)', feito: (t.base_conhecimento || '').length >= 300, onde: 'config:empresa' },
    { id: 'agente', titulo: 'Agente de IA criado e configurado', feito: agentes.length > 0, onde: 'config:agentes' },
    { id: 'usuarios', titulo: 'Dono com acesso ao painel (senha criada)', feito: n("SELECT COUNT(*) n FROM users WHERE tenant_id = ? AND papel = 'dono' AND senha_hash IS NOT NULL") > 0, onde: 'config:usuarios' },
    { id: 'whatsapp', titulo: 'WhatsApp conectado (Meta)', feito: n("SELECT COUNT(*) n FROM whatsapp_numbers WHERE tenant_id = ? AND status_teste = 'ok'") > 0, onde: 'config:conexoes' },
    { id: 'responsavel', titulo: 'WhatsApp do responsável para avisos e aprovações', feito: !!t.telefone_responsavel || n("SELECT COUNT(*) n FROM users WHERE tenant_id = ? AND papel IN ('dono','gestor') AND telefone IS NOT NULL") > 0, onde: 'config:usuarios' },
  ];
  if (vendeAlgum && plano.vendas) {
    passos.push({ id: 'vendas', titulo: 'Módulo de vendas ligado', feito: !!t.vendas_ativo, onde: 'vendas:config' });
    passos.push({ id: 'catalogo', titulo: 'Catálogo com preços', feito: n('SELECT COUNT(*) n FROM products WHERE tenant_id = ? AND ativo = 1') > 0, onde: 'vendas:catalogo' });
    if (lojaAlgum) passos.push({ id: 'loja', titulo: 'Loja ligada, com fotos e frete configurado', feito: !!t.loja_ativa && n('SELECT COUNT(*) n FROM product_images WHERE tenant_id = ?') > 0 && !!(t.melhorenvio_token || t.entrega_local || t.retirada_endereco), onde: 'vendas:loja' });
    passos.push({ id: 'asaas', titulo: 'Forma de receber os pagamentos (Asaas, Mercado Pago, Pagar.me ou Pix)', feito: !!gatewayDe(t, t.asaas_api_key || (process.env.ASAAS_API_KEY && t.id === Number(process.env.ASAAS_TENANT_ID || 1) ? 'global' : null)), onde: 'config:conexoes' });
  }
  passos.push({ id: 'teste', titulo: 'Teste completo no Simulador', feito: n("SELECT COUNT(*) n FROM conversations WHERE tenant_id = ? AND canal = 'simulador'") > 0, onde: 'simulador' });
  return { passos, concluidos: passos.filter((p) => p.feito).length, total: passos.length };
}

// ---------- Base de conhecimento guiada ----------
const pick = (o = {}, ks) => Object.fromEntries(ks.filter((k) => o[k] !== undefined && o[k] !== '').map((k) => [k, o[k]]));
export function montarBase(t, g = {}) {
  const sec = (titulo, txt) => (txt && String(txt).trim() ? `${titulo}\n${String(txt).trim()}\n` : '');
  const sobre = [t.nome && `Empresa: ${t.nome}`, t.segmento && `Segmento: ${SEGMENTOS[t.segmento]?.nome || t.segmento}`, t.cidade && `Cidade: ${t.cidade}`, t.site && `Site/Instagram: ${t.site}`,
    t.horario_atendimento && `Horário de atendimento: ${t.horario_atendimento}`, g.sobre].filter(Boolean).join('\n');
  const faq = (Array.isArray(g.faq) ? g.faq : []).filter((f) => f?.p && f?.r).map((f) => `P: ${f.p.trim()}\nR: ${f.r.trim()}`).join('\n\n');
  return [sec('SOBRE A EMPRESA', sobre), sec('O QUE VENDEMOS', g.produtos), sec('DIFERENCIAIS', g.diferenciais), sec('REGIÃO ATENDIDA E ENTREGA', g.entrega),
    sec('FORMAS DE PAGAMENTO', g.pagamento), sec('PRAZOS', g.prazos), sec('GARANTIA, TROCAS E ASSISTÊNCIA', g.garantia),
    sec('PERGUNTAS FREQUENTES', faq), sec('QUANDO PASSAR PARA UM ATENDENTE', g.limites), sec('OUTRAS INFORMAÇÕES', g.outras)].filter(Boolean).join('\n').trim();
}

// ---------- API ----------
const pubNumero = ({ token, ...n }) => ({ ...n, token_configurado: !!token });

export function agentesRouter(canSee) {
  const r = express.Router();
  const ok = (req, res, tenantId, acao) => {
    if (!canSee(req, tenantId)) { res.sendStatus(403); return false; }
    if (acao && !pode(req.user, acao)) { res.status(403).json({ erro: 'Sem permissão para esta ação' }); return false; }
    return true;
  };
  const validarHabs = (t, hs) => {
    if (!Array.isArray(hs) || hs.some((h) => !HABILIDADES[h])) return 'Habilidade inválida';
    if ((hs.includes('vendas') || hs.includes('loja')) && !getPlan(t.plano).vendas) return `O agente de vendas faz parte do plano Profissional ou Premium (atual: ${getPlan(t.plano).nome}).`;
    return null;
  };

  r.post('/tenants/:id/segmento', (req, res) => {
    if (!ok(req, res, req.params.id, 'configurar')) return;
    try { res.json(aplicarSegmento(Number(req.params.id), req.body?.segmento)); } catch (e) { res.status(400).json({ erro: e.message }); }
  });

  r.get('/agentes/modelos', (_req, res) => res.json({ modelos: MODELOS_AGENTE, habilidades: HABILIDADES, tons: TONS }));

  // "Seu negócio": perguntas guiadas que viram a base de conhecimento.
  r.put('/tenants/:id/negocio', (req, res) => {
    if (!ok(req, res, req.params.id, 'configurar')) return;
    const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
    const g = req.body?.guiada || {};
    const base = montarBase({ ...t, ...pick(req.body, ['nome', 'segmento', 'cidade', 'site']) }, g);
    const lim = getPlan(t.plano).limite_base_conhecimento;
    if (base.length > lim) return res.status(400).json({ erro: `O texto passou do limite do plano (${base.length.toLocaleString('pt-BR')} de ${lim.toLocaleString('pt-BR')} caracteres). Resuma algumas respostas.` });
    db.prepare('UPDATE tenants SET base_guiada = ?, base_conhecimento = ? WHERE id = ?').run(JSON.stringify(g), base, t.id);
    res.json({ ok: true, base_conhecimento: base, caracteres: base.length, limite: lim });
  });

  r.get('/tenants/:id/agents', (req, res) => {
    if (!ok(req, res, req.params.id)) return;
    const nums = db.prepare('SELECT id, nome, agent_id FROM whatsapp_numbers WHERE tenant_id = ?').all(req.params.id);
    res.json(db.prepare('SELECT * FROM agents WHERE tenant_id = ? ORDER BY padrao DESC, id').all(req.params.id)
      .map((a) => ({ ...a, habilidades: habs(a), numeros: nums.filter((n) => n.agent_id === a.id).map((n) => n.nome) })));
  });
  r.post('/tenants/:id/agents', (req, res) => {
    if (!ok(req, res, req.params.id, 'configurar')) return;
    const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
    const lim = getPlan(t.plano).agentes;
    if (db.prepare('SELECT COUNT(*) n FROM agents WHERE tenant_id = ? AND ativo = 1').get(t.id).n >= lim)
      return res.status(400).json({ erro: `O plano ${getPlan(t.plano).nome} permite ${lim} agente(s).` });
    const b = req.body || {};
    const m = MODELOS_AGENTE[b.modelo] || MODELOS_AGENTE.recepcao;
    const erro = validarHabs(t, b.habilidades || m.habilidades); if (erro) return res.status(400).json({ erro });
    res.status(201).json(criarAgente(t.id, b));
  });
  r.put('/agents/:id', (req, res) => {
    const a = getAgente(req.params.id); if (!a) return res.sendStatus(404);
    if (!ok(req, res, a.tenant_id, 'configurar')) return;
    const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(a.tenant_id);
    const b = req.body || {};
    if (b.habilidades) { const erro = validarHabs(t, b.habilidades); if (erro) return res.status(400).json({ erro }); }
    if (b.modelo_ia && !['padrao', 'avancado'].includes(b.modelo_ia)) return res.status(400).json({ erro: 'Modelo inválido' });
    if (b.ativo === 1 && !a.ativo && db.prepare('SELECT COUNT(*) n FROM agents WHERE tenant_id = ? AND ativo = 1').get(t.id).n >= getPlan(t.plano).agentes)
      return res.status(400).json({ erro: 'Limite de agentes do plano atingido' });
    if (b.tom && !TONS[b.tom]) return res.status(400).json({ erro: 'Tom inválido' });
    const cs = ['nome', 'funcao', 'instrucoes', 'modelo_ia', 'ativo', 'tom'].filter((c) => b[c] !== undefined);
    if (cs.length) db.prepare(`UPDATE agents SET ${cs.map((c) => c + ' = ?').join(', ')} WHERE id = ?`).run(...cs.map((c) => b[c]), a.id);
    if (b.habilidades) db.prepare('UPDATE agents SET habilidades = ? WHERE id = ?').run(JSON.stringify(b.habilidades), a.id);
    if (b.padrao) { db.prepare('UPDATE agents SET padrao = 0 WHERE tenant_id = ?').run(a.tenant_id); db.prepare('UPDATE agents SET padrao = 1 WHERE id = ?').run(a.id); }
    const x = getAgente(a.id); res.json({ ...x, habilidades: habs(x) });
  });
  r.delete('/agents/:id', (req, res) => {
    const a = getAgente(req.params.id); if (!a) return res.sendStatus(404);
    if (!ok(req, res, a.tenant_id, 'configurar')) return;
    if (db.prepare('SELECT COUNT(*) n FROM agents WHERE tenant_id = ?').get(a.tenant_id).n <= 1) return res.status(400).json({ erro: 'A empresa precisa de pelo menos um agente' });
    db.prepare('DELETE FROM agents WHERE id = ?').run(a.id);
    if (a.padrao) db.prepare('UPDATE agents SET padrao = 1 WHERE id = (SELECT id FROM agents WHERE tenant_id = ? ORDER BY id LIMIT 1)').run(a.tenant_id);
    res.json({ ok: true });
  });

  // Números de WhatsApp
  r.get('/tenants/:id/numbers', (req, res) => {
    if (!ok(req, res, req.params.id)) return;
    res.json(db.prepare('SELECT * FROM whatsapp_numbers WHERE tenant_id = ? ORDER BY principal DESC, id').all(req.params.id)
      .map(pubNumero).map((n) => (pode(req.user, 'conexoes') ? n : { ...n, pin: undefined })));
  });
  r.post('/tenants/:id/numbers', async (req, res) => {
    if (!ok(req, res, req.params.id, 'conexoes')) return;
    const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
    const b = req.body || {};
    if (!/^\d{6,}$/.test(String(b.phone_number_id || '').trim())) return res.status(400).json({ erro: 'Informe o Phone Number ID (só números, no painel da Meta)' });
    if (!b.token) return res.status(400).json({ erro: 'Informe o token de acesso permanente' });
    if (db.prepare('SELECT COUNT(*) n FROM whatsapp_numbers WHERE tenant_id = ?').get(t.id).n >= getPlan(t.plano).numeros_whatsapp)
      return res.status(400).json({ erro: `O plano ${getPlan(t.plano).nome} permite ${getPlan(t.plano).numeros_whatsapp} número(s).` });
    if (numeroPorPhoneId(b.phone_number_id.trim())) return res.status(409).json({ erro: 'Este número já está conectado a uma empresa' });
    const primeiro = !principal(t.id);
    const x = db.prepare('INSERT INTO whatsapp_numbers (tenant_id, nome, telefone, phone_number_id, waba_id, token, agent_id, principal) VALUES (?,?,?,?,?,?,?,?)')
      .run(t.id, b.nome || 'Principal', b.telefone || null, b.phone_number_id.trim(), b.waba_id || null, b.token.trim(), b.agent_id || null, primeiro ? 1 : 0);
    const n = db.prepare('SELECT * FROM whatsapp_numbers WHERE id = ?').get(x.lastInsertRowid);
    const teste = await testarWhatsApp(n);
    db.prepare("UPDATE whatsapp_numbers SET status_teste = ?, testado_em = datetime('now'), telefone = COALESCE(telefone, ?) WHERE id = ?")
      .run(teste.ok ? 'ok' : 'erro: ' + teste.msg, teste.telefone?.replace(/\D/g, '') || null, n.id);
    sincronizarPrincipal(t.id);
    res.status(201).json({ ...pubNumero(db.prepare('SELECT * FROM whatsapp_numbers WHERE id = ?').get(n.id)), teste });
  });
  r.put('/numbers/:id', (req, res) => {
    const n = db.prepare('SELECT * FROM whatsapp_numbers WHERE id = ?').get(req.params.id); if (!n) return res.sendStatus(404);
    if (!ok(req, res, n.tenant_id, 'conexoes')) return;
    const b = req.body || {};
    if (b.agent_id && getAgente(b.agent_id)?.tenant_id !== n.tenant_id) return res.status(400).json({ erro: 'Agente inválido' });
    const cs = ['nome', 'telefone', 'waba_id', 'agent_id'].filter((c) => b[c] !== undefined);
    if (b.token) cs.push('token');
    if (cs.length) db.prepare(`UPDATE whatsapp_numbers SET ${cs.map((c) => c + ' = ?').join(', ')} WHERE id = ?`).run(...cs.map((c) => (b[c] === '' ? null : b[c])), n.id);
    if (b.principal) { db.prepare('UPDATE whatsapp_numbers SET principal = 0 WHERE tenant_id = ?').run(n.tenant_id); db.prepare('UPDATE whatsapp_numbers SET principal = 1 WHERE id = ?').run(n.id); }
    sincronizarPrincipal(n.tenant_id);
    res.json(pubNumero(db.prepare('SELECT * FROM whatsapp_numbers WHERE id = ?').get(n.id)));
  });
  r.post('/numbers/:id/testar', async (req, res) => {
    const n = db.prepare('SELECT * FROM whatsapp_numbers WHERE id = ?').get(req.params.id); if (!n) return res.sendStatus(404);
    if (!ok(req, res, n.tenant_id, 'conexoes')) return;
    const teste = await testarWhatsApp(n);
    db.prepare("UPDATE whatsapp_numbers SET status_teste = ?, testado_em = datetime('now') WHERE id = ?").run(teste.ok ? 'ok' : 'erro: ' + teste.msg, n.id);
    res.json(teste);
  });
  r.delete('/numbers/:id', (req, res) => {
    const n = db.prepare('SELECT * FROM whatsapp_numbers WHERE id = ?').get(req.params.id); if (!n) return res.sendStatus(404);
    if (!ok(req, res, n.tenant_id, 'conexoes')) return;
    db.prepare('DELETE FROM whatsapp_numbers WHERE id = ?').run(n.id);
    if (n.principal) db.prepare('UPDATE whatsapp_numbers SET principal = 1 WHERE id = (SELECT id FROM whatsapp_numbers WHERE tenant_id = ? ORDER BY id LIMIT 1)').run(n.tenant_id);
    sincronizarPrincipal(n.tenant_id);
    res.json({ ok: true });
  });

  // Conexões (visão geral + Asaas + modelos Meta + e-mail)
  r.get('/tenants/:id/conexoes', (req, res) => {
    if (!ok(req, res, req.params.id)) return;
    const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
    const nums = db.prepare('SELECT * FROM whatsapp_numbers WHERE tenant_id = ?').all(t.id);
    res.json({
      whatsapp: { numeros: nums.length, ok: nums.filter((x) => x.status_teste === 'ok').length, webhook: `${publicUrl()}/webhooks/whatsapp`,
        verify_token_configurado: !!process.env.WA_VERIFY_TOKEN, template_followup: t.wa_template_followup, template_reengajar: t.wa_template_reengajar },
      asaas: { configurado: !!t.asaas_api_key, usa_conta_avantte: !t.asaas_api_key && !!process.env.ASAAS_API_KEY && t.id === Number(process.env.ASAAS_TENANT_ID || 1),
        webhook: `${publicUrl()}/webhooks/asaas`, webhook_token: t.asaas_webhook_token || '' },
      email: { modo: EMAIL_MODE, remetente: process.env.EMAIL_FROM || 'contato@grupoavantte.com.br', nome: t.email_remetente_nome || t.nome, resposta: t.email_resposta || '' },
      ia: { modo: process.env.ANTHROPIC_API_KEY ? 'claude' : 'demo', avancado_no_plano: getPlan(t.plano).modelo_avancado },
    });
  });
  r.put('/tenants/:id/conexoes', async (req, res) => {
    if (!ok(req, res, req.params.id, 'conexoes')) return;
    const b = req.body || {};
    const cs = ['asaas_webhook_token', 'wa_template_followup', 'wa_template_reengajar', 'email_remetente_nome', 'email_resposta'].filter((c) => b[c] !== undefined);
    if (b.asaas_api_key) cs.push('asaas_api_key');
    if (b.remover_asaas) { db.prepare('UPDATE tenants SET asaas_api_key = NULL WHERE id = ?').run(req.params.id); }
    if (cs.length) db.prepare(`UPDATE tenants SET ${cs.map((c) => c + ' = ?').join(', ')} WHERE id = ?`).run(...cs.map((c) => (b[c] === '' ? null : String(b[c]).trim())), req.params.id);
    let teste = null;
    if (b.asaas_api_key) teste = await testarAsaas(b.asaas_api_key.trim());
    res.json({ ok: true, teste_asaas: teste });
  });
  r.post('/tenants/:id/conexoes/asaas/testar', async (req, res) => {
    if (!ok(req, res, req.params.id, 'conexoes')) return;
    const t = db.prepare('SELECT asaas_api_key, id FROM tenants WHERE id = ?').get(req.params.id);
    res.json(await testarAsaas(t.asaas_api_key || (t.id === Number(process.env.ASAAS_TENANT_ID || 1) ? process.env.ASAAS_API_KEY : null)));
  });

  r.get('/tenants/:id/implantacao', (req, res) => { if (!ok(req, res, req.params.id)) return; res.json(implantacao(req.params.id)); });
  return r;
}

// ---------- Passagem entre agentes (ex.: AVA Recepção → AVA Loja) ----------
export function outrosAgentes(t) {
  if (!t._agent_id) return [];
  return db.prepare('SELECT id, nome, funcao FROM agents WHERE tenant_id = ? AND ativo = 1 AND id != ?').all(t.id, t._agent_id);
}
export function ferramentaPassagem(t) {
  const outros = outrosAgentes(t);
  if (!outros.length) return [];
  return [{ name: 'passar_para_agente', description: 'Passa a conversa para outro agente da empresa mais adequado ao pedido do cliente (ex.: para a vendedora da loja ou para o pós-venda). O outro agente responde em seguida.',
    input_schema: { type: 'object', properties: { agente_id: { type: 'number', enum: outros.map((a) => a.id) }, motivo: { type: 'string', description: 'Resumo do que o cliente quer' } }, required: ['agente_id', 'motivo'] } }];
}
export function promptPassagem(t) {
  const outros = outrosAgentes(t);
  return outros.length ? `\nOutros agentes da empresa (passe a conversa com passar_para_agente quando o pedido for da área deles, sem anunciar transferência com formalidade):\n${outros.map((a) => `- [${a.id}] ${a.nome}: ${a.funcao}`).join('\n')}` : '';
}
