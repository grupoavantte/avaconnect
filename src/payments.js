// Pagamentos via Asaas. Sem ASAAS_API_KEY, roda em modo de teste com uma página de pagamento simulada.
const KEY = process.env.ASAAS_API_KEY;
const BASE = process.env.ASAAS_BASE_URL || 'https://api.asaas.com/v3'; // sandbox: https://api-sandbox.asaas.com/v3
export const PAY_MODE = KEY ? 'asaas' : 'teste';
// Em produção (Render), o pagamento simulado fica bloqueado: o cliente nunca vê o botão "simular pagamento".
export const SIMULADO_LIBERADO = process.env.PAGAMENTO_SIMULADO === '1' || !process.env.RENDER;

export const publicUrl = () =>
  (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

export async function asaas(path, body, key = KEY) {
  const res = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', access_token: key, 'user-agent': 'ava-connect' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Asaas ${res.status}: ${JSON.stringify(data.errors || data)}`);
  return data;
}

/** Cria o link de pagamento do diagnóstico. Retorna { ref, url }. */
export async function criarCobrancaDiagnostico(tenant, diag) {
  if (PAY_MODE === 'teste' && !SIMULADO_LIBERADO) throw new Error('Asaas não configurado');
  if (PAY_MODE === 'teste') return { ref: `teste-${diag.id}`, url: `${publicUrl()}/pagar/${diag.token}` };
  const link = await asaas('/paymentLinks', {
    name: `Diagnóstico Empresarial — ${tenant.nome}`,
    description: 'Relatório completo do diagnóstico: situação das 10 áreas, melhorias e plano de 90 dias.',
    value: Number(diag.valor),
    billingType: 'UNDEFINED',          // cliente escolhe Pix, boleto ou cartão
    chargeType: 'DETACHED',
    dueDateLimitDays: 3,
    externalReference: diag.token,
    notificationEnabled: false,
    callback: { successUrl: `${publicUrl()}/relatorio/${diag.token}`, autoRedirect: true },
  });
  return { ref: link.id, url: link.url };
}

import { gatewayDe, configGateway, criarNoGateway } from './gateways.js';

// Chave Asaas de cada empresa: o dinheiro das vendas do cliente cai na conta Asaas DELE.
// A chave global (ASAAS_API_KEY) só vale para a empresa da própria Avantte (ASAAS_TENANT_ID, padrão 1).
export function chaveAsaas(tenant) {
  if (tenant.gateway === 'asaas' && configGateway(tenant).api_key) return configGateway(tenant).api_key;
  if (tenant.asaas_api_key) return tenant.asaas_api_key;
  if (KEY && tenant.id === Number(process.env.ASAAS_TENANT_ID || 1)) return KEY;
  return null;
}
/** Gateway que a empresa usa para receber: asaas | mercadopago | pagarme | pix; ou 'teste' / 'sem_conta'. */
export const modoPagamento = (tenant) => gatewayDe(tenant, chaveAsaas(tenant)) || (PAY_MODE === 'teste' && SIMULADO_LIBERADO ? 'teste' : 'sem_conta');

/**
 * Cria um link de pagamento genérico (vendas). forma: pix | boleto | cartao | livre.
 * Retorna { ref, url } ou lança erro. Em modo teste, devolve a página simulada /pagar/<token>.
 */
export async function criarCobranca(tenant, { token, valor, descricao, forma = 'livre', parcelas = 1, vencimentoDias = 3, cliente = {} }) {
  const modo = modoPagamento(tenant);
  if (modo === 'teste') return { ref: `teste-${token}`, url: `${publicUrl()}/pagar/${token}`, gateway: 'teste' };
  if (modo === 'sem_conta') throw new Error('Empresa sem forma de recebimento configurada (Configurações → Conexões → Recebimentos)');
  if (modo !== 'asaas') {
    const r = await criarNoGateway(modo, configGateway(tenant), { token, valor, descricao, forma, parcelas, vencimentoDias, cliente },
      { base: publicUrl(), obrigado: `${publicUrl()}/obrigado/${token}`, webhook: `${publicUrl()}/webhooks/${modo}/${tenant.id}` });
    return { ...r, gateway: modo };
  }
  const billingType = { pix: 'PIX', boleto: 'BOLETO', cartao: 'CREDIT_CARD' }[forma] || 'UNDEFINED';
  const body = {
    name: descricao.slice(0, 120), description: descricao.slice(0, 500), value: Number(valor.toFixed(2)),
    billingType, chargeType: billingType === 'CREDIT_CARD' && parcelas > 1 ? 'INSTALLMENT' : 'DETACHED',
    dueDateLimitDays: vencimentoDias, externalReference: token, notificationEnabled: false,
    callback: { successUrl: `${publicUrl()}/obrigado/${token}`, autoRedirect: true },
  };
  if (body.chargeType === 'INSTALLMENT') body.maxInstallmentCount = Math.max(1, Math.min(21, parcelas));
  const link = await asaas('/paymentLinks', body, chaveAsaas(tenant));
  return { ref: link.id, url: link.url, gateway: 'asaas' };
}

/** Lê o webhook do Asaas e devolve { pago, ref, externalReference } ou null. */
// tokensAceitos: tokens válidos para esta chamada (global + o da empresa dona da cobrança).
export function lerWebhookAsaas(req, tokensAceitos = [process.env.ASAAS_WEBHOOK_TOKEN]) {
  const aceitos = tokensAceitos.filter(Boolean);
  if (aceitos.length && !aceitos.includes(req.get('asaas-access-token'))) return { recusado: true };
  const { event, payment } = req.body || {};
  if (!payment) return null;
  const base = { ref: payment.paymentLink || null, externalReference: payment.externalReference || null, valor: payment.value, id: payment.id,
    invoiceUrl: payment.invoiceUrl || null };
  if (['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'].includes(event)) return { ...base, pago: true };
  if (event === 'PAYMENT_OVERDUE') return { ...base, vencido: true };
  return null;
}
