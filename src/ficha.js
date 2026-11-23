// Ficha do cliente (PF ou PJ): dados que a empresa precisa para proposta, nota e entrega.
// A empresa escolhe o que coletar; a IA pergunta de forma natural (no máximo dois dados por mensagem).
// Com o CNPJ, o sistema busca razão social, situação e endereço na Receita (BrasilAPI); com o CEP, completa o endereço.
// A IA só confirma com o cliente em vez de perguntar tudo.
import express from 'express';
import { db } from './db.js';
import { pode } from './auth.js';

const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
const addCols = (t, lista) => { const tem = cols(t); for (const [c, d] of lista) if (!tem.includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); };
addCols('tenants', [['ficha_campos', "TEXT NOT NULL DEFAULT '[]'"], ['ficha_momento', "TEXT NOT NULL DEFAULT 'fechamento'"]]);
addCols('contacts', [['ficha', 'TEXT']]);

// Grupos que a empresa pode exigir (a tela de configuração mostra estes).
export const GRUPOS = {
  documento: { nome: 'CPF ou CNPJ', ajuda: 'Pergunta se é pessoa física ou empresa. Com CNPJ, busca a razão social e o endereço sozinho.' },
  ie: { nome: 'Inscrição estadual', ajuda: 'Só para empresa (pode ser "isento").' },
  email: { nome: 'E-mail', ajuda: 'Para mandar proposta, nota e boleto.' },
  endereco: { nome: 'Endereço completo', ajuda: 'Com o CEP, completa rua, bairro, cidade e UF; pede só número e complemento.' },
  nascimento: { nome: 'Data de nascimento', ajuda: 'Só para pessoa física.' },
};
export const MOMENTOS = { inicio: 'Logo depois do nome e do assunto', fechamento: 'Só quando o cliente decidir comprar (antes da proposta, cobrança ou pedido)' };

export const ROTULO = { tipo_pessoa: 'se é pessoa física ou empresa', cpf: 'CPF', cnpj: 'CNPJ', razao_social: 'razão social', nome_fantasia: 'nome fantasia',
  inscricao_estadual: 'inscrição estadual', email: 'e-mail', data_nascimento: 'data de nascimento', cep: 'CEP', endereco: 'rua', numero: 'número',
  complemento: 'complemento', bairro: 'bairro', cidade: 'cidade', uf: 'UF' };
const CAMPOS = Object.keys(ROTULO);

const so = (s) => String(s ?? '').replace(/\D/g, '');
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
export const fmtCpf = (c) => c.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
export const fmtCnpj = (c) => c.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
export const fmtCep = (c) => c.replace(/(\d{5})(\d{3})/, '$1-$2');

export const camposDaEmpresa = (t) => { try { return JSON.parse(t.ficha_campos || '[]').filter((g) => GRUPOS[g]); } catch { return []; } };
export const lerFicha = (contactId) => { try { return JSON.parse(db.prepare('SELECT ficha FROM contacts WHERE id = ?').get(contactId)?.ficha || '{}'); } catch { return {}; } };

/** Lista do que ainda falta, conforme o que a empresa exige e se é PF ou PJ. */
export function faltando(t, f) {
  const g = camposDaEmpresa(t); const falta = [];
  const pj = f.tipo_pessoa === 'PJ', pf = f.tipo_pessoa === 'PF';
  if (g.includes('documento')) {
    if (!f.tipo_pessoa) falta.push('tipo_pessoa');
    else if (pf && !f.cpf) falta.push('cpf');
    else if (pj) { if (!f.cnpj) falta.push('cnpj'); else if (!f.razao_social) falta.push('razao_social'); }
  }
  if (g.includes('ie') && f.tipo_pessoa !== 'PF' && !f.inscricao_estadual) falta.push('inscricao_estadual');
  if (g.includes('email') && !f.email) falta.push('email');
  if (g.includes('endereco')) for (const c of ['cep', 'endereco', 'numero', 'bairro', 'cidade', 'uf']) if (!f[c]) falta.push(c);
  if (g.includes('nascimento') && f.tipo_pessoa !== 'PJ' && !f.data_nascimento) falta.push('data_nascimento');
  return falta;
}

// ---------- Consultas públicas (Receita via BrasilAPI) ----------
const MOCK_CNPJ = { razao_social: 'EMPRESA TESTE LTDA', nome_fantasia: 'Empresa Teste', situacao: 'ATIVA', cep: '01310100', endereco: 'Avenida Paulista',
  numero: '1000', complemento: '', bairro: 'Bela Vista', cidade: 'São Paulo', uf: 'SP', atividade: 'Comércio' };
async function buscar(url) {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 7000);
  try { const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } }); return r.ok ? await r.json() : null; }
  catch { return null; } finally { clearTimeout(tm); }
}
export async function consultarCnpj(cnpj) {
  if (process.env.FICHA_MOCK === '1') return cnpj === '11222333000181' ? { ...MOCK_CNPJ } : null;
  const d = await buscar(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`);
  if (!d?.razao_social) return null;
  return { razao_social: d.razao_social, nome_fantasia: d.nome_fantasia || '', situacao: d.descricao_situacao_cadastral || '', cep: so(d.cep),
    endereco: [d.descricao_tipo_de_logradouro, d.logradouro].filter(Boolean).join(' '), numero: d.numero || '', complemento: d.complemento || '',
    bairro: d.bairro || '', cidade: d.municipio || '', uf: d.uf || '', atividade: d.cnae_fiscal_descricao || '' };
}
export async function consultarCep(cep) {
  if (process.env.FICHA_MOCK === '1') return cep === '01310100' ? { endereco: 'Avenida Paulista', bairro: 'Bela Vista', cidade: 'São Paulo', uf: 'SP' } : null;
  const d = await buscar(`https://brasilapi.com.br/api/cep/v2/${cep}`);
  if (!d?.city) return null;
  return { endereco: d.street || '', bairro: d.neighborhood || '', cidade: d.city, uf: d.state };
}

/** Junta dados novos na ficha, valida e completa pelo CNPJ/CEP. Retorna { ficha, avisos, erros }. */
export async function atualizarFicha(t, contact, input) {
  const f = lerFicha(contact.id); const avisos = []; const erros = [];
  const novo = {};
  for (const c of CAMPOS) if (input[c] !== undefined && input[c] !== null && String(input[c]).trim() !== '') novo[c] = String(input[c]).trim().slice(0, 160);
  if (novo.tipo_pessoa) { const v = novo.tipo_pessoa.toUpperCase(); novo.tipo_pessoa = /J|EMPRESA|CNPJ/.test(v) ? 'PJ' : 'PF'; }
  if (novo.cpf) { const d = so(novo.cpf); if (cpfValido(d)) { novo.cpf = fmtCpf(d); novo.tipo_pessoa ||= 'PF'; } else { erros.push('O CPF informado não é válido. Peça para o cliente conferir.'); delete novo.cpf; } }
  if (novo.cnpj) {
    const d = so(novo.cnpj);
    if (!cnpjValido(d)) { erros.push('O CNPJ informado não é válido. Peça para o cliente conferir.'); delete novo.cnpj; }
    else {
      novo.cnpj = fmtCnpj(d); novo.tipo_pessoa = 'PJ';
      if (so(f.cnpj) !== d) {
        const r = await consultarCnpj(d);
        if (r) {
          for (const c of ['razao_social', 'nome_fantasia', 'cep', 'endereco', 'numero', 'complemento', 'bairro', 'cidade', 'uf']) if (r[c] && !novo[c]) novo[c] = r[c];
          if (novo.cep) novo.cep = fmtCep(so(novo.cep));
          avisos.push(`Receita: ${r.razao_social}${r.nome_fantasia ? ` (${r.nome_fantasia})` : ''}, situação ${r.situacao || 'não informada'}${r.cidade ? `, ${r.endereco}, ${r.numero} — ${r.bairro}, ${r.cidade}/${r.uf}` : ''}. Confirme com o cliente se é essa empresa e esse endereço (pode ser outro endereço de entrega).`);
          if (r.situacao && !/ATIVA/i.test(r.situacao)) avisos.push(`Atenção: o CNPJ está com situação "${r.situacao}" na Receita. Avise a equipe com agendar_retorno antes de fechar.`);
        } else avisos.push('Não consegui consultar o CNPJ agora. Peça a razão social ao cliente.');
      }
    }
  }
  if (novo.cep && !(novo.cnpj && novo.endereco)) {
    const d = so(novo.cep);
    if (d.length !== 8) { erros.push('O CEP precisa ter 8 números.'); delete novo.cep; }
    else {
      novo.cep = fmtCep(d);
      if (so(f.cep) !== d && !novo.endereco) {
        const r = await consultarCep(d);
        if (r) { for (const c of ['endereco', 'bairro', 'cidade', 'uf']) if (r[c] && !novo[c]) novo[c] = r[c]; avisos.push(`CEP: ${r.endereco ? `${r.endereco}, ` : ''}${r.bairro ? `${r.bairro}, ` : ''}${r.cidade}/${r.uf}. Confirme e peça só o número e o complemento.`); }
        else avisos.push('Não encontrei esse CEP. Peça o endereço completo.');
      }
    }
  }
  if (novo.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(novo.email)) { erros.push('O e-mail parece incompleto. Peça para o cliente conferir.'); delete novo.email; }
  if (novo.uf) novo.uf = novo.uf.toUpperCase().slice(0, 2);
  // Trocou de PF para PJ (ou o contrário): limpa o documento do outro tipo.
  if (novo.tipo_pessoa === 'PJ' && f.tipo_pessoa === 'PF') delete f.cpf;
  if (novo.tipo_pessoa === 'PF' && f.tipo_pessoa === 'PJ') { delete f.cnpj; delete f.razao_social; delete f.nome_fantasia; delete f.inscricao_estadual; }
  const ficha = { ...f, ...novo };
  db.prepare('UPDATE contacts SET ficha = ?, email = COALESCE(?, email) WHERE id = ?').run(JSON.stringify(ficha), ficha.email || null, contact.id);
  let lead = db.prepare('SELECT id FROM leads WHERE contact_id = ?').get(contact.id);
  if (!lead) { try { const { garantirLead } = await import('./vendas.js'); lead = garantirLead(t, contact, null); } catch {} }
  if (lead) db.prepare("UPDATE leads SET email = COALESCE(?, email), empresa = COALESCE(?, empresa), atualizado_em = datetime('now') WHERE id = ?")
    .run(ficha.email || null, ficha.tipo_pessoa === 'PJ' ? (ficha.nome_fantasia || ficha.razao_social || null) : null, lead.id);
  return { ficha, avisos, erros };
}

export function resumoFicha(f) {
  const end = [f.endereco && `${f.endereco}${f.numero ? `, ${f.numero}` : ''}${f.complemento ? ` ${f.complemento}` : ''}`, f.bairro, f.cidade && `${f.cidade}/${f.uf || ''}`, f.cep && `CEP ${f.cep}`].filter(Boolean).join(' — ');
  return [f.tipo_pessoa === 'PJ' ? 'Empresa' : f.tipo_pessoa === 'PF' ? 'Pessoa física' : '', f.razao_social, f.nome_fantasia && `(${f.nome_fantasia})`,
    f.cnpj && `CNPJ ${f.cnpj}`, f.cpf && `CPF ${f.cpf}`, f.inscricao_estadual && `IE ${f.inscricao_estadual}`, f.email, f.data_nascimento && `nasc. ${f.data_nascimento}`, end]
    .filter(Boolean).join(' · ');
}

// ---------- IA ----------
export function ferramentasFicha(t) {
  if (!camposDaEmpresa(t).length) return [];
  const props = Object.fromEntries(CAMPOS.map((c) => [c, { type: 'string', description: ROTULO[c] }]));
  props.tipo_pessoa = { type: 'string', enum: ['PF', 'PJ'], description: 'PF = pessoa física, PJ = empresa' };
  props.cnpj.description = 'CNPJ (o sistema busca razão social e endereço na Receita)';
  props.cep.description = 'CEP (o sistema completa rua, bairro, cidade e UF)';
  return [{ name: 'salvar_ficha', description: 'Salva os dados cadastrais que o cliente informou (só os que ele disse nesta mensagem). Valida CPF/CNPJ, busca o CNPJ na Receita e completa o endereço pelo CEP. Responde o que falta.',
    input_schema: { type: 'object', properties: props } }];
}

export async function executarFerramentaFicha(ctx, nome, input) {
  if (nome !== 'salvar_ficha') return null;
  const { ficha, avisos, erros } = await atualizarFicha(ctx.tenant, ctx.contact, input || {});
  const falta = faltando(ctx.tenant, ficha).map((c) => ROTULO[c]);
  return [erros.join(' '), avisos.join(' '), falta.length ? `Ainda falta: ${falta.join(', ')}. Peça no máximo dois por mensagem.` : 'Ficha completa. Siga o atendimento.'].filter(Boolean).join(' ');
}

export function contextoFicha(t, contactId) {
  if (!camposDaEmpresa(t).length || !contactId) return '';
  const f = lerFicha(contactId); const falta = faltando(t, f);
  const tem = resumoFicha(f);
  if (!falta.length) return `Ficha do cliente completa: ${tem}. Não peça esses dados de novo.`;
  const quando = (t.ficha_momento || 'fechamento') === 'inicio'
    ? 'Colete logo depois de saber o nome e o assunto'
    : 'Colete só quando o cliente decidir comprar, antes de proposta, cobrança ou pedido';
  return `Ficha do cliente${tem ? ` (já temos: ${tem})` : ''}. Falta: ${falta.map((c) => ROTULO[c]).join(', ')}. ${quando}, no máximo dois dados por mensagem, e chame salvar_ficha a cada resposta. Se for empresa, peça o CNPJ primeiro: o sistema busca razão social e endereço e você só confirma.`;
}

/** Bloqueia proposta/cobrança/pedido enquanto faltar dado obrigatório. Retorna mensagem para a IA ou null. */
export function travaFicha(t, contactId, ferramenta) {
  if (!['criar_proposta', 'gerar_cobranca', 'criar_pedido'].includes(ferramenta) || !camposDaEmpresa(t).length) return null;
  const falta = faltando(t, lerFicha(contactId));
  if (!falta.length) return null;
  return `Antes disso, falta coletar: ${falta.map((c) => ROTULO[c]).join(', ')}. Peça ao cliente (no máximo dois por mensagem), chame salvar_ficha e depois tente de novo.`;
}

// ---------- Painel ----------
export function fichaRouter(canSee) {
  const r = express.Router();
  r.get('/tenants/:id/ficha-config', (req, res) => {
    if (!canSee(req, req.params.id)) return res.sendStatus(403);
    const t = db.prepare('SELECT ficha_campos, ficha_momento FROM tenants WHERE id = ?').get(req.params.id);
    if (!t) return res.sendStatus(404);
    res.json({ campos: camposDaEmpresa(t), momento: t.ficha_momento || 'fechamento', grupos: GRUPOS, momentos: MOMENTOS });
  });
  r.put('/tenants/:id/ficha-config', (req, res) => {
    if (!canSee(req, req.params.id)) return res.sendStatus(403);
    if (!pode(req.user, 'configurar')) return res.status(403).json({ erro: 'Sem permissão' });
    const campos = (Array.isArray(req.body?.campos) ? req.body.campos : []).filter((g) => GRUPOS[g]);
    const momento = MOMENTOS[req.body?.momento] ? req.body.momento : 'fechamento';
    db.prepare('UPDATE tenants SET ficha_campos = ?, ficha_momento = ? WHERE id = ?').run(JSON.stringify([...new Set(campos)]), momento, req.params.id);
    res.json({ ok: true });
  });
  // Edição manual pela equipe (no CRM).
  r.put('/contacts/:id/ficha', async (req, res) => {
    const c = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
    if (!c) return res.sendStatus(404);
    if (!canSee(req, c.tenant_id)) return res.sendStatus(403);
    const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(c.tenant_id);
    const r2 = await atualizarFicha(t, c, req.body || {});
    if (r2.erros.length) return res.status(400).json({ erro: r2.erros.join(' ') });
    res.json({ ficha: r2.ficha, avisos: r2.avisos });
  });
  return r;
}
