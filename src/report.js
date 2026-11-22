// Páginas públicas do diagnóstico: relatório completo (após pagamento) e página de pagamento de teste.
import { dadosRelatorio } from './diagnostico.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dataBR = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '');

const CSS = `
:root{--bg:#f3f6fb;--paper:#fff;--ink:#0b1630;--muted:#55627d;--line:#dde4ef;--brand:#071430;--teal:#0aa89a;
--crit:#c93838;--crit-bg:#fdecec;--warn:#b7791f;--warn-bg:#fdf3df;--ok:#178a5b;--ok-bg:#e3f6ec}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 Inter,system-ui,sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:24px max(16px,env(safe-area-inset-left))}
header.top{background:var(--brand);color:#fff;padding:28px 0 72px;background-image:radial-gradient(700px 300px at 0 0,rgba(18,216,196,.25),transparent),radial-gradient(700px 300px at 100% 100%,rgba(31,111,255,.3),transparent)}
.brandline{display:flex;align-items:center;gap:10px;font-family:Montserrat,Inter,sans-serif;font-size:14px;letter-spacing:.3px;opacity:.9}
.brandline img{width:26px}
h1{font-family:Montserrat,Inter,sans-serif;font-size:28px;margin:18px 0 4px;text-wrap:balance}
.sub{opacity:.8}
.card{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:22px;margin-top:16px}
.hero{margin-top:-56px;display:grid;grid-template-columns:auto 1fr;gap:24px;align-items:center}
.gauge{width:140px;height:140px;border-radius:50%;display:grid;place-items:center;background:conic-gradient(var(--teal) calc(var(--v)*1%),#e6ebf3 0)}
.gauge div{width:108px;height:108px;border-radius:50%;background:var(--paper);display:grid;place-items:center;text-align:center}
.gauge b{font-size:34px;line-height:1;font-variant-numeric:tabular-nums}.gauge small{color:var(--muted);font-size:12px}
h2{font-size:18px;margin:0 0 10px}
.bars{display:grid;gap:8px}
.bar{display:grid;grid-template-columns:minmax(0,220px) 1fr 40px;gap:10px;align-items:center;font-size:14px}
.bar .t{height:10px;background:#e6ebf3;border-radius:6px;overflow:hidden}.bar .t i{display:block;height:100%}
.bar span:last-child{text-align:right;font-variant-numeric:tabular-nums;font-weight:600}
.critico i,.pill.critico{background:var(--crit)}.atencao i,.pill.atencao{background:var(--warn)}.bom i,.pill.bom{background:var(--ok)}
.pill{color:#fff;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600}
.area{border-left:4px solid var(--line)}
.area.critico{border-left-color:var(--crit)}.area.atencao{border-left-color:var(--warn)}.area.bom{border-left-color:var(--ok)}
.area-head{display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap}
.resp{color:var(--muted);font-size:13px;margin:6px 0 10px}
ul{margin:8px 0 0;padding-left:20px}li{margin:3px 0}
.plan{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.phase{background:var(--bg);border-radius:10px;padding:14px}.phase b{display:block}.phase small{color:var(--muted)}
.cta{background:var(--brand);color:#fff;border:0}.cta a{color:#19e0c9;font-weight:700}
.note{color:var(--muted);font-size:12px;margin:24px 0}
.btn{display:inline-block;background:linear-gradient(90deg,#1f6fff,#12d8c4);color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px;border:0;font:inherit;cursor:pointer}
@media (max-width:640px){.hero{grid-template-columns:1fr;justify-items:center;text-align:center}.plan{grid-template-columns:1fr}.bar{grid-template-columns:1fr 1fr 36px}}
@media print{header.top{padding-bottom:30px}.hero{margin-top:0}.card{break-inside:avoid}}`;

function pagina(titulo, corpo) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titulo)}</title><link rel="icon" href="/brand/favicon.png">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Montserrat:wght@700;800&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body>${corpo}</body></html>`;
}

export function paginaRelatorio(diag, tenant, contact) {
  if (diag.status !== 'pago') {
    return pagina('Relatório aguardando pagamento', `<div class="wrap"><div class="card" style="text-align:center;margin-top:40px">
      <h2>Seu relatório está quase pronto</h2><p>Ele é liberado assim que o pagamento for confirmado.</p>
      ${diag.pagamento_url ? `<p><a class="btn" href="${esc(diag.pagamento_url)}">Pagar ${brl(diag.valor)}</a></p>` : ''}</div></div>`);
  }
  const d = dadosRelatorio(diag);
  const nomeEmpresa = contact.nome ? `Empresa de ${contact.nome}` : 'Sua empresa';
  const ordem = [...d.areas].sort((a, b) => a.nota - b.nota);
  return pagina(`Diagnóstico Empresarial — ${tenant.nome}`, `
<header class="top"><div class="wrap">
  <div class="brandline"><img src="/brand/simbolo.webp" alt=""> ${esc(tenant.nome)} · Diagnóstico Empresarial</div>
  <h1>Relatório completo do diagnóstico</h1>
  <div class="sub">${esc(nomeEmpresa)} · ${esc(d.contexto.segmento || '')} · ${esc(d.contexto.faturamento || '')} · equipe ${esc(d.contexto.equipe || '')} · ${dataBR(diag.pago_em)}</div>
</div></header>
<main class="wrap">
  <section class="card hero">
    <div class="gauge" style="--v:${diag.nota_geral}"><div><span><b>${diag.nota_geral}</b><br><small>de 100</small></span></div></div>
    <div><h2>Nota geral da empresa</h2>
      <p>${esc(d.ia?.resumo || `A empresa tem ${d.areas.filter((a) => a.nivel === 'critico').length} área(s) em nível crítico e ${d.areas.filter((a) => a.nivel === 'atencao').length} em atenção. As prioridades são ${d.prioridades.map((p) => p.nome.toLowerCase()).join(', ')}.`)}</p></div>
  </section>

  <section class="card"><h2>Nota por área</h2><div class="bars">
    ${ordem.map((a) => `<div class="bar ${a.nivel}"><span>${esc(a.nome)}</span><span class="t"><i style="width:${Math.max(a.nota, 3)}%"></i></span><span>${a.nota}</span></div>`).join('')}
  </div><p class="note" style="margin:12px 0 0">Crítico: abaixo de 40 · Atenção: de 40 a 69 · Bom: 70 ou mais</p></section>

  ${d.ia ? `<section class="card"><h2>Riscos se nada mudar</h2><ul>${d.ia.riscos.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    <h2 style="margin-top:18px">Ganhos rápidos em 30 dias</h2><ul>${d.ia.oportunidades.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></section>` : ''}

  <h2 style="margin:28px 0 0">Situação e melhorias por área</h2>
  ${ordem.map((a) => `<section class="card area ${a.nivel}">
    <div class="area-head"><h2 style="margin:0">${esc(a.nome)}</h2><span class="pill ${a.nivel}">${a.nivel_nome} · ${a.nota}</span></div>
    <div class="resp">Sua resposta: “${esc(a.resposta)}”</div>
    <p><b>Situação:</b> ${esc(a.situacao)}</p>
    <b>Melhorias recomendadas</b><ul>${a.melhorias.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>
  </section>`).join('')}

  <section class="card"><h2>Plano de ação de 90 dias</h2><div class="plan">
    ${d.plano.map((f) => `<div class="phase"><small>${f.fase}</small><b>${esc(f.foco)}</b><ul>${f.acoes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`).join('')}
  </div></section>

  <section class="card cta"><h2>Quer ajuda para colocar o plano em prática?</h2>
    <p>Nossa equipe faz uma <b>reunião gratuita</b> para montar com você o plano de implantação dessas melhorias.
    ${tenant.link_agendamento ? `<br><a href="${esc(tenant.link_agendamento)}">Agendar minha reunião gratuita →</a>` : ' Responda no WhatsApp para agendar.'}</p></section>

  <p class="note">Este diagnóstico é uma análise de gestão baseada nas respostas informadas. Não substitui parecer contábil, jurídico ou tributário.
  Para salvar em PDF, use a opção Imprimir do seu navegador.</p>
</main>`);
}

export function paginaPagamentoTeste(diag) {
  return pagina('Pagamento (modo de teste)', `<div class="wrap"><div class="card" style="margin-top:40px;text-align:center">
    <h2>Diagnóstico Empresarial — ${brl(diag.valor)}</h2>
    <p>Esta é a página de pagamento do <b>modo de teste</b>. Com o Asaas configurado, o cliente vê aqui o checkout com Pix e cartão.</p>
    ${diag.status === 'pago' ? `<p>Pagamento já confirmado. <a href="/relatorio/${diag.token}">Ver relatório</a></p>` :
      `<form method="post" action="/pagar/${diag.token}/simular"><button class="btn" type="submit">Simular pagamento aprovado</button></form>`}
  </div></div>`);
}
export { pagina, esc, brl, dataBR };
