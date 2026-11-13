// Planos comerciais do AVA Connect. Preços em reais por mês.
export const PLANS = {
  essencial: {
    id: 'essencial',
    nome: 'Essencial',
    preco_mensal: 497,
    implantacao: 990,
    conversas_mes: 500,
    limite_base_conhecimento: 20000, // caracteres
    usuarios_painel: 2,
    recursos: ['Atendimento 24h com IA', 'Base de conhecimento', 'CRM com funil, tarefas e histórico', 'Leads e retornos registrados pela IA', 'Transferência para humano'],
  },
  profissional: {
    id: 'profissional',
    nome: 'Profissional',
    preco_mensal: 897,
    implantacao: 1490,
    conversas_mes: 1500,
    limite_base_conhecimento: 60000,
    usuarios_painel: 5,
    recursos: ['Tudo do Essencial', 'Métricas de conversão do funil', 'Exportação de leads para planilha', 'Aviso de transbordo no WhatsApp do responsável', 'Relatório mensal'],
  },
  premium: {
    id: 'premium',
    nome: 'Premium',
    preco_mensal: 1497,
    implantacao: 1990,
    conversas_mes: 4000,
    limite_base_conhecimento: 150000,
    usuarios_painel: 15,
    recursos: ['Tudo do Profissional', 'Integrações (ERP/CRM)', 'Ajuste fino mensal da IA', 'Suporte prioritário'],
  },
};

export function getPlan(id) {
  return PLANS[id] || PLANS.essencial;
}
