# Manual de configuração manual — ANAROSA × Bling

Este é o checklist do que **você** precisa fazer manualmente para ligar a
integração. Todo o código já está pronto; nada aqui exige alterar a
arquitetura. Marque cada item conforme concluir.

> Regras que continuam valendo durante todo o processo:
> - Nenhum segredo (`client_secret`, tokens, service role) vai para o Git nem para o frontend.
> - Não cadastre produtos reais antes da ETAPA 7.
> - O produto de teste **CAMISETA OGOCHI INFANTIL** pode ser usado para testes de leitura; alterações nele só pela interface do Bling, nunca pela nossa API.
> - Pedidos permanecem desativados (`BLING_ORDER_SYNC_ENABLED=false`) até a ETAPA 7.

## URLs que você vai usar

Preencha assim que tiver o *Project Ref* do Supabase (aparece na URL do
painel: `https://supabase.com/dashboard/project/<PROJECT_REF>`).

```
URL_DAS_FUNCTIONS = https://<PROJECT_REF>.supabase.co/functions/v1

REDIRECT URI (Bling → "Link de redirecionamento"):
<COLOCAR_URL_DO_DEPLOY_AQUI>/bling-oauth-callback
  ex.: https://<PROJECT_REF>.supabase.co/functions/v1/bling-oauth-callback

WEBHOOK URL (Bling → aba Webhooks):
<COLOCAR_URL_DO_DEPLOY_AQUI>/bling-webhook
  ex.: https://<PROJECT_REF>.supabase.co/functions/v1/bling-webhook

STOREFRONT (produção):
https://www.lojaanarosa.com.br

STOREFRONT (desenvolvimento local):
http://localhost:5500
```

A URL de redirecionamento cadastrada no Bling precisa ser **idêntica** ao
valor do secret `BLING_REDIRECT_URI` (mesmo esquema, host, caminho, sem
barra final extra).

---

## ETAPA 1 — Supabase

- [ ] Criar (ou selecionar) o projeto Supabase da ANAROSA e anotar o **Project Ref**.
- [ ] Instalar o Supabase CLI (`npm i -g supabase` ou binário) e fazer login: `supabase login`.
- [ ] Vincular o repositório ao projeto:
  ```bash
  supabase link --project-ref <PROJECT_REF>
  ```
  (o arquivo `supabase/config.toml` já existe; se o CLI pedir para sobrescrever, **mantenha** as seções `[functions.*]`).
- [ ] Rodar as migrations:
  ```bash
  supabase db push
  ```
  Conferir no painel (Table Editor) que existem `bling_connections`, `bling_oauth_states`, `bling_webhook_events`, `store_products`, `store_product_variants`, `store_inventory`, `store_categories`, `store_orders`, `store_order_items`, `integration_logs`.
- [ ] Deploy das Edge Functions (o `config.toml` já define `verify_jwt = false` onde necessário):
  ```bash
  supabase functions deploy
  ```
  Se preferir uma a uma: `supabase functions deploy bling-webhook --no-verify-jwt` (repetir para cada função listada em `supabase/config.toml`).
- [ ] Gerar um segredo administrativo forte (≥ 32 caracteres), por exemplo:
  ```bash
  openssl rand -base64 48
  ```
- [ ] Configurar os secrets do backend (não use `SUPABASE_*` aqui — são injetados automaticamente):
  ```bash
  supabase secrets set STOREFRONT_URL=https://www.lojaanarosa.com.br
  supabase secrets set INTEGRATION_ADMIN_SECRET=<segredo gerado>
  supabase secrets set BLING_ORDER_SYNC_ENABLED=false
  supabase secrets set BLING_REDIRECT_URI=https://<PROJECT_REF>.supabase.co/functions/v1/bling-oauth-callback
  # BLING_CLIENT_ID e BLING_CLIENT_SECRET entram na ETAPA 3
  ```
  Opcional: `OAUTH_SUCCESS_REDIRECT_URL` (padrão `${STOREFRONT_URL}/integration-status.html`).
- [ ] Testar o health check (sem segredos):
  ```bash
  curl https://<PROJECT_REF>.supabase.co/functions/v1/integration-health
  ```
  Esperado: `{"ok":true,"database":true,"blingConfigured":false,"blingConnected":false,...}`.

## ETAPA 2 — Bling (criar o aplicativo)

- [ ] Entrar na conta Bling da ANAROSA → **Central de Extensões** (Configurações → Integrações / Central de Extensões).
- [ ] Acessar a **Área do Integrador** (Central do Desenvolvedor, `developer.bling.com.br`, opção "Meus aplicativos").
- [ ] **Criar aplicativo**.
- [ ] Tipo/visibilidade: escolha **privado** (uso exclusivo da ANAROSA; não será publicado na loja de extensões). Só torne público se o Bling exigir para o fluxo desejado.
- [ ] Nome do app: `Loja Anarosa` (ou similar).
- [ ] Logo: usar `assets/logo/logo-anarosa.jpg`.
- [ ] Descrição: "Integração da loja virtual lojaanarosa.com.br com o Bling (catálogo, estoque e pedidos)".
- [ ] Homepage: `https://www.lojaanarosa.com.br`.
- [ ] **Link de redirecionamento** (EXATO): `<COLOCAR_URL_DO_DEPLOY_AQUI>/bling-oauth-callback`.
- [ ] **Escopos** — princípio do menor privilégio. Marque apenas os recursos que este backend usa:

  | Recurso no Bling | Permissão | Por quê |
  | --- | --- | --- |
  | Produtos | leitura | `GET /produtos`, `GET /produtos/{id}` (sync e webhooks de produto) |
  | Estoques | leitura | `GET /estoques/saldos` (sync e webhooks de estoque) |
  | Categorias de produtos | leitura | `GET /categorias/produtos` (mapeamento de categorias) |
  | Pedidos de venda | leitura **agora**; escrita só na ETAPA 7 | `GET /pedidos/vendas/{id}` (status). `POST` só quando `BLING_ORDER_SYNC_ENABLED=true` |

  Não marque NF-e, contatos, financeiro, marketplaces ou qualquer outro
  módulo. Os nomes exatos dos escopos aparecem na tela do app — confira
  se existem opções separadas de leitura/escrita e escolha **leitura**
  por enquanto.
- [ ] Salvar o aplicativo.

## ETAPA 3 — Credenciais

- [ ] Copiar o **Client ID** do aplicativo.
- [ ] Copiar o **Client Secret** do aplicativo (guarde em um gerenciador de senhas; não envie por chat/e-mail).
- [ ] Salvar como secrets do backend:
  ```bash
  supabase secrets set BLING_CLIENT_ID=<client id>
  supabase secrets set BLING_CLIENT_SECRET=<client secret>
  ```
- [ ] Confirmar que o health check passou a responder `"blingConfigured":true`.
- [ ] **NUNCA** colocar essas credenciais em `js/`, `index.html`, `integration-status.html` ou no Git. O único arquivo público de configuração é `js/config.js` e ele só recebe `supabaseUrl`.

## ETAPA 4 — OAuth (autorizar a conta ANAROSA)

- [ ] Editar `js/config.js` no ambiente onde a página de diagnóstico será aberta:
  ```js
  supabaseUrl: 'https://<PROJECT_REF>.supabase.co',
  ```
  (mantenha `catalogProvider: 'mock'` por enquanto).
- [ ] Abrir `integration-status.html` (local: `npm run dev` → `http://localhost:5500/integration-status.html`; ou a URL publicada). Se abrir por outra origem, ajuste `STOREFRONT_URL` para que o CORS permita.
- [ ] Colar o `INTEGRATION_ADMIN_SECRET` no campo "Segredo administrativo" → **Usar nesta sessão**.
- [ ] Clicar **Conectar Bling** → você será levado ao Bling → entrar com a conta da ANAROSA → **Autorizar**.
- [ ] O Bling redireciona para `bling-oauth-callback`, que troca o código por tokens e volta para `integration-status.html?bling=connected`.
- [ ] Clicar **Testar status** e confirmar `Conectado`, com "Token expira em" preenchido.
- [ ] Em caso de erro (`?bling=error&reason=...`):
  - `invalid_state` → clique novamente em Conectar (o state expira em 10 min e é de uso único);
  - `not_configured` → faltam secrets da ETAPA 3;
  - `bling_api_error` → confira se o link de redirecionamento no app é idêntico a `BLING_REDIRECT_URI`.

## ETAPA 5 — Webhooks (no aplicativo Bling)

- [ ] Entrar no aplicativo criado na Área do Integrador.
- [ ] Abrir a aba **Webhooks**.
- [ ] Cadastrar a URL pública HTTPS **exata**: `<COLOCAR_URL_DO_DEPLOY_AQUI>/bling-webhook`.
- [ ] Selecionar recurso **Produto**: `created`, `updated`, `deleted`.
- [ ] Selecionar recurso **Estoque**: `created`, `updated`, `deleted`.
- [ ] Selecionar recurso **Estoque virtual**: `updated`.
- [ ] **Pedido de venda** (`created`, `updated`, `deleted`): só quando chegar o momento de sincronizar status de pedidos (ETAPA 7). O backend já está preparado e apenas registra/ignora eventos de pedidos que não vieram da loja.
- [ ] Salvar. O Bling valida a assinatura com o **Client Secret** do próprio app — nenhum segredo adicional é necessário.
- [ ] Não cadastre NF-e, fornecedores ou outros recursos.

## ETAPA 5-B — Processamento automático da fila de webhooks (pg_cron)

`bling-webhook` responde rápido e processa em background; se o worker for
encerrado antes de terminar, o evento fica pendente. A migration
`supabase/migrations/20260904130000_bling_webhook_cron.sql` já criou uma
varredura automática (~1x/minuto, via `pg_cron` + `pg_net`) que chama
`bling-webhook-process` para limpar o que sobrou — mas ela só funciona
depois que você preencher a URL e o segredo administrativo abaixo. **Sem
esse passo, a varredura roda a cada minuto e não faz nada (no-op
silencioso)**; os webhooks continuam funcionando normalmente pelo
processamento em background, só não têm a rede de segurança do sweep.

- [ ] Confirmar que `supabase db push` (ETAPA 1) aplicou a migration
  `20260904130000_bling_webhook_cron.sql` — ela habilita as extensões
  `pg_cron` e `pg_net` (schemas fixos `cron` e `net`) e agenda o job
  `bling-webhook-process-tick`.
  - Se a extensão não puder ser habilitada por SQL nesse plano/projeto,
    habilite manualmente em **Database → Extensions** (procure por
    `pg_cron` e `pg_net`) e rode `supabase db push` novamente.
- [ ] No **SQL Editor** do painel Supabase, rode (substituindo os
  valores — **não** cole isso num arquivo versionado no Git):
  ```sql
  insert into private.integration_settings (key, value) values
    ('bling_webhook_process_url', 'https://<PROJECT_REF>.supabase.co/functions/v1/bling-webhook-process'),
    ('bling_webhook_process_secret', '<INTEGRATION_ADMIN_SECRET definido na ETAPA 1>')
  on conflict (key) do update set value = excluded.value, updated_at = now();
  ```
  Use exatamente o mesmo valor de `INTEGRATION_ADMIN_SECRET` configurado
  como secret da função na ETAPA 1 — é o mesmo header
  `x-integration-admin-secret` que a página de diagnóstico usa.
- [ ] Conferir que o job está agendado: `select * from cron.job where jobname = 'bling-webhook-process-tick';`
- [ ] (Opcional) Forçar uma execução manual para testar:
  ```sql
  select private.bling_process_webhook_queue();
  select * from net._http_response order by id desc limit 5;
  ```
  Um `status_code` 200/202 na última linha confirma que a chamada chegou
  à função. Se não aparecer nenhuma linha, confira se os dois valores em
  `private.integration_settings` foram salvos corretamente.
- [ ] `private.integration_settings` e `private.cron_locks` ficam no
  schema `private`, que não é publicado pela API (só `public` é exposto
  por padrão) e tem RLS sem policies — não é acessível pelo anon key nem
  pelo frontend.

## ETAPA 6 — Testes ponta a ponta

- [ ] `integration-status.html` → **Testar status**: `Conectado`.
- [ ] Usar o produto de teste existente (**CAMISETA OGOCHI INFANTIL**). Não crie produtos reais.
- [ ] **Sincronizar produtos** (somente leitura no Bling). O resumo deve mostrar `products: 1` (ou mais, se houver outros de teste) e `errors: []`.
- [ ] Verificar o cache: no painel do Supabase, `store_products` contém a camiseta; `store_inventory` tem o saldo; "Produtos cacheados" na página mostra `1 ativos`.
- [ ] Alterar o **preço** do produto de teste pela interface do Bling.
- [ ] Confirmar o webhook: "Último webhook" atualiza, `bling_webhook_events` recebe `product.updated` com `status = processed`, e o preço em `store_products` muda.
- [ ] Alterar o **estoque** do produto de teste pela interface do Bling.
- [ ] Confirmar o webhook: evento `stock.updated`/`virtual_stock.updated` processado e `store_inventory` atualizado.
- [ ] Se algum evento ficar `failed`: clicar **Processar fila de webhooks** e ver "Erros recentes".
- [ ] Testar a vitrine: `curl "<URL_DAS_FUNCTIONS>/storefront-products"` deve listar a camiseta sem nenhum campo interno.

## ETAPA 7 — Produção

- [ ] Publicar o site com `js/config.js`:
  ```js
  catalogProvider: 'supabase',
  supabaseUrl: 'https://<PROJECT_REF>.supabase.co',
  ```
  (a Home passa a ler o cache; em falha mostra mensagem amigável, nunca o mock).
- [ ] Cadastrar o **catálogo real** no Bling (produtos, variações cor/tamanho, imagens, categorias). Opcional: marcar curadoria em `store_products.metadata.tags` (`novo`, `mais-vendido`, `oferta`, `escolha-da-semana`) — sem tags, as seções mostram o catálogo completo.
- [ ] Executar **Sincronizar produtos** e validar cards, preços e imagens no site.
- [ ] Validar **estoque**: produtos com saldo virtual 0 aparecem como "Esgotado"; conferir com a loja física.
- [ ] Restringir o acesso a `integration-status.html` (não publicar, ou proteger por autenticação/IP). Trocar o `INTEGRATION_ADMIN_SECRET` se ele tiver sido usado em ambiente compartilhado.
- [ ] **Só depois** — quando checkout, pagamento e fluxo operacional estiverem aprovados:
  - revisar `mapOrderToBling()` contra a doc de `POST /pedidos/vendas`;
  - ampliar o escopo de "Pedidos de venda" para escrita no app Bling;
  - `supabase secrets set BLING_ORDER_SYNC_ENABLED=true`;
  - habilitar os webhooks de pedido (ETAPA 5).

---

## Referência rápida de secrets

| Secret | Obrigatório | Valor |
| --- | --- | --- |
| `BLING_CLIENT_ID` | sim | do app Bling |
| `BLING_CLIENT_SECRET` | sim | do app Bling (também assina os webhooks) |
| `BLING_REDIRECT_URI` | sim | `https://<PROJECT_REF>.supabase.co/functions/v1/bling-oauth-callback` |
| `INTEGRATION_ADMIN_SECRET` | sim | aleatório, ≥ 32 chars |
| `STOREFRONT_URL` | sim | `https://www.lojaanarosa.com.br` (dev: `http://localhost:5500`) |
| `BLING_ORDER_SYNC_ENABLED` | sim | `false` até a ETAPA 7 |
| `BLING_API_BASE_URL` / `BLING_AUTH_URL` / `BLING_TOKEN_URL` | não | só se a doc oficial mudar (padrões em `_shared/config.ts`) |
| `OAUTH_SUCCESS_REDIRECT_URL` | não | página pós-OAuth |
| `BLING_REQUEST_TIMEOUT_MS` | não | padrão 15000 |

Além dos secrets do backend (acima, via `supabase secrets set`), a ETAPA
5-B usa dois valores gravados **no banco** (não são env vars) na tabela
`private.integration_settings`: `bling_webhook_process_url` e
`bling_webhook_process_secret` (mesmo valor de `INTEGRATION_ADMIN_SECRET`).
Eles alimentam o `pg_cron` que reprocessa webhooks pendentes automaticamente.
