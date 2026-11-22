// Teste da cadência de follow-up (roda sem servidor, com banco temporário).
import fs from 'node:fs';
process.env.DB_PATH = `/tmp/ava-cadencia-${Date.now()}.db`;
process.env.VENDAS_FOLLOWUP_MIN = '0,0,0';
process.env.VENDAS_LEMBRETE_PGTO_MIN = '0';
const { db } = await import('../src/db.js');
const v = await import('../src/vendas.js');
const { HANDLERS, rodarJobs } = await import('../src/funil.js');
Object.assign(HANDLERS, v.VENDAS_HANDLERS);
let ok = 0;
const check = (c, m) => { if (!c) { console.error('FALHOU:', m); process.exit(1); } ok++; console.log('ok -', m); };

const tid = db.prepare("INSERT INTO tenants (nome, plano, painel_token, vendas_ativo, desconto_max) VALUES ('Teste', 'profissional', 'tk', 1, 5)").run().lastInsertRowid;
let tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tid);
db.prepare("INSERT INTO products (tenant_id, nome, preco) VALUES (?, 'Nivelador', 5000)").run(tid);
const novoCliente = (tel) => {
  const cid = db.prepare('INSERT INTO contacts (tenant_id, telefone, nome) VALUES (?, ?, ?)').run(tid, tel, 'Ana Souza').lastInsertRowid;
  const conv = db.prepare("INSERT INTO conversations (tenant_id, contact_id, canal) VALUES (?, ?, 'whatsapp')").run(tid, cid).lastInsertRowid;
  db.prepare("INSERT INTO messages (conversation_id, autor, conteudo, criado_em) VALUES (?, 'cliente', 'quero 1 nivelador', datetime('now','-30 hours'))").run(conv);
  return { contact: db.prepare('SELECT * FROM contacts WHERE id = ?').get(cid), conv: db.prepare('SELECT * FROM conversations WHERE id = ?').get(conv) };
};

// Política
check(v.calcularProposta(tenant, { itens: [{ produto: 'Nivelador', quantidade: 2 }], desconto_percentual: 5 }).motivos.length === 0, 'desconto dentro do limite não pede aprovação');
check(v.calcularProposta(tenant, { itens: [{ produto: 'Nivelador', quantidade: 1, preco_unitario: 4000 }] }).motivos.length === 1, 'preço unitário abaixo da tabela conta como desconto');
let erro = ''; try { v.calcularProposta(tenant, { itens: [{ produto: 'Inexistente', quantidade: 1 }] }); } catch (e) { erro = e.message; }
check(/não está no catálogo/.test(erro), 'IA não inventa preço de produto fora do catálogo');

// Follow-up da proposta sem número conectado (simulado) — 3 toques
const a = novoCliente('5511900000001');
await v.criarProposta({ tenant, contact: a.contact, conv: a.conv }, { itens: [{ produto: 'Nivelador', quantidade: 1 }] });
await rodarJobs();
const fups = db.prepare("SELECT * FROM activities WHERE descricao LIKE 'Follow-up %'").all();
check(fups.length === 3, 'três follow-ups da proposta executados');
const ultimaIA = db.prepare("SELECT conteudo FROM messages WHERE conversation_id = ? AND autor = 'ia' ORDER BY id DESC LIMIT 1").get(a.conv.id).conteudo;
check(/encerro|vale até/.test(ultimaIA), 'último follow-up é a mensagem de encerramento');

// Fora da janela de 24h com número conectado e sem modelo aprovado: vira tarefa
db.prepare("UPDATE tenants SET wa_phone_number_id = 'PNID' WHERE id = ?").run(tid);
tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tid);
const b = novoCliente('5511900000002');
await v.criarProposta({ tenant, contact: b.contact, conv: b.conv }, { itens: [{ produto: 'Nivelador', quantidade: 1 }] });
await rodarJobs();
const tarefa = db.prepare("SELECT * FROM activities a JOIN leads l ON l.id = a.lead_id WHERE l.contact_id = ? AND a.tipo = 'tarefa' AND a.descricao LIKE '%fora da janela%'").all(b.contact.id);
check(tarefa.length >= 1, 'fora da janela de 24h sem modelo: cria tarefa para a equipe');

// Com modelo aprovado: envia o modelo
db.prepare("UPDATE tenants SET wa_template_reengajar = 'retomar_atendimento' WHERE id = ?").run(tid);
tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tid);
const r = await v.enviarAoCliente(tenant, b.contact, 'Oi Ana!');
check(r === 'modelo', 'fora da janela com modelo aprovado: envia o modelo da Meta');

// Cobrança: lembrete e vencimento
db.prepare("UPDATE tenants SET wa_phone_number_id = NULL WHERE id = ?").run(tid);
tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tid);
const c = novoCliente('5511900000003');
await v.criarProposta({ tenant, contact: c.contact, conv: c.conv }, { itens: [{ produto: 'Nivelador', quantidade: 1 }] });
const p = db.prepare("SELECT * FROM proposals WHERE contact_id = ? AND status = 'enviada'").get(c.contact.id);
const g = await v.gerarCobranca(tenant, c.contact, p, { forma: 'boleto' });
check(g.charge && g.charge.valor === 5000, 'cobrança gerada');
await rodarJobs();
check(db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id = ? AND conteudo LIKE '%lembrando do pagamento%'").get(c.conv.id).n === 1, 'lembrete de pagamento enviado');
check(db.prepare("SELECT COUNT(*) n FROM activities WHERE descricao LIKE 'Follow-up %' AND lead_id = (SELECT id FROM leads WHERE contact_id = ?)").get(c.contact.id).n === 0, 'aceite cancela os follow-ups da proposta');
await v.cobrancaVencida(db.prepare('SELECT * FROM charges WHERE id = ?').get(g.charge.id));
check(db.prepare('SELECT status FROM charges WHERE id = ?').get(g.charge.id).status === 'vencido', 'cobrança vencida avisada ao cliente');

fs.rmSync(process.env.DB_PATH, { force: true });
console.log(`\n${ok} verificações da cadência passaram.`);
