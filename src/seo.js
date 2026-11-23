// SEO e descoberta por IAs: site com dados estruturados, robots.txt, sitemap.xml e llms.txt.
import fs from 'node:fs';
import path from 'node:path';
import { PLANS, MESES_PAGOS_ANUAL } from './plans.js';
import { publicUrl } from './payments.js';
import { tokenChatAvantte, tokenFormAvantte } from './canais.js';

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

const PRODUTOS = [
  { id: 'manager', nome: 'AVA Manager', sub: 'Sistema de gestão empresarial (ERP) com inteligência artificial, dividido em departamentos',
    desc: 'Sistema de gestão com IA por departamentos (financeiro, comercial, e-commerce, marketing, compras, estoque, produção, RH e jurídico), com um Consultor IA que analisa a empresa e o mercado e sugere ações. A empresa contrata só os departamentos que usa.' },
  { id: 'ponto', nome: 'AVA Ponto', sub: 'Ponto eletrônico com reconhecimento facial e inteligência artificial',
    desc: 'Ponto eletrônico por reconhecimento facial num celular fixado na parede da empresa (totem AVA Ponto), sem digitar nada; espelho do mês, horas extras, banco de horas e alertas para o gestor no WhatsApp. Em adequação à Portaria 671 (REP-P).' },
];
function jsonLdProduto(base, p, faq) {
  const graph = [{ '@type': 'SoftwareApplication', '@id': `${base}/${p.id}#app`, name: p.nome, applicationCategory: 'BusinessApplication', applicationSubCategory: p.sub,
    operatingSystem: 'Web', inLanguage: 'pt-BR', url: `${base}/${p.id}`, description: p.desc, publisher: { '@id': `${base}/#avantte` },
    offers: { '@type': 'Offer', url: `${base}/${p.id}#contratar`, priceCurrency: 'BRL', availability: 'https://schema.org/PreOrder', description: 'Preço sob proposta' } }];
  if (faq.length) graph.push({ '@type': 'FAQPage', mainEntity: faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) });
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c');
}
function jsonLdDivisao(base) {
  const org = { '@type': 'Organization', '@id': `${base}/#avantte`, name: EMPRESA.marca, legalName: EMPRESA.nome, url: base, email: EMPRESA.email, logo: `${base}/brand/ava-connect-logo.png`, taxID: EMPRESA.cnpj,
    department: { '@type': 'Organization', name: 'AVA Connect', description: 'Divisão de tecnologia da Avantte: sistemas com inteligência artificial para empresas.' } };
  const itens = [{ name: 'AVA Talk', url: `${base}/talk` }, ...PRODUTOS.map((p) => ({ name: p.nome, url: `${base}/${p.id}` }))];
  const lista = { '@type': 'ItemList', name: 'Produtos AVA Connect', itemListElement: itens.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, url: it.url })) };
  const site = { '@type': 'WebSite', '@id': `${base}/#site`, url: base, name: 'AVA Connect', inLanguage: 'pt-BR', publisher: { '@id': `${base}/#avantte` } };
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': [org, site, lista] }).replace(/</g, '\\u003c');
}

// Envio dos formulários de contratação (AVA Manager e AVA Ponto): vira negócio no CRM da Avantte e a AVA chama no WhatsApp.
const FORM_SCRIPT = (tk) => `<script>
(function(){
  var f=document.getElementById('fContratar'); if(!f) return;
  var msg=document.getElementById('fMsg');
  f.addEventListener('submit',function(e){
    e.preventDefault();
    var g=function(n){var el=f.elements[n];return el?String(el.value||'').trim():'';};
    if(!g('nome')||!g('whatsapp')||!g('empresa')){msg.className='msg erro';msg.textContent='Preencha nome, WhatsApp e empresa.';return;}
    if(g('whatsapp').replace(/\\D/g,'').length<10){msg.className='msg erro';msg.textContent='Confira o WhatsApp com DDD.';return;}
    var marcados=[].slice.call(f.querySelectorAll('input[name=dep]:checked')).map(function(i){return i.value;});
    var produto=f.getAttribute('data-produto');
    var partes=['Quero contratar o '+produto+'.'];
    if(marcados.length) partes.push((produto==='AVA Ponto'?'Marcação: ':'Departamentos: ')+marcados.join(', ')+'.');
    if(g('funcionarios')) partes.push('Funcionários: '+g('funcionarios')+'.');
    if(g('usuarios')) partes.push('Usuários: '+g('usuarios')+'.');
    if(g('obs')) partes.push(g('obs'));
    var dados={nome:g('nome'),whatsapp:g('whatsapp'),email:g('email'),empresa:g('empresa'),mensagem:partes.join(' '),produto:produto,
      consentimento:f.elements.consentimento&&f.elements.consentimento.checked?'sim':'',_hp:g('_hp')};
    var b=f.querySelector('button[type=submit]'); b.disabled=true; msg.className='msg'; msg.textContent='Enviando...';
    ${tk ? `fetch('/f/${tk}',{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify(dados)})
      .then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.erro||'erro');return j;});})
      .then(function(){f.reset();msg.className='msg ok';msg.textContent='Recebemos seu pedido! A AVA vai chamar você no WhatsApp com a proposta.';})
      .catch(function(){b.disabled=false;msg.className='msg erro';msg.textContent='Não conseguimos enviar agora. Tente de novo ou escreva para contato@grupoavantte.com.br.';});`
    : `location.href='mailto:contato@grupoavantte.com.br?subject='+encodeURIComponent('Contratar '+produto)+'&body='+encodeURIComponent(dados.mensagem+'\\n'+dados.nome+' · '+dados.empresa+' · '+dados.whatsapp);b.disabled=false;msg.textContent='';`}
  });
})();
</script>`;

function jsonLd(base, faq) {
  const planos = Object.values(PLANS);
  const org = {
    '@type': 'Organization', '@id': `${base}/#avantte`, name: EMPRESA.marca, legalName: EMPRESA.nome, url: base, email: EMPRESA.email,
    logo: `${base}/brand/ava-connect-logo.png`, taxID: EMPRESA.cnpj,
    address: { '@type': 'PostalAddress', streetAddress: EMPRESA.endereco.rua, addressLocality: EMPRESA.endereco.cidade, addressRegion: EMPRESA.endereco.uf, postalCode: EMPRESA.endereco.cep, addressCountry: 'BR' },
    ...(telSite() ? { contactPoint: { '@type': 'ContactPoint', telephone: `+${telSite()}`, contactType: 'sales', availableLanguage: 'Portuguese', areaServed: 'BR' } } : {}),
  };
  const app = {
    '@type': 'SoftwareApplication', '@id': `${base}/talk#app`, name: 'AVA Talk', alternateName: 'AVA Connect', applicationCategory: 'BusinessApplication',
    applicationSubCategory: 'Atendimento e vendas com inteligência artificial no WhatsApp', operatingSystem: 'Web',
    inLanguage: 'pt-BR', url: `${base}/talk`, image: `${base}/brand/ava-connect-logo-slogan.png`, publisher: { '@id': `${base}/#avantte` },
    description: 'Atendente e vendedora virtual com IA para WhatsApp: atende 24 horas, qualifica, envia proposta, gera cobrança (Pix, boleto, cartão), acompanha até o pagamento e organiza tudo num CRM. Para empresas de qualquer segmento no Brasil.',
    featureList: ['Atendimento com IA no WhatsApp 24h (API oficial da Meta)', 'Proposta e cobrança automáticas', 'CRM com funil de vendas', 'Pix, boleto e cartão via Asaas, Mercado Pago, Pagar.me ou Pix direto',
      'Campanhas com modelos aprovados pela Meta', 'Transferência para atendente humano por setor', 'Pesquisa de satisfação', 'Usuários ilimitados', 'AvaShop: venda de produtos físicos pelo WhatsApp'],
    offers: planos.map((p) => ({ '@type': 'Offer', name: `AVA Talk ${p.nome}`, price: p.preco_mensal, priceCurrency: 'BRL',
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
  const baseCss = () => fs.readFileSync(path.resolve('public/ava-base.css'), 'utf8');
  const cache = new Map();
  // Monta a página: endereço, dados estruturados, estilos comuns, chat da AVA e formulário de contratação.
  const montar = (nome, ld) => {
    const base = publicUrl(); const chat = tokenChatAvantte(); const form = tokenFormAvantte();
    const chave = `${nome}|${base}|${chat}|${form}`;
    if (cache.has(chave)) return cache.get(chave);
    const html = fs.readFileSync(path.resolve(`public/${nome}`), 'utf8');
    let out = html.replaceAll('{{BASE}}', base).replace('<!--JSONLD-->', `<script type="application/ld+json">${ld(base, faqDoSite(html))}</script>`)
      .replace('<!--BASECSS-->', baseCss()).replace('<!--FORMSCRIPT-->', FORM_SCRIPT(form));
    // A própria AVA atende no site (chat da Avantte): com o chat ligado, ele é o único botão de contato.
    if (chat) out = out.replace('class="wa-flut js-wa"', 'class="wa-flut js-wa com-chat"').replace('</body>', `<script src="/w/${chat}.js" async></script>\n</body>`);
    cache.set(chave, out);
    return out;
  };
  const servir = (rota, nome, ld) => app.get(rota, (_req, res) => res.type('html').set('cache-control', 'public, max-age=300').send(montar(nome, ld)));
  servir('/', 'divisao.html', (b) => jsonLdDivisao(b));
  servir('/talk', 'site.html', (b, faq) => jsonLd(b, faq));
  for (const p of PRODUTOS) servir(`/${p.id}`, `${p.id}.html`, (b, faq) => jsonLdProduto(b, p, faq));
  // Nomes alternativos levam à página certa.
  for (const [de, para] of [['/ava-talk', '/talk'], ['/ava-manager', '/manager'], ['/ava-ponto', '/ponto'], ['/gestao', '/manager']]) app.get(de, (_req, res) => res.redirect(301, para));

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
    const urls = [['/', '1.0', 'weekly'], ['/talk', '0.9', 'weekly'], ['/manager', '0.9', 'weekly'], ['/ponto', '0.9', 'weekly'], ['/cadastro', '0.8', 'monthly'], ['/llms.txt', '0.5', 'monthly'], ['/termos', '0.3', 'yearly'], ['/privacidade', '0.3', 'yearly']];
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
      urls.map(([u, p, f]) => `  <url><loc>${base}${u}</loc><lastmod>${hoje}</lastmod><changefreq>${f}</changefreq><priority>${p}</priority></url>`).join('\n')}\n</urlset>\n`);
  });

  // Resumo em texto para assistentes de IA (padrão llms.txt).
  app.get('/llms.txt', (_req, res) => {
    const base = publicUrl(); const faq = faqDoSite(fs.readFileSync(arquivo, 'utf8'));
    const brl = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    res.type('text/plain; charset=utf-8').send(`# AVA Connect

> AVA Connect é a divisão de tecnologia da Avantte, com três sistemas que usam a mesma inteligência artificial (a AVA):
> - AVA Talk (${base}/talk): atendimento e vendas com IA no WhatsApp, chat do site, formulários e e-mail.
> - AVA Manager (${base}/manager): ${PRODUTOS[0].desc}
> - AVA Ponto (${base}/ponto): ${PRODUTOS[1].desc}
> AVA Manager e AVA Ponto são contratados por proposta, pelo formulário de cada página.

# AVA Talk

> AVA Talk é uma atendente e vendedora virtual com inteligência artificial para WhatsApp, feita no Brasil pela Avantte. Ela atende os clientes 24 horas, entende o que cada um precisa, envia proposta, gera a cobrança (Pix, boleto ou cartão) e acompanha até o pagamento cair, com CRM integrado. Serve para empresas de qualquer segmento: indústria, comércio, serviços, clínicas, escritórios, imobiliárias, escolas e lojas.

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
- AVA Talk: ${base}/talk (contratar: ${base}/cadastro)
- AVA Manager: ${base}/manager
- AVA Ponto: ${base}/ponto
${telSite() ? `- WhatsApp comercial: https://wa.me/${telSite()}\n` : ''}- Termos de uso: ${base}/termos
- Privacidade: ${base}/privacidade

## Empresa
${EMPRESA.nome} (${EMPRESA.marca}), CNPJ ${EMPRESA.cnpj}, ${EMPRESA.endereco.rua}, ${EMPRESA.endereco.bairro}, ${EMPRESA.endereco.cidade}/${EMPRESA.endereco.uf}. Contato: ${EMPRESA.email}.
`);
  });
}
