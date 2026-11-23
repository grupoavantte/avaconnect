import { operacaoRouter, encerrar, assumir, filtroConversas, podeVerConversa } from './operacao.js';
import { modelosRouter } from './modelos.js';
import { rotasGateways, recebimentoRouter } from './gateways.js';
import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, newToken, getUsage, currentMonth, publicTenant } from './db.js';
import { PLANS, getPlan , MESES_PAGOS_ANUAL, cicloValido, GARANTIA_DIAS } from './plans.js';
import { handleIncoming, humanReply } from './engine.js';
import { parseWebhook, validSignature } from './whatsapp.js';
import { AI_MODE } from './ai.js';
import { PAY_MODE, lerWebhookAsaas, SIMULADO_LIBERADO } from './payments.js';
import { confirmarPagamento, iniciarAgendador, rodarJobs, HANDLERS } from './funil.js';
import { VENDAS_HANDLERS, rotasPublicas, vendasRouter, getCobranca, confirmarPagamentoCobranca, cobrancaVencida, paginaPagamentoTesteCobranca } from './vendas.js';
import { EMAIL_MODE } from './email.js';
import { autenticar, exigir, pode, rotasAuth, usuariosRouter, convidarUsuario, PAPEIS } from './auth.js';
import { agentesRouter, numeroPorPhoneId, criarAgente, MODELOS_AGENTE, implantacao, aplicarSegmento } from './agents.js';
import { listaSegmentos } from './segmentos.js';
import { rotasPublicasLoja, lojaRouter } from './loja.js';
import { metaRouter } from './meta.js';
import { garantirAvantte } from './seed.js';
import { rotasSeo } from './seo.js';
import { rotasCanais, canaisRouter } from './canais.js';
import { rotasArquivos, arquivosRouter } from './arquivos.js';
import { fichaRouter } from './ficha.js';
import { rotasCadastro, eventoAssinatura, situacaoConta } from './cadastro.js';

Object.assign(HANDLERS, VENDAS_HANDLERS);
import { paginaRelatorio, paginaPagamentoTeste } from './report.js';
import { crmRouter } from './crm.js';
import { BRAND } from './brand-assets.js';

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'troque-este-token';
if (!process.env.ADMIN_TOKEN) console.warn('[aviso] ADMIN_TOKEN não definido — usando token padrão de desenvolvimento.');

app.use(express.json({ limit: '4mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.get('/brand/:file', (req, res, next) => {
  const data = BRAND[req.params.file];
  if (!data) return next(); // demais imagens da marca saem de public/brand
  res.type(req.params.file.split('.').pop()).set('cache-control', 'public, max-age=86400').send(Buffer.from(data, 'base64'));
});
// Site público na raiz; login em /entrar; painel em /app.
rotasSeo(app);       // / (site com dados estruturados), /robots.txt, /sitemap.xml, /llms.txt
rotasCanais(app);    // /w/TOKEN.js (chat no site), /f/TOKEN (formulários), /inbound/email/TOKEN
rotasArquivos(app);  // /a/TOKEN/nome — arquivos da biblioteca (fotos, PDFs, vídeos) enviados pela IA
app.get(['/entrar', '/app', '/app/*'], (_req, res) => res.sendFile(path.resolve('public/index.html')));
app.get('/cadastro', (_req, res) => res.sendFile(path.resolve('public/cadastro.html')));
app.get('/termos', (_req, res) => res.sendFile(path.resolve('public/termos.html')));
app.get('/privacidade', (_req, res) => res.sendFile(path.resolve('public/privacidade.html')));
rotasCadastro(app, express);
rotasPublicasLoja(app); // /loja/:slug (vitrine) e /img/p/:id (fotos dos produtos)
rotasGateways(app);     // /webhooks/mercadopago|pagarme/:tid e /pix/:token
app.use(express.static(path.resolve('public'), { index: false }));

// Dados públicos do site (planos e contato comercial da Avantte).
app.get('/api/public/site', (_req, res) => {
  const avt = db.prepare("SELECT id FROM tenants WHERE nome LIKE 'Avantte%' COLLATE NOCASE ORDER BY id LIMIT 1").get();
  const num = avt && db.prepare('SELECT telefone FROM whatsapp_numbers WHERE tenant_id = ? AND telefone IS NOT NULL ORDER BY principal DESC, id LIMIT 1').get(avt.id);
  const tel = (process.env.SITE_WHATSAPP || num?.telefone || '').replace(/\D/g, '');
  res.set('cache-control', 'public, max-age=300').json({
    whatsapp: tel ? `https://wa.me/${tel}?text=${encodeURIComponent('Olá! Quero conhecer o AVA Connect.')}` : null,
    email: 'contato@grupoavantte.com.br',
    meses_pagos_anual: MESES_PAGOS_ANUAL(), garantia_dias: GARANTIA_DIAS(),
    planos: Object.values(PLANS).map((p) => ({ id: p.id, nome: p.nome, preco_mensal: p.preco_mensal, preco_anual: p.preco_anual, implantacao: p.implantacao, conversas_mes: p.conversas_mes,
      agentes: p.agentes, numeros_whatsapp: p.numeros_whatsapp, usuarios_painel: p.usuarios_painel, vendas: p.vendas, modelo_avancado: p.modelo_avancado })),
  });
});

app.get('/api/public/segmentos', (_req, res) => res.set('cache-control', 'public, max-age=300').json(listaSegmentos()));

app.get('/health', (_req, res) => res.json({ ok: true, ia: AI_MODE, pagamentos: PAY_MODE, email: EMAIL_MODE }));
app.use(express.urlencoded({ extended: false }));
rotasPublicas(app); // /proposta/:token, /proposta/:token/aceitar, /obrigado/:token
rotasAuth(app);     // /api/auth/login, /api/auth/esqueci, /convite/:token

// ---------------- Diagnóstico: relatório, pagamento e webhook ----------------
const diagByToken = (t) => db.prepare('SELECT * FROM diagnostics WHERE token = ?').get(String(t || ''));

app.get('/relatorio/:token', (req, res) => {
  const d = diagByToken(req.params.token);
  if (!d) return res.status(404).send('Relatório não encontrado.');
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(d.tenant_id);
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(d.contact_id);
  res.set('cache-control', 'no-store').send(paginaRelatorio(d, tenant, contact));
});

app.get('/pagar/:token', (req, res) => {
  const c = getCobranca(req.params.token);
  if (c) return PAY_MODE === 'teste' || !c.pagamento_url?.startsWith('http') || c.pagamento_url.includes('/pagar/')
    ? res.send(paginaPagamentoTesteCobranca(c)) : res.redirect(c.pagamento_url);
  const d = diagByToken(req.params.token);
  if (!d) return res.status(404).send('Cobrança não encontrada.');
  if (PAY_MODE !== 'teste') return d.pagamento_url ? res.redirect(d.pagamento_url) : res.status(404).send('Link indisponível.');
  res.send(paginaPagamentoTeste(d));
});

app.post('/pagar/:token/simular', async (req, res) => {
  const c = getCobranca(req.params.token);
  if (c) {
    if (!c.pagamento_ref?.startsWith('teste-') || !SIMULADO_LIBERADO) return res.sendStatus(404);
    await confirmarPagamentoCobranca(c);
    return res.redirect(`/obrigado/${c.token}`);
  }
  if (PAY_MODE !== 'teste' || !SIMULADO_LIBERADO) return res.sendStatus(404);
  const d = diagByToken(req.params.token);
  if (!d) return res.sendStatus(404);
  await confirmarPagamento(d);
  res.redirect(`/relatorio/${d.token}`);
});

app.post('/webhooks/asaas', async (req, res) => {
  // Mensalidade de cliente do AVA Connect (assinatura na conta Avantte).
  if (req.body?.payment?.subscription && db.prepare('SELECT 1 FROM tenants WHERE asaas_subscription_id = ?').get(req.body.payment.subscription)) {
    const ev = lerWebhookAsaas(req);
    if (ev?.recusado) return res.sendStatus(401);
    res.json({ received: true });
    if (ev) eventoAssinatura(ev, req.body.payment).catch((e) => console.error('[asaas] assinatura', e));
    return;
  }
  // Cobrança de venda (de qualquer empresa): valida com o token global ou o da empresa dona.
  const ref = req.body?.payment?.externalReference;
  const charge = ref && getCobranca(ref);
  if (charge) {
    const tenant = db.prepare('SELECT asaas_webhook_token FROM tenants WHERE id = ?').get(charge.tenant_id);
    const ev = lerWebhookAsaas(req, [process.env.ASAAS_WEBHOOK_TOKEN, tenant?.asaas_webhook_token]);
    if (ev?.recusado) return res.sendStatus(401);
    res.json({ received: true });
    if (ev?.pago) confirmarPagamentoCobranca(charge).catch((e) => console.error('[asaas] venda', e));
    else if (ev?.vencido) cobrancaVencida(charge).catch((e) => console.error('[asaas] vencida', e));
    return;
  }
  const ev = lerWebhookAsaas(req);
  if (ev?.recusado) return res.sendStatus(401);
  res.json({ received: true });
  if (!ev?.pago) return;
  const d = (ev.externalReference && diagByToken(ev.externalReference))
    || (ev.ref && db.prepare('SELECT * FROM diagnostics WHERE pagamento_ref = ?').get(ev.ref));
  if (!d) return console.warn('[asaas] pagamento sem diagnóstico correspondente', ev.id);
  confirmarPagamento(d).catch((e) => console.error('[asaas] erro ao confirmar', e));
});

// ---------------- Webhook WhatsApp ----------------
app.get('/webhooks/whatsapp', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.WA_VERIFY_TOKEN) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

app.post('/webhooks/whatsapp', (req, res) => {
  if (!validSignature(req.rawBody || Buffer.from(''), req.get('x-hub-signature-256'))) return res.sendStatus(401);
  res.sendStatus(200); // responde rápido; processa em seguida
  for (const m of parseWebhook(req.body)) {
    const num = numeroPorPhoneId(m.phoneNumberId);
    const tenant = num ? db.prepare('SELECT * FROM tenants WHERE id = ?').get(num.tenant_id)
      : db.prepare('SELECT * FROM tenants WHERE wa_phone_number_id = ?').get(m.phoneNumberId);
    if (!tenant) { console.warn('[webhook] número sem empresa:', m.phoneNumberId); continue; }
    handleIncoming(tenant, { telefone: m.from, nome: m.nome, texto: m.texto, waId: m.waId, canal: 'whatsapp', phoneNumberId: m.phoneNumberId, entrada: m })
      .catch((e) => console.error('[webhook] erro', e));
  }
});

// ---------------- Autenticação do painel ----------------
// Plataforma (ADMIN_TOKEN ou usuário 'plataforma') vê todas as empresas; os demais só a própria, conforme o papel.
const auth = autenticar(ADMIN_TOKEN);
const adminOnly = (req, res, next) => (req.user.admin ? next() : res.status(403).json({ erro: 'Apenas administrador' }));
const canSee = (req, tenantId) => req.user.admin || req.user.tenantId === Number(tenantId);

const api = express.Router();
api.use(auth);

api.get('/me', (req, res) => res.json({ ...req.user, ia: AI_MODE, papel_nome: PAPEIS[req.user.papel],
  pode: Object.fromEntries(['ver', 'atender', 'configurar', 'vender', 'aprovar', 'usuarios', 'conexoes'].map((a) => [a, pode(req.user, a)])) }));
api.get('/plans', (_req, res) => res.json(Object.values(PLANS)));

api.get('/overview', (req, res) => {
  const where = req.user.admin ? '' : 'WHERE t.id = ' + Number(req.user.tenantId);
  const tenants = db.prepare(`SELECT t.* FROM tenants t ${where}`).all();
  const ativos = tenants.filter((t) => t.status === 'ativo');
  const mes = currentMonth();
  const ids = tenants.map((t) => t.id).join(',') || '0';
  const uso = db.prepare(`SELECT COALESCE(SUM(conversas),0) c, COALESCE(SUM(mensagens_ia),0) m FROM usage WHERE mes = ? AND tenant_id IN (${ids})`).get(mes);
  const leads = db.prepare(`SELECT etapa, COUNT(*) n, COALESCE(SUM(valor_estimado),0) v FROM leads WHERE tenant_id IN (${ids}) GROUP BY etapa`).all();
  const humanos = db.prepare(`SELECT COUNT(*) n FROM conversations WHERE status = 'humano' AND tenant_id IN (${ids})`).get().n;
  res.json({
    empresas_ativas: ativos.length,
    mrr: req.user.admin ? Math.round(ativos.reduce((s, t) => s + (cicloValido(t.ciclo) === 'anual' ? getPlan(t.plano).preco_anual / 12 : getPlan(t.plano).preco_mensal), 0)) : undefined,
    conversas_mes: uso.c,
    mensagens_ia_mes: uso.m,
    aguardando_humano: humanos,
    leads,
  });
});

// Empresas
api.get('/tenants', (req, res) => {
  const rows = req.user.admin
    ? db.prepare('SELECT * FROM tenants ORDER BY id DESC').all()
    : db.prepare('SELECT * FROM tenants WHERE id = ?').all(req.user.tenantId);
  res.json(rows.map((t) => ({ ...publicTenant(t), uso: getUsage(t.id), limite: getPlan(t.plano).conversas_mes })));
});

const EDITABLE = ['nome', 'plano', 'status', 'nome_assistente', 'persona', 'base_conhecimento', 'horario_atendimento',
  'telefone_responsavel', 'wa_phone_number_id', 'wa_token'];
const ADMIN_FIELDS = ['plano', 'status', 'wa_phone_number_id', 'wa_token', 'diagnostico_ativo', 'diagnostico_preco', 'wa_template_followup',
  'asaas_api_key', 'asaas_webhook_token', 'wa_template_reengajar'];
EDITABLE.push('diagnostico_ativo', 'diagnostico_preco', 'link_agendamento', 'consultoria_descricao', 'wa_template_followup');
// Agente de vendas
EDITABLE.push('vendas_ativo', 'desconto_max', 'desconto_avista', 'parcelas_max', 'validade_proposta_dias', 'condicoes_pagamento', 'frete_info',
  'pos_venda_mensagem', 'email_remetente_nome', 'email_resposta', 'agenda_dias', 'agenda_inicio', 'agenda_fim', 'reuniao_minutos', 'reuniao_local',
  'cadencia_ativa', 'wa_template_reengajar', 'asaas_api_key', 'asaas_webhook_token');
EDITABLE.push('segmento', 'cidade', 'site', 'onboarding_concluido');
const NUMERICOS = ['desconto_max', 'desconto_avista', 'parcelas_max', 'validade_proposta_dias', 'reuniao_minutos'];

function validateTenant(body, plano) {
  if (body.plano && !PLANS[body.plano]) return 'Plano inválido';
  if (body.status && !['ativo', 'pausado', 'cancelado', 'pendente'].includes(body.status)) return 'Status inválido';
  for (const f of NUMERICOS) if (body[f] !== undefined && body[f] !== '' && !(Number(body[f]) >= 0)) return `Valor inválido em ${f}`;
  if (body.desconto_max !== undefined && Number(body.desconto_max) > 50) return 'Desconto máximo da IA acima de 50%';
  for (const f of ['agenda_inicio', 'agenda_fim']) if (body[f] && !/^\d{2}:\d{2}$/.test(body[f])) return 'Horário da agenda no formato HH:MM';
  if (body.base_conhecimento && body.base_conhecimento.length > getPlan(body.plano || plano).limite_base_conhecimento)
    return `Base de conhecimento acima do limite do plano (${getPlan(body.plano || plano).limite_base_conhecimento} caracteres)`;
  return null;
}

api.post('/tenants', adminOnly, (req, res) => {
  const b = req.body || {};
  if (!b.nome) return res.status(400).json({ erro: 'Nome obrigatório' });
  const erro = validateTenant(b, b.plano); if (erro) return res.status(400).json({ erro });
  const fields = EDITABLE.filter((f) => b[f] !== undefined && b[f] !== '');
  const r = db.prepare(`INSERT INTO tenants (${[...fields, 'painel_token'].join(',')}) VALUES (${[...fields, 'x'].map(() => '?').join(',')})`)
    .run(...fields.map((f) => (typeof b[f] === 'boolean' ? Number(b[f]) : b[f])), newToken());
  res.status(201).json(publicTenant(db.prepare('SELECT * FROM tenants WHERE id = ?').get(r.lastInsertRowid), { withSecrets: true }));
});

api.get('/tenants/:id', (req, res) => {
  if (!canSee(req, req.params.id)) return res.sendStatus(403);
  const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
  if (!t) return res.sendStatus(404);
  res.json({ ...publicTenant(t, { withSecrets: req.user.admin }), uso: getUsage(t.id), plano_info: getPlan(t.plano) });
});

api.put('/tenants/:id', (req, res) => {
  if (!canSee(req, req.params.id)) return res.sendStatus(403);
  if (!pode(req.user, 'configurar')) return res.status(403).json({ erro: 'Sem permissão para alterar a configuração' });
  const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
  if (!t) return res.sendStatus(404);
  const b = req.body || {};
  const NAO_NULOS = [...NUMERICOS, 'agenda_dias', 'agenda_inicio', 'agenda_fim', 'vendas_ativo', 'cadencia_ativa', 'onboarding_concluido'];
  const allowed = EDITABLE.filter((f) => b[f] !== undefined && (req.user.admin || !ADMIN_FIELDS.includes(f)) && !(b[f] === '' && NAO_NULOS.includes(f)));
  const erro = validateTenant(b, t.plano); if (erro) return res.status(400).json({ erro });
  if (allowed.length) {
    db.prepare(`UPDATE tenants SET ${allowed.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`)
      .run(...allowed.map((f) => (b[f] === '' ? null : typeof b[f] === 'boolean' ? Number(b[f]) : NUMERICOS.includes(f) ? Number(b[f]) : b[f])), t.id);
  }
  res.json(publicTenant(db.prepare('SELECT * FROM tenants WHERE id = ?').get(t.id), { withSecrets: req.user.admin }));
});

// Plataforma: cadastro completo de empresa cliente (empresa + dono convidado + agentes iniciais).
api.post('/plataforma/empresas', adminOnly, (req, res) => {
  const b = req.body || {};
  if (!b.nome) return res.status(400).json({ erro: 'Informe o nome da empresa' });
  if (b.plano && !PLANS[b.plano]) return res.status(400).json({ erro: 'Plano inválido' });
  if (b.dono_email && db.prepare('SELECT 1 FROM users WHERE email = ?').get(String(b.dono_email).trim().toLowerCase()))
    return res.status(409).json({ erro: 'Este e-mail já tem acesso ao AVA Connect' });
  const r = db.prepare('INSERT INTO tenants (nome, plano, telefone_responsavel, horario_atendimento, painel_token, ciclo) VALUES (?, ?, ?, ?, ?, ?)')
    .run(b.nome, b.plano || 'essencial', b.dono_telefone || null, b.horario_atendimento || 'Segunda a sexta, 8h às 18h', newToken(), cicloValido(b.ciclo));
  const tid = r.lastInsertRowid;
  const plano = getPlan(b.plano);
  const modelos = (Array.isArray(b.agentes) && b.agentes.length ? b.agentes : ['recepcao']).filter((m) => MODELOS_AGENTE[m])
    .map((m) => (m === 'vendas' && !plano.vendas ? 'recepcao' : m)).filter((m, i, arr) => arr.indexOf(m) === i).slice(0, plano.agentes);
  modelos.forEach((m, i) => criarAgente(tid, { modelo: m, nome: i === 0 ? (b.nome_assistente || 'AVA') : `${b.nome_assistente || 'AVA'} ${MODELOS_AGENTE[m].nome}` }));
  if (modelos.includes('vendas')) db.prepare('UPDATE tenants SET vendas_ativo = 1 WHERE id = ?').run(tid);
  if (b.segmento) { try { aplicarSegmento(tid, b.segmento); } catch {} }
  let convite = null;
  if (b.dono_nome && b.dono_email) convite = convidarUsuario({ tenant_id: tid, nome: b.dono_nome, email: b.dono_email, telefone: b.dono_telefone || null, papel: 'dono' }).link;
  res.status(201).json({ ...publicTenant(db.prepare('SELECT * FROM tenants WHERE id = ?').get(tid), { withSecrets: true }), link_convite_dono: convite });
});

// Plataforma: usuários da Avantte que administram todas as empresas.
api.get('/plataforma/usuarios', adminOnly, (_req, res) => res.json(db.prepare("SELECT id, nome, email, telefone, ativo, ultimo_login, senha_hash IS NULL pendente FROM users WHERE papel = 'plataforma' ORDER BY nome").all()));
api.post('/plataforma/usuarios', adminOnly, (req, res) => {
  const b = req.body || {};
  if (!b.nome || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email || '')) return res.status(400).json({ erro: 'Informe nome e e-mail válidos' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(b.email.trim().toLowerCase())) return res.status(409).json({ erro: 'E-mail já cadastrado' });
  res.status(201).json({ link_convite: convidarUsuario({ nome: b.nome, email: b.email, telefone: b.telefone || null, papel: 'plataforma' }).link });
});

api.post('/tenants/:id/rotate-token', adminOnly, (req, res) => {
  db.prepare('UPDATE tenants SET painel_token = ? WHERE id = ?').run(newToken(), req.params.id);
  res.json(publicTenant(db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id), { withSecrets: true }));
});

// Conversas
api.get('/tenants/:id/situacao', (req, res) => { if (!canSee(req, req.params.id)) return res.sendStatus(403); res.json(situacaoConta(req.params.id)); });

api.get('/tenants/:id/conversations', (req, res) => {
  if (!canSee(req, req.params.id)) return res.sendStatus(403);
  const status = req.query.status;
  // Filtros da caixa de entrada: minhas | fila (com humano e sem atendente) | ia | humano | encerrada
  const f = String(req.query.filtro || '');
  const extra = { minhas: "AND c.atendente_id = ? AND c.status != 'encerrada'", fila: "AND c.status = 'humano' AND c.atendente_id IS NULL",
    ia: "AND c.status = 'ia'", humano: "AND c.status = 'humano'", encerrada: "AND c.status = 'encerrada'" }[f] || '';
  const vis = filtroConversas(req.user);
  const args = [req.params.id, ...(status ? [status] : []), ...(f === 'minhas' ? [req.user.userId || -1] : []), ...vis.args];
  const rows = db.prepare(`SELECT c.*, ct.nome contato_nome, ct.telefone, u.nome atendente_nome,
      (SELECT conteudo FROM messages m WHERE m.conversation_id = c.id ORDER BY id DESC LIMIT 1) ultima_mensagem
    FROM conversations c JOIN contacts ct ON ct.id = c.contact_id LEFT JOIN users u ON u.id = c.atendente_id
    WHERE c.tenant_id = ? ${status ? 'AND c.status = ?' : ''} ${extra} ${vis.sql}
    ORDER BY c.ultima_mensagem_em DESC, c.id DESC LIMIT 200`).all(...args);
  res.json(rows);
});

function loadConv(req, res) {
  const c = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!c) { res.sendStatus(404); return null; }
  if (!canSee(req, c.tenant_id) || !podeVerConversa(req.user, c)) { res.sendStatus(403); return null; }
  return c;
}

api.get('/conversations/:id', (req, res) => {
  const c = loadConv(req, res); if (!c) return;
  const contato = db.prepare('SELECT * FROM contacts WHERE id = ?').get(c.contact_id);
  const mensagens = db.prepare('SELECT id, autor, conteudo, criado_em FROM messages WHERE conversation_id = ? ORDER BY id').all(c.id);
  const lead = db.prepare('SELECT * FROM leads WHERE contact_id = ?').get(c.contact_id);
  const atendente = c.atendente_id ? db.prepare('SELECT id, nome FROM users WHERE id = ?').get(c.atendente_id) : null;
  const responsavel = contato.responsavel_id ? db.prepare('SELECT id, nome FROM users WHERE id = ?').get(contato.responsavel_id) : null;
  res.json({ ...c, contato, mensagens, lead, atendente, responsavel, eu: req.user.userId || null });
});

api.post('/conversations/:id/reply', async (req, res) => {
  const c = loadConv(req, res); if (!c) return;
  if (!pode(req.user, 'atender')) return res.sendStatus(403);
  const texto = String(req.body?.texto || '').trim();
  if (!texto) return res.status(400).json({ erro: 'Texto vazio' });
  await humanReply(c, texto, req.user.userId || null);
  res.json({ ok: true });
});

api.post('/conversations/:id/status', (req, res) => {
  const c = loadConv(req, res); if (!c) return;
  const s = req.body?.status;
  if (!['ia', 'humano', 'encerrada'].includes(s)) return res.status(400).json({ erro: 'Status inválido' });
  if (s === 'encerrada') return encerrar(c, { pesquisa: req.body?.pesquisa !== false }).then((r) => res.json({ ok: true, ...r }));
  if (s === 'humano') assumir(c, req.user.userId || null);
  else db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run(s, c.id);
  res.json({ ok: true });
});

// CRM (leads, funil, atividades, tarefas, métricas, exportação)
api.use(crmRouter(canSee));
// Vendas (catálogo, propostas, cobranças, agenda, indicadores)
api.use(['/tenants/:id/products', '/products/:id'], (req, res, next) => (req.method === 'GET' || pode(req.user, 'configurar') ? next() : res.status(403).json({ erro: 'Sem permissão' })));
api.use('/proposals/:id/aprovar', exigir('aprovar'));
api.use('/charges/:id/confirmar', exigir('vender'));
api.use(vendasRouter(canSee, adminOnly));
// Usuários, agentes, números de WhatsApp e conexões
api.use(usuariosRouter(canSee));
api.use(agentesRouter(canSee));
api.use(operacaoRouter(canSee));
api.use(canaisRouter(canSee));
api.use(arquivosRouter(canSee));
api.use(fichaRouter(canSee));
api.use(modelosRouter(canSee));
api.use(recebimentoRouter(canSee));
api.use(lojaRouter(canSee));
api.use(metaRouter(canSee));

// Simulador: testa a IA sem WhatsApp
api.post('/tenants/:id/simulate', async (req, res) => {
  if (!canSee(req, req.params.id)) return res.sendStatus(403);
  const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
  if (!t) return res.sendStatus(404);
  const texto = String(req.body?.texto || '').trim();
  if (!texto) return res.status(400).json({ erro: 'Texto vazio' });
  const r = await handleIncoming(t, { telefone: req.body?.telefone || 'simulador', nome: req.body?.nome || 'Teste', texto, canal: 'simulador', agentId: req.body?.agent_id || null });
  res.json(r);
});

// Diagnósticos da empresa
api.get('/tenants/:id/diagnosticos', (req, res) => {
  if (!canSee(req, req.params.id)) return res.sendStatus(403);
  res.json(db.prepare(`SELECT d.id, d.status, d.etapa, d.nota_geral, d.valor, d.token, d.pagamento_url, d.criado_em, d.pago_em,
      ct.nome contato_nome, ct.telefone, d.conversation_id
    FROM diagnostics d JOIN contacts ct ON ct.id = d.contact_id WHERE d.tenant_id = ? ORDER BY d.id DESC LIMIT 300`).all(req.params.id));
});
api.post('/diagnosticos/:id/confirmar-pagamento', adminOnly, async (req, res) => {
  const d = db.prepare('SELECT * FROM diagnostics WHERE id = ?').get(req.params.id);
  if (!d) return res.sendStatus(404);
  res.json(await confirmarPagamento(d));
});
api.post('/jobs/rodar', adminOnly, async (_req, res) => res.json({ executados: await rodarJobs() }));

app.use('/api', api);
app.get('*', (_req, res) => res.sendFile(path.resolve('public/index.html')));

garantirAvantte();
iniciarAgendador();
app.listen(PORT, () => console.log(`AVA Connect rodando na porta ${PORT} — IA: ${AI_MODE} — pagamentos: ${PAY_MODE}`));
