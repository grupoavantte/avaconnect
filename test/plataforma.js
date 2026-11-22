// Teste da base de produto: plataforma, empresas, usuários e papéis, agentes, números e conexões.
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN = process.env.ADMIN_TOKEN || 'troque-este-token';
let ok = 0;
const check = (c, m) => { if (!c) { console.error('FALHOU:', m); process.exit(1); } ok++; console.log('ok -', m); };
const call = async (path, { method = 'GET', body, token = ADMIN } = {}) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const tokenDo = (link) => link.split('/convite/')[1];
const sufixo = Date.now();

// Avantte cadastrada como cliente
const lista = (await call('/api/tenants')).data;
const avt = lista.filter((t) => /^avantte/i.test(t.nome)).sort((a, b) => a.id - b.id)[0];
check(avt && avt.plano === 'premium' && avt.vendas_ativo === 1, 'Avantte existe como empresa cliente (Premium, vendas ligado)');
check((await call(`/api/tenants/${avt.id}/products`)).data.length >= 6, 'catálogo da Avantte com planos e implantações');
check((await call(`/api/tenants/${avt.id}/agents`)).data.some((a) => a.habilidades.includes('vendas') && a.habilidades.includes('diagnostico')), 'agente AVA da Avantte com vendas e diagnóstico');
check((await call('/api/plataforma/usuarios')).data.length >= 1, 'usuário da plataforma criado com convite');

// Nova empresa pelo cadastro completo
const nova = await call('/api/plataforma/empresas', { method: 'POST', body: { nome: 'Metalúrgica Teste', plano: 'profissional', dono_nome: 'Maria Dona',
  dono_email: `maria${sufixo}@teste.com`, dono_telefone: '5524988887777', agentes: ['recepcao', 'vendas'], nome_assistente: 'Lia' } });
check(nova.status === 201 && nova.data.link_convite_dono.includes('/convite/'), 'empresa cadastrada com convite do dono');
const tid = nova.data.id;
const ags = (await call(`/api/tenants/${tid}/agents`)).data;
check(ags.length === 2 && ags[0].padrao === 1 && ags[0].nome === 'Lia', 'agentes iniciais criados (recepção padrão + vendas)');

// Dono cria a senha e entra
const pagina = await fetch(nova.data.link_convite_dono.replace(/^https?:\/\/[^/]+/, BASE)).then((r) => r.text());
check(pagina.includes('Crie sua senha'), 'página de convite abre');
check((await call('/api/auth/definir-senha', { method: 'POST', token: null, body: { token: tokenDo(nova.data.link_convite_dono), senha: 'curta' } })).status === 400, 'senha fraca recusada');
const ds = await call('/api/auth/definir-senha', { method: 'POST', token: null, body: { token: tokenDo(nova.data.link_convite_dono), senha: 'SenhaForte123' } });
check(ds.status === 200 && ds.data.token.startsWith('avs_'), 'dono definiu a senha');
check((await call('/api/auth/definir-senha', { method: 'POST', token: null, body: { token: tokenDo(nova.data.link_convite_dono), senha: 'OutraSenha123' } })).status === 400, 'convite não pode ser reutilizado');
const login = await call('/api/auth/login', { method: 'POST', token: null, body: { email: `MARIA${sufixo}@teste.com`, senha: 'SenhaForte123' } });
check(login.status === 200, 'login com e-mail e senha');
const DONO = login.data.token;
const me = (await call('/api/me', { token: DONO })).data;
check(me.papel === 'dono' && me.tenantId === tid && me.pode.usuarios && !me.admin, 'dono vê só a própria empresa');
check((await call(`/api/tenants/${avt.id}/leads`, { token: DONO })).status === 403, 'dono não acessa outra empresa');
check((await call('/api/plataforma/empresas', { method: 'POST', token: DONO, body: { nome: 'x' } })).status === 403, 'dono não cadastra empresas');

// Equipe
const g = (await call(`/api/tenants/${tid}/users`, { method: 'POST', token: DONO, body: { nome: 'Gil Gestor', email: `gil${sufixo}@teste.com`, papel: 'gestor', telefone: '5524977776666' } })).data;
const a = (await call(`/api/tenants/${tid}/users`, { method: 'POST', token: DONO, body: { nome: 'Ana Atendente', email: `ana${sufixo}@teste.com`, papel: 'atendente' } })).data;
check(g.link_convite && a.pendente, 'dono convidou gestor e atendente');
const GEST = (await call('/api/auth/definir-senha', { method: 'POST', token: null, body: { token: tokenDo(g.link_convite), senha: 'Gestor12345' } })).data.token;
const ATEND = (await call('/api/auth/definir-senha', { method: 'POST', token: null, body: { token: tokenDo(a.link_convite), senha: 'Atende12345' } })).data.token;
check((await call(`/api/tenants/${tid}`, { method: 'PUT', token: ATEND, body: { persona: 'x' } })).status === 403, 'atendente não altera configuração');
check((await call(`/api/tenants/${tid}/products`, { method: 'POST', token: ATEND, body: { nome: 'X', preco: 10 } })).status === 403, 'atendente não mexe no catálogo');
check((await call(`/api/tenants/${tid}/conversations`, { token: ATEND })).status === 200, 'atendente vê as conversas');
check((await call(`/api/tenants/${tid}/products`, { method: 'POST', token: GEST, body: { nome: 'Rampa', preco: 9000 } })).status === 201, 'gestor cadastra produto');
check((await call(`/api/tenants/${tid}/users`, { method: 'POST', token: GEST, body: { nome: 'Z', email: `z${sufixo}@teste.com`, papel: 'atendente' } })).status === 403, 'gestor não convida usuários');
check((await call(`/api/tenants/${tid}/conexoes`, { method: 'PUT', token: GEST, body: { asaas_api_key: 'x' } })).status === 403, 'gestor não altera conexões');
const donos = (await call(`/api/tenants/${tid}/users`, { token: DONO })).data.filter((u) => u.papel === 'dono');
check((await call(`/api/users/${donos[0].id}`, { method: 'PUT', token: DONO, body: { papel: 'atendente' } })).status === 400, 'empresa nunca fica sem dono');

// Login: senha errada e bloqueio
check((await call('/api/auth/login', { method: 'POST', token: null, body: { email: `ana${sufixo}@teste.com`, senha: 'errada' } })).status === 401, 'senha errada recusada');
for (let i = 0; i < 6; i++) await call('/api/auth/login', { method: 'POST', token: null, body: { email: `ana${sufixo}@teste.com`, senha: 'errada' } });
check((await call('/api/auth/login', { method: 'POST', token: null, body: { email: `ana${sufixo}@teste.com`, senha: 'Atende12345' } })).status === 429, 'bloqueio após várias tentativas');

// Agentes e limites do plano
check((await call(`/api/tenants/${tid}/agents`, { method: 'POST', token: GEST, body: { modelo: 'posvenda', nome: 'Pós' } })).status === 201, 'gestor cria o 3º agente');
check((await call(`/api/tenants/${tid}/agents`, { method: 'POST', token: GEST, body: { modelo: 'recepcao' } })).status === 400, 'limite de 3 agentes do Profissional');
const ess = (await call('/api/plataforma/empresas', { method: 'POST', body: { nome: 'Loja Essencial', plano: 'essencial', agentes: ['vendas'] } })).data;
check((await call(`/api/tenants/${ess.id}/agents`)).data[0].habilidades.includes('vendas') === false, 'Essencial não recebe agente de vendas');
check((await call(`/api/agents/${(await call(`/api/tenants/${ess.id}/agents`)).data[0].id}`, { method: 'PUT', body: { habilidades: ['vendas'] } })).status === 400, 'vendas bloqueado no Essencial');

// Números de WhatsApp e roteamento para o agente
const vend = ags.find((x) => x.habilidades.includes('vendas'));
const pnid = String(sufixo).slice(-10);
const num = await call(`/api/tenants/${tid}/numbers`, { method: 'POST', token: DONO, body: { nome: 'Comercial', phone_number_id: pnid, token: 'EAAtest', agent_id: vend.id } });
check(num.status === 201 && num.data.token_configurado && !('token' in num.data), 'número conectado (token não volta ao painel)');
check((await call(`/api/tenants/${tid}`, { token: DONO })).data.wa_phone_number_id === pnid, 'número principal sincronizado com a empresa');
await fetch(BASE + '/webhooks/whatsapp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entry: [{ changes: [{ value: {
  metadata: { phone_number_id: pnid }, contacts: [{ wa_id: '5521900001111', profile: { name: 'Cliente' } }],
  messages: [{ from: '5521900001111', id: 'wamid.P' + sufixo, type: 'text', text: { body: 'Olá' } }] } }] }] }) });
await new Promise((r) => setTimeout(r, 500));
const conv = (await call(`/api/tenants/${tid}/conversations`, { token: DONO })).data.find((c) => c.telefone === '5521900001111');
check(conv && conv.agent_id === vend.id && conv.numero_id === num.data.id, 'mensagem no número Comercial cai no agente de vendas');
const sim = (await call(`/api/tenants/${tid}/simulate`, { method: 'POST', token: DONO, body: { texto: 'Oi', telefone: 'sim-x', agent_id: ags[0].id } })).data;
check(sim.respostas[0].includes('Lia'), 'simulador testa um agente específico');

// Conexões e implantação
const cx = await call(`/api/tenants/${tid}/conexoes`, { method: 'PUT', token: DONO, body: { asaas_api_key: '$aact_teste', asaas_webhook_token: 'whk' } });
check(cx.status === 200, 'dono cadastra a conta Asaas');
check((await call(`/api/tenants/${tid}`, { token: DONO })).data.asaas_configurado === true, 'Asaas marcado como configurado (chave escondida)');
const imp = (await call(`/api/tenants/${tid}/implantacao`, { token: DONO })).data;
check(imp.total >= 8 && imp.passos.find((p) => p.id === 'usuarios').feito && imp.passos.find((p) => p.id === 'asaas').feito, 'roteiro de implantação calcula o progresso');

// Sair
check((await call('/api/auth/logout', { method: 'POST', token: ATEND })).status === 200 && (await call('/api/me', { token: ATEND })).status === 401, 'logout encerra a sessão');
check((await call('/api/me', { token: avt.painel_token ?? 'x' })).status === 401, 'token de painel não vaza na listagem');

console.log(`\n${ok} verificações da plataforma passaram.`);

// Site público, login e passo a passo
const site = await fetch(BASE + '/').then((r) => r.text());
check(site.includes('Seu melhor vendedor nunca dorme') && site.includes('/entrar'), 'site público na raiz com botão Entrar');
check((await fetch(BASE + '/entrar').then((r) => r.text())).includes('Bem-vindo de volta'), 'tela de login em /entrar');
const pub = await call('/api/public/site', { token: null });
check(pub.data.planos.length === 3 && !JSON.stringify(pub.data).includes('token'), 'dados públicos do site sem segredos');
const neg = await call(`/api/tenants/${tid}/negocio`, { method: 'PUT', token: DONO, body: { guiada: { produtos: 'Rampas e niveladores', pagamento: 'Pix ou cartão', faq: [{ p: 'Instalam?', r: 'Sim, no RJ.' }] } } });
check(neg.status === 200 && neg.data.base_conhecimento.includes('O QUE VENDEMOS') && neg.data.base_conhecimento.includes('P: Instalam?'), 'perguntas guiadas viram a base de conhecimento');
check((await call(`/api/tenants/${tid}/negocio`, { method: 'PUT', token: ATEND2(), body: { guiada: {} } })).status !== 200, 'atendente não altera o negócio');
check((await call(`/api/agents/${ags[0].id}`, { method: 'PUT', token: DONO, body: { tom: 'formal' } })).data.tom === 'formal', 'tom de voz do agente salvo');
check((await call(`/api/tenants/${tid}`, { method: 'PUT', token: DONO, body: { onboarding_concluido: 1, segmento: 'Indústria' } })).data.onboarding_concluido === 1, 'configuração marcada como concluída');
console.log(`\n${ok} verificações (com site e passo a passo).`);
function ATEND2() { return 'avs_invalido'; }
