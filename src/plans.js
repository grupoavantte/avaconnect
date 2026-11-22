// Planos comerciais do AVA Connect. Preços em reais por mês.
export const PLANS = {
  essencial: {
    id: 'essencial',
    nome: 'Essencial',
    preco_mensal: 497,
    implantacao: 990,
    conversas_mes: 500,
    limite_base_conhecimento: 20000, // caracteres
    usuarios_painel: null, // ilimitado
    agentes: 1,
    vendas: false,
    modelo_avancado: false,
    numeros_whatsapp: 1,
    recursos: ['Usuários ilimitados no painel', '1 agente de IA e 1 número de WhatsApp', 'Atendimento 24h com IA', 'Base de conhecimento', 'CRM com funil, tarefas e histórico', 'Leads e retornos registrados pela IA', 'Transferência para humano por setor, fila e carteira de clientes', 'Copiloto: a IA sugere a resposta ao atendente', 'Pesquisa de satisfação e motivo de cada atendimento', 'Campanhas com modelos aprovados na Meta'],
  },
  profissional: {
    id: 'profissional',
    nome: 'Profissional',
    preco_mensal: 897,
    implantacao: 1490,
    conversas_mes: 1500,
    limite_base_conhecimento: 60000,
    usuarios_painel: null, // ilimitado
    agentes: 3,
    vendas: true,
    modelo_avancado: false,
    numeros_whatsapp: 2,
    recursos: ['Tudo do Essencial', 'Até 3 agentes (ex.: recepção, vendas, pós-venda) e 2 números', 'Agente de vendas: proposta, negociação, cobrança e follow-up', 'Métricas de conversão do funil', 'Exportação de leads para planilha', 'Aviso de transbordo no WhatsApp do responsável', 'Relatório mensal'],
  },
  premium: {
    id: 'premium',
    nome: 'Premium',
    preco_mensal: 1497,
    implantacao: 1990,
    conversas_mes: 4000,
    limite_base_conhecimento: 150000,
    usuarios_painel: null, // ilimitado
    agentes: 10,
    vendas: true,
    modelo_avancado: true,
    numeros_whatsapp: 5,
    recursos: ['Tudo do Profissional', 'Até 10 agentes e 5 números', 'Modelo de IA avançado nos agentes', 'Integrações (ERP/CRM)', 'Ajuste fino mensal da IA', 'Suporte prioritário'],
  },
};

// Plano anual: pago de uma vez, com desconto (padrão: paga 10 meses e leva 12). AVA_ANUAL_MESES muda a regra.
export const MESES_PAGOS_ANUAL = () => Math.min(12, Math.max(1, Number(process.env.AVA_ANUAL_MESES) || 10));
for (const p of Object.values(PLANS)) Object.defineProperty(p, 'preco_anual', { enumerable: true, get: () => p.preco_mensal * MESES_PAGOS_ANUAL() });
// Formas de contratação. "contrato": contrato de 12 meses pago em 12 parcelas mensais (padrão).
// "anual": 12 meses pagos de uma vez, com desconto. "mensal": legado, sem fidelidade (não é mais oferecido).
export const CICLOS = {
  contrato: { nome: 'Contrato de 12 meses em 12x', meses: 1, fidelidade: 12, oferecido: true },
  anual: { nome: 'Anual à vista', meses: 12, fidelidade: 12, oferecido: true },
  mensal: { nome: 'Mensal sem fidelidade', meses: 1, fidelidade: 0, oferecido: false },
};
export const cicloValido = (c) => (CICLOS[c] ? c : 'contrato');
/** Ciclo aceito numa contratação nova (só os oferecidos). */
export const cicloOferecido = (c) => (CICLOS[c]?.oferecido ? c : 'contrato');
/** Dias de garantia para sair sem multa. */
export const GARANTIA_DIAS = () => Number(process.env.AVA_GARANTIA_DIAS ?? 30);
/** Valor de cada cobrança da assinatura no ciclo escolhido. */
export const valorCiclo = (p, ciclo) => (cicloValido(ciclo) === 'anual' ? p.preco_anual : p.preco_mensal);

export function getPlan(id) {
  return PLANS[id] || PLANS.essencial;
}
