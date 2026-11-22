// Usuários, login com e-mail e senha, sessões, papéis e permissões.
// Papéis: plataforma (Avantte, vê todas as empresas) | dono | gestor | atendente.
import crypto from 'node:crypto';
import express from 'express';
import { db } from './db.js';
import { getPlan } from './plans.js';
import { sendEmail } from './email.js';
import { publicUrl } from './payments.js';
import { pagina, esc } from './report.js';

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,   -- NULL = usuário da plataforma
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  telefone TEXT,
  papel TEXT NOT NULL DEFAULT 'atendente',
  senha_hash TEXT,
  ativo INTEGER NOT NULL DEFAULT 1,
  convite_token TEXT UNIQUE,
  convite_expira TEXT,
  ultimo_login TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expira_em TEXT NOT NULL,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

export const PAPEIS = {
  plataforma: 'Plataforma (Avantte)',
  dono: 'Dono',
  gestor: 'Gestor',
  atendente: 'Atendente',
};
// O que cada papel pode fazer dentro da empresa.
const PERMISSOES = {
  dono: ['ver', 'atender', 'configurar', 'vender', 'aprovar', 'usuarios', 'conexoes'],
  gestor: ['ver', 'atender', 'configurar', 'vender', 'aprovar'],
  atendente: ['ver', 'atender'],
};
export const pode = (user, acao) => user.admin || (PERMISSOES[user.papel] || []).includes(acao);

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
export function hashSenha(senha) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(senha, salt, 64).toString('hex')}`;
}
function confereSenha(senha, hash) {
  if (!hash?.startsWith('scrypt$')) return false;
  const [, salt, h] = hash.split('$');
  const calc = crypto.scryptSync(senha, salt, 64);
  return calc.length === Buffer.from(h, 'hex').length && crypto.timingSafeEqual(calc, Buffer.from(h, 'hex'));
}
const senhaFraca = (s) => !s || s.length < 8 || !/\d/.test(s) || !/[A-Za-zÀ-ú]/.test(s);

export function novaSessao(userId) {
  const token = 'avs_' + crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT INTO sessions (token_hash, user_id, expira_em) VALUES (?, ?, datetime('now', '+30 days'))").run(sha(token), userId);
  db.prepare("UPDATE users SET ultimo_login = datetime('now') WHERE id = ?").run(userId);
  return token;
}

/** Cria usuário com convite (link para definir a senha). Retorna { user, link }. */
export function convidarUsuario({ tenant_id = null, nome, email, telefone = null, papel = 'atendente' }) {
  const token = 'inv_' + crypto.randomBytes(20).toString('hex');
  const r = db.prepare(`INSERT INTO users (tenant_id, nome, email, telefone, papel, convite_token, convite_expira)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+7 days'))`).run(tenant_id, nome, email.trim().toLowerCase(), telefone, papel, token);
  return { user: db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid), link: `${publicUrl()}/convite/${token}` };
}

function renovarConvite(user) {
  const token = 'inv_' + crypto.randomBytes(20).toString('hex');
  db.prepare("UPDATE users SET convite_token = ?, convite_expira = datetime('now', '+7 days') WHERE id = ?").run(token, user.id);
  return `${publicUrl()}/convite/${token}`;
}

async function emailConvite(user, link, tenantNome, assunto = 'Seu acesso ao AVA Connect') {
  return sendEmail({ nome: 'AVA Connect' }, { to: user.email, subject: assunto,
    html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1d2433;max-width:560px">
      <p>Olá, ${esc(user.nome.split(' ')[0])}!</p>
      <p>${tenantNome ? `Você recebeu acesso ao painel do AVA Connect da <b>${esc(tenantNome)}</b>.` : 'Seu acesso ao AVA Connect está pronto.'} Clique no botão para criar sua senha:</p>
      <p style="margin:24px 0"><a href="${link}" style="background:linear-gradient(90deg,#1f6fff,#12d8c4);color:#fff;text-decoration:none;padding:12px 22px;border-radius:9px;font-weight:bold">Criar minha senha</a></p>
      <p style="color:#6b7385;font-size:13px">O link vale por 7 dias. AVA Connect by Avantte · contato@grupoavantte.com.br</p></div>`,
    text: `Crie sua senha no AVA Connect: ${link}` });
}

// ---------- Limite simples de tentativas de login ----------
const tentativas = new Map();
function bloqueado(chave) {
  const t = tentativas.get(chave);
  return t && t.n >= 6 && Date.now() - t.desde < 15 * 60e3;
}
function falhou(chave) {
  const t = tentativas.get(chave);
  if (!t || Date.now() - t.desde > 15 * 60e3) tentativas.set(chave, { n: 1, desde: Date.now() });
  else t.n++;
}

// ---------- Bloqueio por inadimplência ----------
// Com a empresa bloqueada, o painel só consegue ler quem é o usuário, os dados básicos e a situação da conta (para pagar).
const BLOQUEIO = { erro: 'Sistema bloqueado por falta de pagamento. Pague a parcela em aberto para liberar.', bloqueado: true };
const liberadoNoBloqueio = (req) => req.method === 'GET' && /^\/(me|tenants(\/\d+(\/situacao)?)?)\/?$/.test(req.path);

// ---------- Middleware ----------
export function autenticar(ADMIN_TOKEN) {
  return (req, res, next) => {
    const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ erro: 'Faça login' });
    if (token.length === ADMIN_TOKEN.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN))) {
      req.user = { admin: true, papel: 'plataforma', nome: 'Administrador Avantte' };
      return next();
    }
    if (token.startsWith('avs_')) {
      const u = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expira_em > datetime('now') AND u.ativo = 1`).get(sha(token));
      if (u) {
        req.user = { admin: u.papel === 'plataforma', papel: u.papel, userId: u.id, nome: u.nome, email: u.email, tenantId: u.tenant_id ?? undefined };
        if (u.tenant_id) {
          const t = db.prepare('SELECT nome, status, cobranca_status FROM tenants WHERE id = ?').get(u.tenant_id);
          if (!t || t.status === 'cancelado') return res.status(403).json({ erro: 'Empresa sem acesso. Fale com a Avantte.' });
          req.user.empresa = t.nome;
          if (t.cobranca_status === 'suspensa' && !liberadoNoBloqueio(req)) return res.status(402).json(BLOQUEIO);
        }
        return next();
      }
      return res.status(401).json({ erro: 'Sessão expirada' });
    }
    // Token de painel da empresa (acesso legado/integrações): age como dono.
    const t = db.prepare('SELECT id, nome, cobranca_status FROM tenants WHERE painel_token = ?').get(token);
    if (t) {
      req.user = { admin: false, papel: 'dono', tenantId: t.id, nome: t.nome, empresa: t.nome };
      if (t.cobranca_status === 'suspensa' && !liberadoNoBloqueio(req)) return res.status(402).json(BLOQUEIO);
      return next();
    }
    res.status(401).json({ erro: 'Token inválido' });
  };
}
export const exigir = (acao) => (req, res, next) => (pode(req.user, acao) ? next() : res.status(403).json({ erro: 'Sem permissão para esta ação' }));

// ---------- Rotas públicas de autenticação ----------
export function rotasAuth(app) {
  const r = express.Router();
  r.post('/login', (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const senha = String(req.body?.senha || '');
    const chave = email + '|' + (req.ip || '');
    if (bloqueado(chave)) return res.status(429).json({ erro: 'Muitas tentativas. Aguarde 15 minutos.' });
    const u = db.prepare('SELECT * FROM users WHERE email = ? AND ativo = 1').get(email);
    if (!u || !confereSenha(senha, u.senha_hash)) { falhou(chave); return res.status(401).json({ erro: 'E-mail ou senha incorretos' }); }
    tentativas.delete(chave);
    res.json({ token: novaSessao(u.id), papel: u.papel });
  });
  r.post('/logout', (req, res) => {
    const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (token.startsWith('avs_')) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
    res.json({ ok: true });
  });
  r.post('/esqueci', async (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE email = ? AND ativo = 1').get(String(req.body?.email || '').trim().toLowerCase());
    if (u) await emailConvite(u, renovarConvite(u), null, 'Redefinir sua senha do AVA Connect');
    res.json({ ok: true, mensagem: 'Se o e-mail estiver cadastrado, enviamos um link para criar uma nova senha.' });
  });
  r.post('/definir-senha', (req, res) => {
    const u = db.prepare("SELECT * FROM users WHERE convite_token = ? AND convite_expira > datetime('now')").get(String(req.body?.token || ''));
    if (!u) return res.status(400).json({ erro: 'Link expirado ou inválido. Peça um novo.' });
    if (senhaFraca(req.body?.senha)) return res.status(400).json({ erro: 'A senha precisa ter 8 caracteres ou mais, com letras e números.' });
    db.prepare('UPDATE users SET senha_hash = ?, convite_token = NULL, convite_expira = NULL WHERE id = ?').run(hashSenha(req.body.senha), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    res.json({ token: novaSessao(u.id) });
  });
  app.use('/api/auth', r);

  app.get('/convite/:token', (req, res) => {
    const u = db.prepare("SELECT * FROM users WHERE convite_token = ? AND convite_expira > datetime('now')").get(req.params.token);
    const corpo = !u ? '<p>Este link expirou ou já foi usado. Peça um novo ao responsável pela sua conta.</p>' : `
      <h2 style="margin-top:0">Olá, ${esc(u.nome.split(' ')[0])}! Crie sua senha</h2><p style="color:#6b7385">Acesso: ${esc(u.email)}</p>
      <form id="f" style="display:grid;gap:10px;max-width:340px;margin:auto">
        <input id="s1" type="password" placeholder="Nova senha (8+ caracteres, letras e números)" required style="padding:12px;border:1px solid #c9d3e3;border-radius:9px">
        <input id="s2" type="password" placeholder="Repita a senha" required style="padding:12px;border:1px solid #c9d3e3;border-radius:9px">
        <button class="btn" type="submit">Criar senha e entrar</button><p id="e" style="color:#d64545"></p></form>
      <script>document.getElementById('f').onsubmit = async (ev) => { ev.preventDefault();
        const s1 = document.getElementById('s1').value, s2 = document.getElementById('s2').value, e = document.getElementById('e');
        if (s1 !== s2) { e.textContent = 'As senhas não conferem.'; return; }
        const r = await fetch('/api/auth/definir-senha', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: ${JSON.stringify(req.params.token)}, senha: s1 }) });
        const d = await r.json(); if (!r.ok) { e.textContent = d.erro; return; }
        try { localStorage.setItem('ava_token', d.token); } catch {} location.href = '/app'; };</script>`;
    res.set('cache-control', 'no-store').send(pagina('Criar senha — AVA Connect', `<div class="wrap"><div class="card" style="margin-top:40px;text-align:center">${corpo}</div></div>`));
  });
}

// ---------- API de usuários da empresa ----------
export function usuariosRouter(canSee) {
  const r = express.Router();
  const pub = (u) => ({ id: u.id, nome: u.nome, email: u.email, telefone: u.telefone, papel: u.papel, ativo: u.ativo, ultimo_login: u.ultimo_login, ver_conversas: u.ver_conversas || 'todas', ver_negocios: u.ver_negocios || 'todos',
    criado_em: u.criado_em, pendente: !u.senha_hash });
  const podeUsuarios = (req, tenantId) => canSee(req, tenantId) && pode(req.user, 'usuarios');

  r.get('/tenants/:id/users', (req, res) => {
    if (!canSee(req, req.params.id)) return res.sendStatus(403);
    res.json(db.prepare('SELECT * FROM users WHERE tenant_id = ? ORDER BY ativo DESC, nome').all(req.params.id).map(pub));
  });
  r.post('/tenants/:id/users', async (req, res) => {
    if (!podeUsuarios(req, req.params.id)) return res.status(403).json({ erro: 'Só o dono da conta gerencia usuários' });
    const b = req.body || {};
    if (!b.nome || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email || '')) return res.status(400).json({ erro: 'Informe nome e e-mail válidos' });
    if (!['dono', 'gestor', 'atendente'].includes(b.papel)) return res.status(400).json({ erro: 'Papel inválido' });
    const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
    const limite = getPlan(t.plano).usuarios_painel; // null = ilimitado
    if (limite && db.prepare('SELECT COUNT(*) n FROM users WHERE tenant_id = ? AND ativo = 1').get(t.id).n >= limite)
      return res.status(400).json({ erro: `O plano ${getPlan(t.plano).nome} permite ${limite} usuários. Desative alguém ou mude de plano.` });
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(b.email.trim().toLowerCase())) return res.status(409).json({ erro: 'Este e-mail já tem acesso ao AVA Connect' });
    const { user, link } = convidarUsuario({ tenant_id: t.id, nome: b.nome, email: b.email, telefone: b.telefone || null, papel: b.papel });
    if (['setor', 'minhas'].includes(b.ver_conversas) && b.papel !== 'dono') { db.prepare('UPDATE users SET ver_conversas = ? WHERE id = ?').run(b.ver_conversas, user.id); user.ver_conversas = b.ver_conversas; }
    if (b.ver_negocios === 'meus' && b.papel !== 'dono') { db.prepare("UPDATE users SET ver_negocios = 'meus' WHERE id = ?").run(user.id); user.ver_negocios = 'meus'; }
    const env = await emailConvite(user, link, t.nome);
    res.status(201).json({ ...pub(user), link_convite: link, email_enviado: !env.erro && !env.simulado });
  });
  r.put('/users/:id', (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!u || !u.tenant_id) return res.sendStatus(404);
    if (!podeUsuarios(req, u.tenant_id)) return res.status(403).json({ erro: 'Só o dono da conta gerencia usuários' });
    const b = req.body || {};
    if (b.papel && !['dono', 'gestor', 'atendente'].includes(b.papel)) return res.status(400).json({ erro: 'Papel inválido' });
    const ficaraSemDono = (b.papel && b.papel !== 'dono' && u.papel === 'dono') || (b.ativo === 0 && u.papel === 'dono');
    if (ficaraSemDono && db.prepare("SELECT COUNT(*) n FROM users WHERE tenant_id = ? AND papel = 'dono' AND ativo = 1").get(u.tenant_id).n <= 1)
      return res.status(400).json({ erro: 'A empresa precisa de pelo menos um dono ativo' });
    const cs = ['nome', 'telefone', 'papel', 'ativo'].filter((c) => b[c] !== undefined);
    if (cs.length) db.prepare(`UPDATE users SET ${cs.map((c) => c + ' = ?').join(', ')} WHERE id = ?`).run(...cs.map((c) => (c === 'ativo' ? Number(b[c]) : b[c])), u.id);
    if (b.ativo === 0) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    res.json(pub(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)));
  });
  r.post('/users/:id/convite', async (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!u || !u.tenant_id) return res.sendStatus(404);
    if (!podeUsuarios(req, u.tenant_id)) return res.status(403).json({ erro: 'Sem permissão' });
    const link = renovarConvite(u);
    const t = db.prepare('SELECT nome FROM tenants WHERE id = ?').get(u.tenant_id);
    const env = await emailConvite(u, link, t.nome, u.senha_hash ? 'Redefinir sua senha do AVA Connect' : 'Seu acesso ao AVA Connect');
    res.json({ link_convite: link, email_enviado: !env.erro && !env.simulado });
  });
  r.post('/me/senha', (req, res) => {
    if (!req.user.userId) return res.status(400).json({ erro: 'Entre com e-mail e senha para trocar a senha' });
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.userId);
    if (!confereSenha(String(req.body?.atual || ''), u.senha_hash)) return res.status(400).json({ erro: 'Senha atual incorreta' });
    if (senhaFraca(req.body?.nova)) return res.status(400).json({ erro: 'A nova senha precisa ter 8 caracteres ou mais, com letras e números.' });
    db.prepare('UPDATE users SET senha_hash = ? WHERE id = ?').run(hashSenha(req.body.nova), u.id);
    res.json({ ok: true });
  });
  return r;
}

// Telefones autorizados a aprovar propostas pelo WhatsApp (dono e gestor ativos + responsável da empresa).
export function telefonesAprovadores(tenant) {
  const nums = db.prepare("SELECT telefone FROM users WHERE tenant_id = ? AND ativo = 1 AND papel IN ('dono','gestor') AND telefone IS NOT NULL").all(tenant.id).map((u) => u.telefone);
  if (tenant.telefone_responsavel) nums.push(tenant.telefone_responsavel);
  return nums.map((n) => String(n).replace(/\D/g, '')).filter(Boolean);
}
