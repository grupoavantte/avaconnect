import { publicUrl } from './payments.js';
import crypto from 'node:crypto';
// Cadastro inicial da própria Avantte como empresa cliente do AVA Connect (idempotente: só preenche o que falta).
import { db, newToken } from './db.js';
import { PLANS , MESES_PAGOS_ANUAL } from './plans.js';
import { criarAgente } from './agents.js';
import { convidarUsuario } from './auth.js';

const brl = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const PERSONA = `Somos a Avantte (grupoavantte.com.br), empresa de gestão e tecnologia para pequenas e médias empresas. Nossa divisão de tecnologia, a AVA Connect (avaconnect.com.br), tem três produtos com inteligência artificial:
- AVA Talk: atendimento e vendas com IA no WhatsApp, chat do site, formulários e e-mail.
- AVA Manager: gestão da empresa por departamentos, com um Consultor IA que analisa a empresa e o mercado.
- AVA Ponto: ponto eletrônico por reconhecimento facial no totem AVA Ponto, sem digitar nada.
Fale como uma consultora de negócios: direta, simpática e prática. Trate o cliente por você.
Seu objetivo é fechar: entenda a empresa, mostre o produto certo para a dor dela e conduza até a contratação. Você resolve tudo sozinha; a equipe humana é só o último recurso.
AVA Talk — antes de indicar um plano, entenda: o segmento, quantas conversas recebe por mês no WhatsApp, quantas pessoas atendem hoje e se quer só atendimento ou também vendas (proposta, cobrança e follow-up). Só atendimento e até 500 conversas/mês → Essencial. Agente vendendo e cobrando, ou mais de um número/agente → Profissional. Volume alto, vários setores ou integrações → Premium. Para fechar: envie o link de contratação avaconnect.com.br/cadastro ou gere a proposta.
AVA Manager e AVA Ponto — o preço é sob proposta. Entenda o tamanho da empresa (Manager: departamentos e número de usuários; Ponto: número de funcionários e locais), registre tudo com registrar_lead, marque uma demonstração com consultar_horarios/agendar_reuniao e crie o retorno da proposta com agendar_retorno. Também pode indicar as páginas avaconnect.com.br/manager e avaconnect.com.br/ponto.
Para quem estiver em dúvida, ofereça uma demonstração gratuita de 30 minutos.`;

const INSTRUCOES_AGENTE = 'Você vende os produtos da AVA Connect (AVA Talk, AVA Manager e AVA Ponto) e apresenta o Diagnóstico Empresarial e a consultoria. Entenda a empresa, descubra a dor e indique o produto certo. AVA Talk: conduza até a contratação (link avaconnect.com.br/cadastro ou proposta da implantação e da primeira parcela). AVA Manager e AVA Ponto: qualifique o tamanho da empresa, marque a demonstração e combine o retorno da proposta. Para quem fala de problemas de gestão, ofereça o diagnóstico. Na dúvida, ofereça a demonstração gratuita. Você resolve; a equipe humana é o último recurso.';
const INSTRUCOES_ANTIGAS = 'Você vende o AVA Connect e apresenta o Diagnóstico Empresarial e a consultoria.';

function baseConhecimento() {
  const p = PLANS;
  const linha = (x) => `- ${x.nome}: contrato de 12 meses em 12x de ${brl(x.preco_mensal)} ou ${brl(x.preco_anual)} à vista (${12 - MESES_PAGOS_ANUAL()} meses grátis), + implantação de ${brl(x.implantacao)}. Até ${x.conversas_mes.toLocaleString('pt-BR')} conversas/mês, ` +
    `${x.agentes} agente(s) de IA, ${x.numeros_whatsapp} número(s) de WhatsApp, ${x.usuarios_painel ? x.usuarios_painel + ' usuários no painel' : 'usuários ilimitados no painel'}. ${x.vendas ? 'Inclui o agente de vendas.' : 'Não inclui o agente de vendas.'}`;
  return `AVA CONNECT — DIVISÃO DE TECNOLOGIA DA AVANTTE
Site: avaconnect.com.br. Três produtos com a mesma IA: AVA Talk, AVA Manager e AVA Ponto.

AVA TALK — O QUE É
Assistente de IA que atende e vende pelo WhatsApp, chat do site, formulários e e-mail da empresa, 24 horas por dia, com CRM incluso. (Antes se chamava AVA Connect.)

O QUE A IA FAZ
- Atende na hora, a qualquer hora, usando as informações da própria empresa (produtos, preços, prazos, dúvidas frequentes).
- Qualifica o cliente e registra tudo no CRM (funil, tarefas e histórico).
- Agente de vendas (planos Profissional e Premium): monta e envia a proposta por WhatsApp e e-mail, negocia dentro dos limites definidos pelo dono, gera o link de pagamento (Pix, boleto ou cartão parcelado), confirma o pagamento e faz o follow-up sozinha.
- Marca reuniões, visitas e demonstrações na agenda e manda lembretes.
- Resolve sozinha e só passa para uma pessoa da equipe em último caso (cliente insiste em falar com alguém, reclamação grave).
- O dono aprova descontos especiais respondendo pelo próprio WhatsApp.

PLANOS
${['essencial', 'profissional', 'premium'].map((k) => linha(p[k])).join('\n')}

COMO FUNCIONA A CONTRATAÇÃO
- O cliente pode contratar sozinho pelo site, na página de cadastro (/cadastro): escolhe o plano, cria a conta e paga a implantação + 1ª parcela. A conta ativa sozinha após o pagamento. O contrato é de 12 meses, em 12 parcelas mensais cobradas automaticamente ou à vista com desconto, com garantia de 30 dias para cancelar sem multa. Sem pagamento identificado em 10 dias após o vencimento, o sistema é bloqueado até a regularização.
- Ou com a nossa ajuda:
1. Reunião rápida para entender a empresa.
2. Pagamento da implantação e da primeira parcela do contrato de 12 meses.
3. Implantação: a Avantte configura a base de conhecimento, o catálogo, os agentes e conecta o WhatsApp oficial (API da Meta).
4. Testes juntos e ativação.

WHATSAPP
- Usa o WhatsApp oficial da Meta (API do WhatsApp Business), em nome da empresa cliente.
- As mensagens são cobradas pela Meta diretamente no cartão da empresa cliente, conforme a tabela da Meta. Responder clientes dentro de 24h costuma ter custo baixo.
- O pagamento das vendas cai direto na conta Asaas da empresa cliente, não na Avantte.

DIAGNÓSTICO EMPRESARIAL
- 13 perguntas pelo WhatsApp, cerca de 5 minutos. Nota geral grátis na hora; relatório completo das 10 áreas com plano de 90 dias por R$ 297.

CONSULTORIA AVANTTE
- Executa o plano de melhorias junto com o empresário. A primeira reunião é gratuita; o valor é definido na reunião.

AVA MANAGER — GESTÃO COM IA
- Sistema de gestão dividido em departamentos: financeiro, comercial, e-commerce, marketing, compras e suprimentos, estoque, produção, RH e pessoal, jurídico. A empresa contrata o plano básico e só os departamentos que usa; os outros não aparecem e podem ser ligados depois.
- Consultor IA incluso: analisa os dados da empresa e o mercado (setor, concorrência, tendências), mostra onde está perdendo dinheiro, monta plano de ação com prazo e responde perguntas sobre os números.
- Preço sob proposta (depende dos departamentos e do número de usuários). Implantação acompanhada pela equipe Avantte.
- Página: avaconnect.com.br/manager

AVA PONTO — PONTO ELETRÔNICO COM IA
- O funcionário toca na tela do totem AVA Ponto, olha para a câmera e o ponto é registrado por reconhecimento facial, sem digitar nada e sem ninguém bater pelo colega. Equipe externa pode marcar pelo próprio celular, com registro do local.
- A IA fecha o espelho do mês, calcula horas extras e banco de horas e avisa o gestor no WhatsApp sobre atrasos, faltas e horas extras.
- O totem AVA Ponto é entregue pronto para usar e instalado pela equipe Avantte. Não precisa comprar relógio de ponto.
- Biometria usada só para o ponto, com consentimento do funcionário, conforme a LGPD.
- Em adequação à Portaria 671 do Ministério do Trabalho (REP-P); na proposta informamos a situação e a data de liberação.
- Preço sob proposta (pelo número de funcionários). Página: avaconnect.com.br/ponto

QUANDO NÃO SOUBER UM DETALHE
- Integrações específicas com sistemas do cliente, condições fora da tabela, nota fiscal ou cláusulas de contrato fora do que está aqui: diga que vai confirmar, registre com agendar_retorno e continue a venda. Não passe para a equipe por isso.

CONTATO
- Site: grupoavantte.com.br · E-mail: contato@grupoavantte.com.br`;
}

const CATALOGO = () => [
  ...['essencial', 'profissional', 'premium'].map((k) => ({ nome: `AVA Connect ${PLANS[k].nome} — parcela mensal (contrato 12 meses)`, preco: PLANS[k].preco_mensal, minimo: PLANS[k].preco_mensal, unidade: 'mês',
    descricao: `${PLANS[k].conversas_mes} conversas/mês, ${PLANS[k].agentes} agente(s), ${PLANS[k].numeros_whatsapp} número(s)${PLANS[k].vendas ? ', com agente de vendas' : ''}` })),
  ...['essencial', 'profissional', 'premium'].map((k) => ({ nome: `AVA Connect ${PLANS[k].nome} — contrato anual à vista`, preco: PLANS[k].preco_anual, minimo: PLANS[k].preco_anual, unidade: 'ano',
    descricao: `12 meses pagando ${MESES_PAGOS_ANUAL()}. ${PLANS[k].conversas_mes} conversas/mês, ${PLANS[k].agentes} agente(s), ${PLANS[k].numeros_whatsapp} número(s)${PLANS[k].vendas ? ', com agente de vendas' : ''}` })),
  ...['essencial', 'profissional', 'premium'].map((k) => ({ nome: `Implantação AVA Connect ${PLANS[k].nome}`, preco: PLANS[k].implantacao, minimo: Math.round(PLANS[k].implantacao * 0.8), unidade: 'serviço',
    descricao: 'Configuração da base, catálogo e agentes, conexão do WhatsApp oficial e testes' })),
];

export function garantirAvantte() {
  let t = db.prepare("SELECT * FROM tenants WHERE nome LIKE 'Avantte%' COLLATE NOCASE ORDER BY id LIMIT 1").get();
  const nova = !t;
  if (nova) {
    const r = db.prepare(`INSERT INTO tenants (nome, plano, status, nome_assistente, horario_atendimento, painel_token) VALUES ('Avantte', 'premium', 'ativo', 'AVA', 'Segunda a sexta, 9h às 18h', ?)`).run(newToken());
    t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(r.lastInsertRowid);
    console.log(`[seed] Empresa Avantte criada (id ${t.id}).`);
  }
  if (t.id !== Number(process.env.ASAAS_TENANT_ID || 1)) {
    console.warn(`[seed] A Avantte é a empresa ${t.id}: defina ASAAS_TENANT_ID=${t.id} para ela usar a conta Asaas da Avantte.`);
  }
  const set = (col, val) => db.prepare(`UPDATE tenants SET ${col} = ? WHERE id = ? AND (${col} IS NULL OR ${col} = '')`).run(val, t.id);
  set('persona', PERSONA);
  set('base_conhecimento', baseConhecimento());
  // Versão nova dos textos da Avantte (3 produtos, IA conduz até o fechamento): atualiza só se ainda for o texto padrão antigo.
  db.prepare("UPDATE tenants SET persona = ? WHERE id = ? AND persona LIKE 'Somos a Avantte (grupoavantte.com.br)%' AND persona NOT LIKE '%AVA Manager%'").run(PERSONA, t.id);
  db.prepare("UPDATE tenants SET base_conhecimento = ? WHERE id = ? AND base_conhecimento LIKE 'AVA CONNECT — O QUE É%'").run(baseConhecimento(), t.id);
  db.prepare('UPDATE agents SET instrucoes = ? WHERE tenant_id = ? AND instrucoes LIKE ?').run(INSTRUCOES_AGENTE, t.id, INSTRUCOES_ANTIGAS + '%');
  // Chat no site do AVA: saudação sem o nome da empresa.
  try { db.prepare("UPDATE tenants SET webchat_saudacao = 'Oi! Sou a AVA. Como posso te ajudar?' WHERE id = ? AND (webchat_saudacao IS NULL OR webchat_saudacao = '' OR webchat_saudacao LIKE '%da Avantte%')").run(t.id); } catch {}
  // Site com um botão só (o chat da AVA); WhatsApp fica para campanhas e redes sociais. Volta o balão para o canto.
  try { db.prepare('UPDATE tenants SET webchat_margem = 20 WHERE id = ? AND webchat_margem = 150').run(t.id); } catch {}
  set('condicoes_pagamento', 'Implantação: Pix, boleto ou cartão em até 3x. Contrato de 12 meses: 12 parcelas mensais (boleto, Pix ou cartão recorrente) ou à vista com desconto.');
  set('pos_venda_mensagem', 'Bem-vindo ao AVA Connect! Agora vamos agendar a reunião de implantação: é só me dizer o melhor dia e horário que eu marco aqui mesmo.');
  set('consultoria_descricao', '- A consultoria Avantte executa o plano de melhorias junto com o empresário, com acompanhamento mensal dos indicadores.');
  set('email_remetente_nome', 'Avantte · AVA Connect');
  if (nova) db.prepare(`UPDATE tenants SET vendas_ativo = 1, diagnostico_ativo = 1, desconto_max = 10, desconto_avista = 0, parcelas_max = 3,
    validade_proposta_dias = 7, agenda_dias = '1,2,3,4,5', agenda_inicio = '09:00', agenda_fim = '17:00', reuniao_minutos = 30 WHERE id = ?`).run(t.id);

  if (!db.prepare('SELECT 1 FROM agents WHERE tenant_id = ?').get(t.id)) {
    criarAgente(t.id, { modelo: 'vendas', nome: 'AVA', funcao: 'Consultora comercial da Avantte', habilidades: ['transferir', 'agenda', 'vendas', 'diagnostico'],
      instrucoes: INSTRUCOES_AGENTE });
  }
  { // Catálogo: cria o que falta (inclui os planos anuais em bases que já existiam), sem mexer no que foi editado.
    const ins = db.prepare('INSERT INTO products (tenant_id, nome, descricao, preco, preco_minimo, unidade) VALUES (?,?,?,?,?,?)');
    const tem = db.prepare('SELECT 1 FROM products WHERE tenant_id = ? AND nome = ?');
    // Nomes antigos (mensalidade / plano anual) passam a ser parcela do contrato / contrato à vista.
    for (const k of ['essencial', 'profissional', 'premium']) for (const [de, para] of [['mensalidade', 'parcela mensal (contrato 12 meses)'], ['plano anual', 'contrato anual à vista']])
      if (!tem.get(t.id, `AVA Connect ${PLANS[k].nome} — ${para}`)) db.prepare('UPDATE products SET nome = ? WHERE tenant_id = ? AND nome = ?').run(`AVA Connect ${PLANS[k].nome} — ${para}`, t.id, `AVA Connect ${PLANS[k].nome} — ${de}`);
    for (const p of CATALOGO()) if (!tem.get(t.id, p.nome)) ins.run(t.id, p.nome, p.descricao, p.preco, p.minimo, p.unidade);
  }

  // Usuário da plataforma (você, Avantte): vê e administra todas as empresas.
  const emailPlat = (process.env.PLATAFORMA_EMAIL || 'contato@grupoavantte.com.br').toLowerCase();
  if (!db.prepare("SELECT 1 FROM users WHERE papel = 'plataforma'").get() && !db.prepare('SELECT 1 FROM users WHERE email = ?').get(emailPlat)) {
    const { link } = convidarUsuario({ nome: process.env.PLATAFORMA_NOME || 'Walci Júnior', email: emailPlat, papel: 'plataforma' });
    console.log(`[seed] Acesso da plataforma criado para ${emailPlat}. Crie a senha em: ${link}`);
  }
  // Usuário da plataforma ainda sem senha: gera um link novo a cada inicialização (o anterior pode ter vencido).
  const semSenha = db.prepare("SELECT * FROM users WHERE email = ? AND (senha_hash IS NULL OR senha_hash = '')").get(emailPlat);
  if (semSenha) {
    const tk = 'inv_' + crypto.randomBytes(20).toString('hex');
    db.prepare("UPDATE users SET convite_token = ?, convite_expira = datetime('now', '+7 days') WHERE id = ?").run(tk, semSenha.id);
    console.log(`[seed] ${emailPlat} ainda não tem senha. Crie a senha em: ${publicUrl()}/convite/${tk}`);
  }
  return t;
}
