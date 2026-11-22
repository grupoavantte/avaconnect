import { avisarEquipe } from './modelos.js';
// Cadastro pelo site (self-service), ativação automática no pagamento e assinatura mensal no Asaas.
import crypto from 'node:crypto';
import { db, newToken, logActivity } from './db.js';
import { PLANS, getPlan, cicloValido, cicloOferecido, valorCiclo, CICLOS, GARANTIA_DIAS } from './plans.js';
import { hashSenha, novaSessao, telefonesAprovadores } from './auth.js';
import { criarAgente, aplicarSegmento } from './agents.js';
import { criarCobranca, asaas, chaveAsaas, modoPagamento, publicUrl } from './payments.js';
import { agendarEm, garantirLead } from './vendas.js';
import { aoConfirmarPagamento, HANDLERS, periodicas } from './ganchos.js';
import { sendText } from './whatsapp.js';
import { sendEmail } from './email.js';

// ---------- Banco ----------
const tCols = db.prepare('PRAGMA table_info(tenants)').all().map((c) => c.name);
for (const [col, def] of [
  ['cpf_cnpj', 'TEXT'], ['origem', "TEXT NOT NULL DEFAULT 'avantte'"], ['ativado_em', 'TEXT'],
  ['asaas_customer_id', 'TEXT'], ['asaas_subscription_id', 'TEXT'],
  ['cobranca_status', "TEXT NOT NULL DEFAULT 'em_dia'"],   // em_dia | atrasada | suspensa
  ['proximo_vencimento', 'TEXT'],
  ['ciclo', "TEXT NOT NULL DEFAULT 'mensal'"],   // contrato (12x) | anual (à vista) | mensal (legado)
  ['contrato_fim', 'TEXT'],
  ['fatura_aberta_url', 'TEXT'],                  // link da parcela em atraso (mostrado na tela de bloqueio)
  ['atraso_desde', 'TEXT'],                       // vencimento da parcela em atraso mais antiga                       // fim do período de 12 meses em vigor (renova automaticamente)
]) if (!tCols.includes(col)) db.exec(`ALTER TABLE tenants ADD COLUMN ${col} ${def}`);
const cCols = db.prepare('PRAGMA table_info(charges)').all().map((c) => c.name);
if (!cCols.includes('signup_tenant_id')) db.exec('ALTER TABLE charges ADD COLUMN signup_tenant_id INTEGER');

/** Dias depois do vencimento sem pagamento identificado até bloquear o sistema. */
export const DIAS_TOLERANCIA = () => Number(process.env.INADIMPLENCIA_DIAS ?? 10);
const avantte = () => db.prepare("SELECT * FROM tenants WHERE nome LIKE 'Avantte%' COLLATE NOCASE ORDER BY id LIMIT 1").get();
const hojeBR = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const somarDias = (iso, d) => new Date(new Date(iso + 'T12:00:00Z').getTime() + d * 864e5).toISOString().slice(0, 10);
const somarMeses = (iso, m) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + m); return d.toISOString().slice(0, 10); };
const proximoVenc = (iso, ciclo) => somarMeses(iso, CICLOS[cicloValido(ciclo)].meses);
/** Descrição do serviço usada nas cobranças e na nota fiscal. */
export const DESCRICAO_SERVICO = 'Assessoria comercial com inteligência artificial (AVA Connect)';
const nomeCiclo = (c) => ({ contrato: 'contrato 12 meses', anual: 'anual à vista', mensal: 'mensal' }[cicloValido(c)]);

// ---------- Validações ----------
export function cpfValido(c) {
  if (!/^\d{11}$/.test(c) || /^(\d)\1{10}$/.test(c)) return false;
  const dv = (n) => { let s = 0; for (let i = 0; i < n; i++) s += Number(c[i]) * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === Number(c[9]) && dv(10) === Number(c[10]);
}
export function cnpjValido(c) {
  if (!/^\d{14}$/.test(c) || /^(\d)\1{13}$/.test(c)) return false;
  const dv = (n) => { const pesos = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const s = pesos.reduce((a, p, i) => a + Number(c[i]) * p, 0); const r = s % 11; return r < 2 ? 0 : 11 - r; };
  return dv(12) === Number(c[12]) && dv(13) === Number(c[13]);
}
const normalizarTel = (t) => { let d = String(t || '').replace(/\D/g, ''); if (d.length === 10 || d.length === 11) d = '55' + d; return /^55\d{10,11}$/.test(d) ? d : null; };

// Limite simples de cadastros por IP (contra robôs).
const porIp = new Map();
function excedeu(ip) { // conta só cadastros concluídos: no máximo 5 por hora por conexão
  const lst = (porIp.get(ip) || []).filter((t) => Date.now() - t < 3600e3); porIp.set(ip, lst); return lst.length >= 5;
}
const registrarIp = (ip) => porIp.get(ip || 'x').push(Date.now());

async function avisarAvantte(texto) {
  const avt = avantte(); if (!avt) return;
  for (const tel of [...new Set(telefonesAprovadores(avt))]) await avisarEquipe(avt, tel, `AVA Connect · Plataforma\n${texto}`);
}

/** Cria a conta pelo site. Retorna { token, pagamento_url, tenant_id } ou lança Error com mensagem para o usuário. */
export async function cadastrar(b, ip) {
  if (excedeu(ip || 'x')) throw new Error('Muitos cadastros a partir desta conexão. Tente de novo em uma hora.');
  const plano = PLANS[b.plano] ? b.plano : null;
  if (!plano) throw new Error('Escolha um plano.');
  const empresa = String(b.empresa || '').trim(), nome = String(b.nome || '').trim();
  const email = String(b.email || '').trim().toLowerCase();
  const doc = String(b.cpf_cnpj || '').replace(/\D/g, '');
  const tel = normalizarTel(b.whatsapp);
  if (empresa.length < 2) throw new Error('Informe o nome da empresa.');
  if (nome.length < 3) throw new Error('Informe seu nome completo.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Informe um e-mail válido.');
  if (!tel) throw new Error('Informe o WhatsApp com DDD.');
  if (!cpfValido(doc) && !cnpjValido(doc)) throw new Error('CPF ou CNPJ inválido.');
  if (!b.senha || b.senha.length < 8 || !/\d/.test(b.senha) || !/[A-Za-zÀ-ú]/.test(b.senha)) throw new Error('A senha precisa ter 8 caracteres ou mais, com letras e números.');
  if (!b.aceite) throw new Error('Para continuar, aceite os Termos de uso e a Política de privacidade.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new Error('Este e-mail já tem conta. Use "Entrar" ou "Esqueci minha senha".');
  const p = getPlan(plano);
  const ciclo = cicloOferecido(b.ciclo);
  const valorPrimeiro = valorCiclo(p, ciclo);

  // Conta da empresa cliente (pendente até o pagamento).
  const r = db.prepare(`INSERT INTO tenants (nome, plano, status, origem, cpf_cnpj, telefone_responsavel, painel_token, vendas_ativo, ciclo)
    VALUES (?, ?, 'pendente', 'site', ?, ?, ?, ?, ?)`).run(empresa, plano, doc, tel, newToken(), p.vendas ? 1 : 0, ciclo);
  const tid = Number(r.lastInsertRowid);
  criarAgente(tid, { modelo: p.vendas ? 'vendas' : 'recepcao', nome: 'AVA' });
  if (b.segmento) { try { aplicarSegmento(tid, b.segmento); } catch {} }
  const u = db.prepare(`INSERT INTO users (tenant_id, nome, email, telefone, papel, senha_hash) VALUES (?, ?, ?, ?, 'dono', ?)`)
    .run(tid, nome, email, tel, hashSenha(b.senha));
  const token = novaSessao(u.lastInsertRowid);
  registrarIp(ip || 'x');

  // Venda registrada no CRM da própria Avantte + cobrança da implantação e 1ª mensalidade na conta Avantte.
  const avt = avantte();
  let pagamento_url = null;
  if (avt) {
    db.prepare(`INSERT INTO contacts (tenant_id, telefone, nome) VALUES (?, ?, ?) ON CONFLICT(tenant_id, telefone) DO UPDATE SET nome = COALESCE(contacts.nome, excluded.nome)`).run(avt.id, tel, nome);
    const contact = db.prepare('SELECT * FROM contacts WHERE tenant_id = ? AND telefone = ?').get(avt.id, tel);
    const lead = garantirLead(avt, contact, null);
    const total = p.implantacao + valorPrimeiro;
    db.prepare(`UPDATE leads SET nome = ?, empresa = ?, email = ?, interesse = ?, etapa = 'proposta', valor_estimado = ?, origem = 'site', atualizado_em = datetime('now') WHERE id = ?`)
      .run(nome, empresa, email, `AVA Connect ${p.nome} ${nomeCiclo(ciclo)} (cadastro pelo site)`, total, lead.id);
    logActivity(avt.id, lead.id, `Cadastro pelo site: ${empresa}, plano ${p.nome} ${nomeCiclo(ciclo)}. Aguardando pagamento de ${total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}.`, { autor: 'sistema' });
    const ctoken = 'cob_' + crypto.randomBytes(14).toString('hex');
    const descricao = `${DESCRICAO_SERVICO} — plano ${p.nome}: implantação + ${ciclo === 'anual' ? 'plano anual (12 meses)' : ciclo === 'contrato' ? 'parcela 1 de 12' : '1ª mensalidade'}`;
    try {
      const { ref, url } = await criarCobranca(avt, { token: ctoken, valor: total, descricao, forma: 'livre', parcelas: 1, vencimentoDias: 3 });
      db.prepare(`INSERT INTO charges (tenant_id, contact_id, token, descricao, valor, forma, pagamento_ref, pagamento_url, signup_tenant_id)
        VALUES (?, ?, ?, ?, ?, 'livre', ?, ?, ?)`).run(avt.id, contact.id, ctoken, descricao, total, ref, url, tid);
      pagamento_url = url;
    } catch (e) {
      console.error('[cadastro] cobrança', e.message);
      logActivity(avt.id, lead.id, `Enviar o link de pagamento para ${empresa} (${email}) — o sistema não conseguiu gerar: ${e.message}`,
        { tipo: 'tarefa', autor: 'sistema', vence_em: hojeBR() });
    }
  }
  await avisarAvantte(`🆕 Novo cadastro pelo site: ${empresa} (${nome}, ${email}) — plano ${p.nome} ${nomeCiclo(ciclo)}. ${pagamento_url ? 'Link de pagamento gerado.' : 'Sem link de pagamento: enviar manualmente.'}`).catch(() => {});
  return { token, tenant_id: tid, pagamento_url };
}

// ---------- Ativação e assinatura ----------
async function criarAssinatura(t) {
  const avt = avantte(); const key = avt && chaveAsaas(avt);
  const p = getPlan(t.plano);
  const anual = cicloValido(t.ciclo) === 'anual';
  const venc = proximoVenc(hojeBR(), t.ciclo);
  if (!key) { // modo de teste ou sem conta: registra só o vencimento (cobrança manual)
    db.prepare("UPDATE tenants SET proximo_vencimento = ?, asaas_subscription_id = COALESCE(asaas_subscription_id, ?) WHERE id = ?")
      .run(venc, modoPagamento(avt || {}) === 'teste' ? `teste-${t.id}` : null, t.id);
    return;
  }
  const dono = db.prepare("SELECT * FROM users WHERE tenant_id = ? AND papel = 'dono' ORDER BY id LIMIT 1").get(t.id);
  let customer = t.asaas_customer_id;
  if (!customer) {
    customer = (await asaas('/customers', { name: t.nome, cpfCnpj: t.cpf_cnpj, email: dono?.email, mobilePhone: (t.telefone_responsavel || '').replace(/^55/, ''),
      externalReference: `tenant_${t.id}`, notificationDisabled: false }, key)).id;
    db.prepare('UPDATE tenants SET asaas_customer_id = ? WHERE id = ?').run(customer, t.id);
  }
  if (!t.asaas_subscription_id) {
    const sub = await asaas('/subscriptions', { customer, billingType: 'UNDEFINED', value: valorCiclo(p, t.ciclo), nextDueDate: venc, cycle: anual ? 'YEARLY' : 'MONTHLY',
      description: `${DESCRICAO_SERVICO} — plano ${p.nome}, ${anual ? 'anual' : cicloValido(t.ciclo) === 'contrato' ? 'parcela mensal do contrato de 12 meses' : 'mensalidade'}`, externalReference: `assinatura_${t.id}` }, key);
    db.prepare('UPDATE tenants SET asaas_subscription_id = ?, proximo_vencimento = ? WHERE id = ?').run(sub.id, venc, t.id);
  }
}

export async function ativarConta(tenantId) {
  const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);
  if (!t) return;
  db.prepare("UPDATE tenants SET status = 'ativo', cobranca_status = 'em_dia', ativado_em = COALESCE(ativado_em, datetime('now')) WHERE id = ?").run(t.id);
  if (CICLOS[cicloValido(t.ciclo)].fidelidade && !t.contrato_fim)
    db.prepare('UPDATE tenants SET contrato_fim = ? WHERE id = ?').run(somarMeses(hojeBR(), 12), t.id);
  try { await criarAssinatura(t); } catch (e) {
    console.error('[assinatura] não criada', e.message);
    await avisarAvantte(`⚠️ ${t.nome} pagou, mas a assinatura mensal não foi criada no Asaas (${e.message}). Crie manualmente.`).catch(() => {});
  }
  const dono = db.prepare("SELECT * FROM users WHERE tenant_id = ? AND papel = 'dono' ORDER BY id LIMIT 1").get(t.id);
  if (dono) await sendEmail({ nome: 'AVA Connect' }, { to: dono.email, subject: 'Sua conta AVA Connect está ativa',
    html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1d2433;max-width:560px"><p>Olá, ${dono.nome.split(' ')[0]}!</p>
      <p>Pagamento confirmado e conta <b>${t.nome}</b> ativada. Entre no painel e termine o passo a passo para colocar a sua assistente no ar.</p>
      <p style="margin:24px 0"><a href="${publicUrl()}/app" style="background:linear-gradient(90deg,#1f6fff,#12d8c4);color:#fff;text-decoration:none;padding:12px 22px;border-radius:9px;font-weight:bold">Entrar no painel</a></p>
      <p style="color:#6b7385;font-size:13px">${{ anual: 'O plano anual renova automaticamente a cada 12 meses.', contrato: `Seu contrato é de 12 meses, com as parcelas cobradas automaticamente todo mês. Nos primeiros ${GARANTIA_DIAS()} dias você pode cancelar sem multa.`, mensal: 'A mensalidade é cobrada automaticamente todo mês.' }[cicloValido(t.ciclo)]} Dúvidas: contato@grupoavantte.com.br</p></div>`,
    text: `Conta ativada. Entre em ${publicUrl()}/app` }).catch(() => {});
  await avisarAvantte(`✅ ${t.nome} pagou e foi ativada (plano ${getPlan(t.plano).nome} ${nomeCiclo(t.ciclo)}).`).catch(() => {});
}

aoConfirmarPagamento.push(async (charge) => { if (charge.signup_tenant_id) await ativarConta(charge.signup_tenant_id); });

/** Evento de pagamento de assinatura vindo do Asaas. Retorna true se tratou. */
export async function eventoAssinatura(ev, payment) {
  const t = payment?.subscription && db.prepare('SELECT * FROM tenants WHERE asaas_subscription_id = ?').get(payment.subscription);
  if (!t) return false;
  if (ev.pago) {
    const reativar = t.status === 'pausado' && t.cobranca_status === 'suspensa';
    db.prepare(`UPDATE tenants SET cobranca_status = 'em_dia', proximo_vencimento = ?, fatura_aberta_url = NULL, atraso_desde = NULL,
      status = CASE WHEN ? THEN 'ativo' ELSE status END WHERE id = ?`)
      .run(proximoVenc(payment.dueDate || hojeBR(), t.ciclo), reativar ? 1 : 0, t.id);
    // Renovação automática: pagamento que vence depois do fim do contrato abre mais 12 meses.
    if (t.contrato_fim && (payment.dueDate || hojeBR()) >= t.contrato_fim)
      db.prepare('UPDATE tenants SET contrato_fim = ? WHERE id = ?').run(somarMeses(t.contrato_fim, 12), t.id);
    if (reativar) {
      await avisarDono(t, 'Pagamento confirmado: sistema liberado', `<p>Recebemos o pagamento da <b>${t.nome}</b>. O sistema foi liberado e a assistente voltou a atender.</p>`);
      await avisarAvantte(`🔓 ${t.nome} pagou a parcela em atraso e foi liberada.`).catch(() => {});
    }
  } else if (ev.vencido) await marcarAtraso(t, payment.dueDate || hojeBR(), payment.invoiceUrl);
  return true;
}

async function avisarDono(t, assunto, corpo) {
  const dono = db.prepare("SELECT * FROM users WHERE tenant_id = ? AND papel = 'dono' ORDER BY id LIMIT 1").get(t.id);
  if (!dono) return;
  await sendEmail({ nome: 'AVA Connect' }, { to: dono.email, subject: assunto,
    html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1d2433;max-width:560px">${corpo}<p style="color:#6b7385;font-size:13px">Dúvidas: contato@grupoavantte.com.br</p></div>`,
    text: assunto }).catch(() => {});
}

/** Parcela vencida sem pagamento: marca atraso, avisa o cliente e agenda o bloqueio para daqui a DIAS_TOLERANCIA dias. */
async function marcarAtraso(t, vencimento, faturaUrl) {
  const primeiro = t.cobranca_status === 'em_dia';
  db.prepare(`UPDATE tenants SET cobranca_status = CASE WHEN cobranca_status = 'em_dia' THEN 'atrasada' ELSE cobranca_status END,
    atraso_desde = COALESCE(atraso_desde, ?), fatura_aberta_url = COALESCE(?, fatura_aberta_url) WHERE id = ?`).run(vencimento, faturaUrl || null, t.id);
  if (!primeiro) return;
  const bloqueio = somarDias(vencimento, DIAS_TOLERANCIA());
  const dataBR = bloqueio.split('-').reverse().join('/');
  agendarEm('suspender_inadimplente', { tenant_id: t.id }, new Date(bloqueio + 'T12:00:00Z'));
  if (DIAS_TOLERANCIA() > 3) agendarEm('lembrete_bloqueio', { tenant_id: t.id }, new Date(somarDias(bloqueio, -3) + 'T12:00:00Z'));
  await avisarDono(t, 'Parcela do AVA Connect em aberto', `<p>Não identificamos o pagamento da parcela da <b>${t.nome}</b>, vencida em ${vencimento.split('-').reverse().join('/')}.</p>
    <p>Se o pagamento não for identificado até <b>${dataBR}</b>, o sistema e a assistente serão bloqueados.</p>
    ${faturaUrl ? `<p><a href="${faturaUrl}">Pagar agora</a></p>` : ''}`);
  await avisarAvantte(`⏰ Parcela de ${t.nome} vencida. Bloqueio automático em ${dataBR} se não pagar.`).catch(() => {});
}

HANDLERS.lembrete_bloqueio = async ({ tenant_id }) => {
  const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenant_id);
  if (!t || t.cobranca_status !== 'atrasada') return 'nada a fazer';
  await avisarDono(t, 'Seu AVA Connect será bloqueado em 3 dias', `<p>A parcela da <b>${t.nome}</b> continua em aberto. Em 3 dias o sistema e a assistente serão bloqueados.</p>
    ${t.fatura_aberta_url ? `<p><a href="${t.fatura_aberta_url}">Pagar agora</a></p>` : ''}`);
  return 'avisado';
};

/** Bloqueia o sistema: assistente para de atender e o painel fica travado até o pagamento. */
export async function bloquearPorInadimplencia(t) {
  db.prepare("UPDATE tenants SET status = 'pausado', cobranca_status = 'suspensa' WHERE id = ?").run(t.id);
  await avisarDono(t, 'Seu AVA Connect foi bloqueado', `<p>Não identificamos o pagamento da <b>${t.nome}</b> e o sistema foi bloqueado: a assistente parou de atender e o painel fica travado.</p>
    <p>Assim que o pagamento for identificado, tudo volta a funcionar sozinho.</p>${t.fatura_aberta_url ? `<p><a href="${t.fatura_aberta_url}">Pagar agora</a></p>` : ''}`);
  await avisarAvantte(`⛔ ${t.nome} bloqueada por falta de pagamento.`).catch(() => {});
}

HANDLERS.suspender_inadimplente = async ({ tenant_id }) => {
  const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenant_id);
  if (!t || t.cobranca_status !== 'atrasada' || t.status !== 'ativo') return 'nada a fazer';
  if (t.atraso_desde && somarDias(t.atraso_desde, DIAS_TOLERANCIA()) > hojeBR()) return 'ainda no prazo';
  await bloquearPorInadimplencia(t);
  return 'suspensa';
};

/** Conferência diária (rede de segurança caso um aviso do Asaas se perca): qualquer parcela vencida há mais de
 *  DIAS_TOLERANCIA dias sem pagamento bloqueia o sistema. Com o Asaas ligado, confere as parcelas na API. */
let ultimaConferencia = 0;
export async function conferirInadimplencia() {
  const hoje = hojeBR();
  const limite = somarDias(hoje, -DIAS_TOLERANCIA());
  const avt = avantte(); const key = avt && chaveAsaas(avt);
  const alvos = db.prepare(`SELECT * FROM tenants WHERE status = 'ativo' AND cobranca_status != 'suspensa'
    AND (asaas_subscription_id IS NOT NULL OR proximo_vencimento IS NOT NULL) AND id != ?`).all(avt?.id ?? -1);
  let bloqueadas = 0;
  for (const t of alvos) {
    try {
      let vencida = null, url = null;
      if (key && t.asaas_subscription_id && !t.asaas_subscription_id.startsWith('teste-')) {
        const r = await asaas(`/payments?subscription=${encodeURIComponent(t.asaas_subscription_id)}&status=OVERDUE&limit=20`, null, key);
        const velha = (r.data || []).map((p) => ({ venc: p.dueDate, url: p.invoiceUrl })).sort((a, b) => a.venc.localeCompare(b.venc))[0];
        if (velha) ({ venc: vencida, url } = velha);
      } else if (t.proximo_vencimento && t.proximo_vencimento < hoje) vencida = t.atraso_desde || t.proximo_vencimento;
      if (!vencida) continue;
      if (t.cobranca_status === 'em_dia') await marcarAtraso(t, vencida, url);
      if (vencida <= limite) { await bloquearPorInadimplencia({ ...t, fatura_aberta_url: url || t.fatura_aberta_url }); bloqueadas++; }
    } catch (e) { console.error('[inadimplência]', t.nome, e.message); }
  }
  return bloqueadas;
}
periodicas.push(async () => {
  if (Date.now() - ultimaConferencia < 6 * 3600e3) return;
  ultimaConferencia = Date.now();
  await conferirInadimplencia();
});

/** Situação da conta para o painel do cliente. */
export function situacaoConta(tenantId) {
  const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);
  const c = db.prepare("SELECT * FROM charges WHERE signup_tenant_id = ? ORDER BY id DESC LIMIT 1").get(tenantId);
  const p = getPlan(t.plano);
  return { status: t.status, cobranca_status: t.cobranca_status, origem: t.origem, plano: p.nome, mensalidade: p.preco_mensal,
    ciclo: cicloValido(t.ciclo), valor_ciclo: valorCiclo(p, t.ciclo),
    proximo_vencimento: t.proximo_vencimento, assinatura: !!t.asaas_subscription_id,
    contrato_fim: t.contrato_fim || null, bloqueado: t.cobranca_status === 'suspensa', fatura_aberta_url: t.fatura_aberta_url || null,
    bloqueio_em: t.cobranca_status === 'atrasada' && t.atraso_desde ? somarDias(t.atraso_desde, DIAS_TOLERANCIA()) : null,
    garantia_ate: t.ativado_em && CICLOS[cicloValido(t.ciclo)].fidelidade ? somarDias(t.ativado_em.slice(0, 10), GARANTIA_DIAS()) : null,
    pagamento_pendente: t.status === 'pendente' ? { valor: c?.valor ?? null, url: c?.pagamento_url ?? null } : null };
}

export function rotasCadastro(app, express) {
  app.post('/api/public/cadastro', express.json(), async (req, res) => {
    try { res.status(201).json(await cadastrar(req.body || {}, req.ip)); }
    catch (e) { res.status(400).json({ erro: e.message }); }
  });
}
