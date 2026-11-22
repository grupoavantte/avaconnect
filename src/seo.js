// SEO e descoberta por IAs: site com dados estruturados, robots.txt, sitemap.xml e llms.txt.
import fs from 'node:fs';
import path from 'node:path';
import { PLANS, MESES_PAGOS_ANUAL } from './plans.js';
import { publicUrl } from './payments.js';

const EMPRESA = {
  nome: 'AVANTTE ASSESSORIA EMPRESARIAL LTDA', marca: 'Avantte', cnpj: '62.699.610/0001-82', email: 'contato@grupoavantte.com.br',
  endereco: { rua: 'Av. Brigadeiro Faria Lima, 1811, sala 1119', bairro: 'Jardim Paulistano', cidade: 'São Paulo', uf: 'SP', cep: '01452-001' },
};
const telSite = () => (process.env.SITE_WHATSAPP || '').replace(/\D/g, '');

/** Perguntas frequentes lidas do próprio site (mesmo texto que o visitante vê). */
function faqDoSite(html) {
  const txt = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  return [...html.matchAll(/<details><summary>(.*?)<\/summary><p>(.*?)<\/p><\/details>/gs)].map((m) => ({ q: txt(m[1]), a: txt(m[2]) }));
}

function jsonLd(base, faq) {
  const planos = Object.values(PLANS);
  const org = {
    '@type': 'Organization', '@id': `${base}/#avantte`, name: EMPRESA.marca, legalName: EMPRESA.nome, url: base, email: EMPRESA.email,
    logo: `${base}/brand/ava-connect-logo.png`, taxID: EMPRESA.cnpj,
    address: { '@type': 'PostalAddress', streetAddress: EMPRESA.endereco.rua, addressLocality: EMPRESA.endereco.cidade, addressRegion: EMPRESA.endereco.uf, postalCode: EMPRESA.endereco.cep, addressCountry: 'BR' },
    ...(telSite() ? { contactPoint: { '@type': 'ContactPoint', telephone: `+${telSite()}`, contactType: 'sales', availableLanguage: 'Portuguese', areaServed: 'BR' } } : {}),
  };
  const app = {
    '@type': 'SoftwareApplication', '@id': `${base}/#ava-connect`, name: 'AVA Connect', applicationCategory: 'BusinessApplication',
    applicationSubCategory: 'Atendimento e vendas com inteligência artificial no WhatsApp', operatingSystem: 'Web',
    inLanguage: 'pt-BR', url: base, image: `${base}/brand/ava-connect-logo-slogan.png`, publisher: { '@id': `${base}/#avantte` },
    description: 'Atendente e vendedora virtual com IA para WhatsApp: atende 24 horas, qualifica, envia proposta, gera cobrança (Pix, boleto, cartão), acompanha até o pagamento e organiza tudo num CRM. Para empresas de qualquer segmento no Brasil.',
    featureList: ['Atendimento com IA no WhatsApp 24h (API oficial da Meta)', 'Proposta e cobrança automáticas', 'CRM com funil de vendas', 'Pix, boleto e cartão via Asaas, Mercado Pago, Pagar.me ou Pix direto',
      'Campanhas com modelos aprovados pela Meta', 'Transferência para atendente humano por setor', 'Pesquisa de satisfação', 'Usuários ilimitados', 'AvaShop: venda de produtos físicos pelo WhatsApp'],
    offers: planos.map((p) => ({ '@type': 'Offer', name: `AVA Connect ${p.nome}`, price: p.preco_mensal, priceCurrency: 'BRL',
      priceSpecification: { '@type': 'UnitPriceSpecification', price: p.preco_mensal, priceCurrency: 'BRL', unitText: 'MONTH', referenceQuantity: { '@type': 'QuantitativeValue', value: 1, unitCode: 'MON' } },
      description: `${p.conversas_mes} conversas por mês. Contrato de 12 meses em 12x ou à vista (12 meses pagando ${MESES_PAGOS_ANUAL()}). Implantação R$ ${p.implantacao}.`, url: `${base}/cadastro?plano=${p.id}`, availability: 'https://schema.org/InStock' })),
  };
  const site = { '@type': 'WebSite', '@id': `${base}/#site`, url: base, name: 'AVA Connect', inLanguage: 'pt-BR', publisher: { '@id': `${base}/#avantte` } };
  const graph = [org, app, site];
  if (faq.length) graph.push({ '@type': 'FAQPage', mainEntity: faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) });
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c');
}

export function rotasSeo(app) {
  const arquivo = path.resolve('public/site.html');
  let cache = null;
  const pagina = () => {
    const base = publicUrl();
    if (cache?.base === base) return cache.html;
    const html = fs.readFileSync(arquivo, 'utf8');
    const out = html.replaceAll('{{BASE}}', base).replace('<!--JSONLD-->', `<script type="application/ld+json">${jsonLd(base, faqDoSite(html))}</script>`);
    cache = { base, html: out };
    return out;
  };
  app.get('/', (_req, res) => res.type('html').set('cache-control', 'public, max-age=300').send(pagina()));

  app.get('/robots.txt', (_req, res) => res.type('text/plain').send(
`User-agent: *
Allow: /
Disallow: /app
Disallow: /api/
Disallow: /entrar
Disallow: /pagar/
Disallow: /proposta/
Disallow: /pix/
Disallow: /webhooks/

# Robôs de IA são bem-vindos no site público
User-agent: GPTBot
Allow: /
User-agent: OAI-SearchBot
Allow: /
User-agent: ChatGPT-User
Allow: /
User-agent: ClaudeBot
Allow: /
User-agent: Claude-SearchBot
Allow: /
User-agent: PerplexityBot
Allow: /
User-agent: Google-Extended
Allow: /

Sitemap: ${publicUrl()}/sitemap.xml
`));

  app.get('/sitemap.xml', (_req, res) => {
    const base = publicUrl(); const hoje = new Date().toISOString().slice(0, 10);
    const urls = [['/', '1.0', 'weekly'], ['/cadastro', '0.8', 'monthly'], ['/llms.txt', '0.5', 'monthly'], ['/termos', '0.3', 'yearly'], ['/privacidade', '0.3', 'yearly']];
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
      urls.map(([u, p, f]) => `  <url><loc>${base}${u}</loc><lastmod>${hoje}</lastmod><changefreq>${f}</changefreq><priority>${p}</priority></url>`).join('\n')}\n</urlset>\n`);
  });

  // Resumo em texto para assistentes de IA (padrão llms.txt).
  app.get('/llms.txt', (_req, res) => {
    const base = publicUrl(); const faq = faqDoSite(fs.readFileSync(arquivo, 'utf8'));
    const brl = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    res.type('text/plain; charset=utf-8').send(`# AVA Connect

> AVA Connect é uma atendente e vendedora virtual com inteligência artificial para WhatsApp, feita no Brasil pela Avantte. Ela atende os clientes 24 horas, entende o que cada um precisa, envia proposta, gera a cobrança (Pix, boleto ou cartão) e acompanha até o pagamento cair, com CRM integrado. Serve para empresas de qualquer segmento: indústria, comércio, serviços, clínicas, escritórios, imobiliárias, escolas e lojas.

## Para quem é
- Empresas que vendem pelo WhatsApp e perdem clientes por demora na resposta, fora do horário ou por falta de acompanhamento.
- Negócios de venda consultiva (orçamento, proposta, negociação), não apenas e-commerce.

## O que faz
- Atende no WhatsApp com a API oficial da Meta, no número que a empresa já usa.
- Responde só com as informações da empresa; quando não sabe, transfere para o setor certo da equipe.
- Faz proposta, respeita o limite de desconto definido pelo dono e pede aprovação acima dele.
- Gera cobrança na conta da própria empresa (Asaas, Mercado Pago, Pagar.me ou Pix direto); o dinheiro não passa pela Avantte.
- Faz follow-up, recupera conversas paradas, dispara campanhas com modelos aprovados pela Meta e mede a satisfação.
- CRM com funil, setores, fila de atendimento, carteira de clientes e usuários ilimitados.
- AvaShop: venda de produtos físicos pelo WhatsApp com frete, pedido, estoque e rastreio.

## Planos (contrato de 12 meses, em 12x ou à vista com ${12 - MESES_PAGOS_ANUAL()} meses grátis)
${Object.values(PLANS).map((p) => `- ${p.nome}: ${brl(p.preco_mensal)}/mês, ${p.conversas_mes.toLocaleString('pt-BR')} conversas por mês, implantação ${brl(p.implantacao)}.`).join('\n')}
- Garantia de 30 dias para cancelar sem multa.

## Perguntas frequentes
${faq.map((f) => `- ${f.q} ${f.a}`).join('\n')}

## Links
- Site: ${base}/
- Contratar: ${base}/cadastro
${telSite() ? `- WhatsApp comercial: https://wa.me/${telSite()}\n` : ''}- Termos de uso: ${base}/termos
- Privacidade: ${base}/privacidade

## Empresa
${EMPRESA.nome} (${EMPRESA.marca}), CNPJ ${EMPRESA.cnpj}, ${EMPRESA.endereco.rua}, ${EMPRESA.endereco.bairro}, ${EMPRESA.endereco.cidade}/${EMPRESA.endereco.uf}. Contato: ${EMPRESA.email}.
`);
  });
}
