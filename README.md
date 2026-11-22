# AVA Connect

Produto da **Avantte** (grupoavantte.com.br). Contato: contato@grupoavantte.com.br

Atendimento com IA no WhatsApp para várias empresas ao mesmo tempo (produto Avantte).

## O que faz

- **Atende no WhatsApp 24h** usando Claude, respondendo apenas com a base de conhecimento de cada empresa.
- **Registra leads sozinho** no CRM interno (novo → qualificado → proposta → fechado/perdido).
- **Transfere para humano** quando o cliente pede, reclama, negocia ou a resposta não está na base. Avisa o responsável pelo WhatsApp e a IA fica em silêncio na conversa.
- **Painel web** com conversas em tempo real, resposta como atendente, CRM em colunas, simulador e configuração da IA.
- **Várias empresas, dados separados.** O token de administrador Avantte vê tudo. Cada empresa cliente recebe o próprio token e vê só os seus dados. O cliente não altera plano nem conexão.
- **Planos e limites:** Essencial R$497, Profissional R$897 e Premium R$1.497, com cota de conversas por mês e limite de base de conhecimento. O painel mostra o MRR.

## Endereços

- `/` — site público do AVA Connect (planos, como funciona, dúvidas, botão para falar com a AVA).
- `/entrar` — login com e-mail e senha (recuperar senha e acesso por token).
- `/cadastro` — contratação sozinha: escolhe o plano, cria a conta (dono) e paga implantação + 1ª mensalidade na conta Asaas da Avantte. A venda entra no CRM da empresa Avantte. Ao confirmar o pagamento, a conta é ativada e a assinatura mensal é criada no Asaas. Mensalidade vencida: aviso; após `INADIMPLENCIA_DIAS` (7) a assistente é pausada; pagou, volta sozinha.
- `/termos` e `/privacidade` — rascunhos para revisão jurídica.
- `/app` — painel. No primeiro acesso, o dono ou gestor cai no **Configurar minha empresa**: passo a passo com empresa, perguntas guiadas sobre o negócio (viram a base de conhecimento), assistente (nome, função e jeito de falar), produtos e limites de negociação, WhatsApp, Asaas, equipe e teste.

## AvaShop (a IA vendendo produto sozinha)

Habilidade **Loja** no agente (planos Profissional e Premium). A IA envia as fotos do produto no WhatsApp, mostra opções (tamanho, cor) e estoque, calcula o frete pelo CEP (Melhor Envio, entrega própria por faixa de CEP, retirada, frete grátis acima de um valor), pede endereço/CPF, cria o pedido e envia o link de pagamento (Asaas do lojista) com o aviso do direito de arrependimento. Pago: baixa o estoque, confirma ao cliente, avisa o lojista, coloca a etiqueta no carrinho do Melhor Envio (ou compra e gera sozinha, se ligado) e acompanha o rastreio, avisando envio e entrega. Vitrine pública em `/loja/<endereço>` com botão "Comprar pelo WhatsApp". Painel: Vendas → Pedidos da loja, Loja (AvaShop) e Catálogo → Fotos e opções.

**Passagem entre agentes:** com mais de um agente, a IA passa a conversa para o agente certo (ex.: Recepção → Loja), que responde na mesma hora.

## WhatsApp pelo botão da Meta

Em Configurações → Conexões (e no passo a passo), o dono clica em **Conectar WhatsApp com o Facebook**: entra com o Facebook da empresa, escolhe ou cria a conta do WhatsApp Business e confirma o número. O sistema troca o código por um token, inscreve o app nos webhooks da conta e registra o número (com PIN de 2 etapas). Opção de **coexistência** para manter o app WhatsApp Business funcionando no celular. Requer `META_APP_ID`, `META_APP_SECRET` e `META_ES_CONFIG_ID` (app da Avantte aprovado como Tech Provider). A conexão manual continua disponível.

## Atende qualquer segmento

- **Áudio:** áudios do WhatsApp são transcritos (`TRANSCRICAO_API_KEY`) e a IA responde por texto. Sem a chave, a IA pede com gentileza que o cliente escreva.
- **Fotos e PDFs:** a IA vê a imagem ou o documento enviado (ex.: foto de uma peça, um orçamento). Localização vira texto.
- **Modelos por segmento** (`src/segmentos.js`): indústria, distribuidor, comércio, restaurante, serviços, saúde, advocacia, contabilidade, imobiliária, educação, tecnologia e outro. Cada um traz o jeito de atender, o tom, as habilidades e as **regras obrigatórias do setor** (ex.: saúde nunca dá diagnóstico e orienta emergência; advocacia segue a OAB e não promete resultado; comércio informa o direito de arrependimento). Aplicado no cadastro e no passo a passo.

## Produto: plataforma, empresas, usuários, agentes e conexões

- **Plataforma (Avantte):** usuários com papel *plataforma* veem todas as empresas. Em **Empresas**, o cadastro completo cria a empresa, os agentes iniciais e o convite do dono (link para criar a senha). O `ADMIN_TOKEN` continua funcionando como acesso de emergência.
- **A Avantte é uma empresa cliente** como qualquer outra. Na primeira inicialização, `src/seed.js` cria a empresa Avantte (plano Premium) com o agente AVA (vendas + diagnóstico + agenda), o catálogo com os planos e implantações do AVA Connect, a base de conhecimento e o convite do usuário da plataforma (`PLATAFORMA_EMAIL`). Nada é sobrescrito se já existir.
- **Usuários e papéis:** login com e-mail e senha, convite por e-mail ou link, redefinição de senha, bloqueio após tentativas erradas. *Dono*: tudo, inclusive usuários e conexões. *Gestor*: configura IA e catálogo, aprova descontos. *Atendente*: conversas, CRM e tarefas. Limite de usuários pelo plano.
- **Agentes:** cada empresa tem um ou mais agentes (Recepção, Vendas, Pós-venda, Diagnóstico), com nome, função, instruções e habilidades próprias. Limite pelo plano; vendas a partir do Profissional; IA avançada no Premium.
- **Conexões:** vários números de WhatsApp por empresa, cada um ligado a um agente (o webhook roteia pelo número), teste de conexão com a Meta, conta Asaas própria do cliente com teste, e-mail e modelos aprovados da Meta.
- **Início:** roteiro de implantação com o progresso de cada empresa.

## Agente de vendas (do atendimento ao pagamento)

Ligue em **Vendas → Configuração**. A IA passa a vender sozinha:

1. **Atende e qualifica** (necessidade, quantidade, prazo, cidade) e registra no CRM.
2. **Monta a proposta** com o catálogo (Vendas → Catálogo) e envia no WhatsApp e por e-mail, com página para aprovar e pagar (`/proposta/<token>`).
3. **Negocia dentro da política**: desconto máximo da IA, desconto à vista, parcelas e preço mínimo por produto. Acima disso, pede aprovação ao gestor, que responde **APROVAR 12** ou **RECUSAR 12** no WhatsApp ou aprova no painel.
4. **Cobra**: gera o link Asaas (Pix, boleto ou cartão parcelado) na conta Asaas de cada cliente. O webhook confirma o pagamento, fecha o lead e envia a mensagem de pós-venda.
5. **Faz follow-up sozinha**: retoma conversa parada (22h), cobra a proposta (D+1, D+3, D+6), lembra pagamento (D+1, D+3), avisa vencimento e retoma no dia combinado com o cliente.
6. **Agenda reuniões** nos horários livres e manda lembrete na véspera e 1h antes.
7. **Registra perdas** com o motivo e encerra os follow-ups.

Fora da janela de 24h do WhatsApp, a IA usa o modelo aprovado na Meta (`wa_template_reengajar`). Sem modelo, cria uma tarefa com a mensagem sugerida.

## Rodar localmente

```bash
npm install
cp .env.example .env   # opcional
ADMIN_TOKEN=um-token-forte npm start
# abra http://localhost:3000 e entre com o ADMIN_TOKEN
npm test               # com o servidor rodando (VENDAS_REENGAJAR_MIN=0): ponta a ponta + vendas
npm run test:cadencia  # sem servidor: cadência de follow-up
```

Sem `ANTHROPIC_API_KEY`, a IA roda em **modo demonstração** (regras simples). Serve para testar o painel e o fluxo.

## Publicar (Render)

1. Suba esta pasta para um repositório no GitHub.
2. No Render, use **New → Blueprint** e aponte para o repositório. O `render.yaml` cria o serviço com um disco persistente para o banco.
3. Preencha `ANTHROPIC_API_KEY` e `WA_APP_SECRET`. O `ADMIN_TOKEN` e o `WA_VERIFY_TOKEN` são gerados automaticamente (veja em Environment).

## Conectar o WhatsApp (Meta Cloud API)

1. Em developers.facebook.com, crie um app do tipo Business e adicione o produto **WhatsApp**.
2. Em Webhooks, use a URL de callback `https://SEU-DOMINIO/webhooks/whatsapp`, coloque o `WA_VERIFY_TOKEN` e assine o campo `messages`.
3. Para cada empresa cliente, cadastre o **Phone Number ID** e um **token permanente** (usuário do sistema) em *Configurar IA → Conexão WhatsApp*.
4. Avisos ao responsável fora da janela de 24h exigem um modelo de mensagem aprovado pela Meta. Por enquanto, o responsável precisa ter falado com o número nas últimas 24h.

## Estrutura

```
src/server.js     rotas HTTP, webhook, autenticação, API do painel
src/engine.js     fluxo da mensagem: contato → conversa → IA/humano → resposta
src/ai.js         Claude com ferramentas (lead, retorno, humano, diagnóstico, vendas) + modo demo
src/vendas.js     agente de vendas: catálogo, proposta, política, cobrança, agenda, cadência, páginas públicas
src/email.js      e-mail pela Resend (simulado sem chave)
src/auth.js       usuários, login, sessões, papéis e convites
src/agents.js     agentes, números de WhatsApp, conexões e roteiro de implantação
src/seed.js       cadastro inicial da Avantte como empresa cliente
src/cadastro.js   cadastro pelo site, ativação no pagamento, assinatura e suspensão
src/midia.js      áudio (transcrição), fotos e documentos do WhatsApp
src/segmentos.js  modelos por segmento com regras do setor
src/loja.js       AvaShop: fotos, variações, estoque, frete, pedido, etiqueta, rastreio, vitrine
src/meta.js       conexão do WhatsApp pelo botão da Meta (Cadastro incorporado)
src/ganchos.js    pontos de extensão (pagamento confirmado, tarefas agendadas)
src/whatsapp.js   envio, validação de assinatura e leitura do webhook da Meta
src/db.js         SQLite (node:sqlite) — empresas, contatos, conversas, mensagens, leads, uso
src/plans.js      planos e limites comerciais
public/index.html painel
test/smoke.js     teste de ponta a ponta
```

## Próximos passos sugeridos

- Cobrança recorrente (Asaas) com webhook de pagamento que ativa ou pausa a empresa sozinho.
- Áudio (transcrição), imagens e documentos.
- Follow-up automático de orçamento parado (modelos aprovados pela Meta).
- Integrações do plano Premium (SIGE e outros ERPs).
- Migrar para Postgres quando passar de algumas dezenas de clientes.

## Modo econômico (fase inicial)

- **IA:** Claude Haiku como padrão, com cache do prompt e histórico curto, por volta de US$0,003 por conversa. Para usar um modelo mais forte só no plano Premium, preencha `ANTHROPIC_MODEL_PREMIUM`.
- **WhatsApp:** cada empresa cliente conecta a **própria conta da Meta**, com o cartão dela. As mensagens são cobradas direto do cliente, não da Avantte.
- **Servidor:** um serviço Starter no Render com disco de 1 GB (região Virginia, a mais próxima do Brasil). Aguenta as primeiras dezenas de clientes.
- **Quando migrar:** com cerca de 30 a 50 clientes, ou quando o painel começar a ficar lento, migre para Postgres e um plano maior.
