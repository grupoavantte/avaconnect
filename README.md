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

## Rodar localmente

```bash
npm install
cp .env.example .env   # opcional
ADMIN_TOKEN=um-token-forte npm start
# abra http://localhost:3000 e entre com o ADMIN_TOKEN
npm test               # com o servidor rodando: teste de ponta a ponta
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
src/ai.js         Claude com ferramentas (registrar_lead, transferir_humano) + modo demo
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
