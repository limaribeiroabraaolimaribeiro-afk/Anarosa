# Arquitetura — ANAROSA × Bling × Supabase

## Visão geral

```
BLING (fonte operacional de verdade)
  │  produtos / variações / estoque / pedidos
  ▼
Supabase Edge Functions (Deno)  ──  backend seguro: OAuth, webhooks, sync, storefront
  │
  ▼
Supabase PostgreSQL  ──  cache da vitrine + conexão Bling + logs + fila de webhooks
  │
  ▼
lojaanarosa.com.br (HTML/CSS/JS puro)  ──  CatalogService (mock | supabase)
```

Decisões-chave:

| Decisão | Motivo |
| --- | --- |
| Frontend continua HTML/CSS/JS puro | Home aprovada; nada de framework. A integração entra por uma camada de acesso (`js/services/catalog-service.js`) e uma config pública (`js/config.js`). |
| Navegador nunca chama o Bling | Tokens, `client_secret` e refresh ficam só no backend. O site lê um cache já sanitizado. |
| Supabase como camada segura + cache | PostgreSQL com RLS, Edge Functions com service role, secrets gerenciados. |
| Bling manda; Supabase espelha | Webhooks + sync manual mantêm o cache; o backend só **lê** o Bling (exceto `bling-create-order`, desativado). |
| Marketplaces via Bling | Shopee/Mercado Livre entram no Bling; a loja recebe tudo pelos mesmos webhooks. Sem integrações duplicadas. |

## Estrutura de pastas

```
.
├── index.html                       Home (inalterada visualmente; SEO completo + drawer de carrinho)
├── checkout.html                    carrinho → dados → entrega → pagamento → revisão → confirmação
├── integration-status.html          página interna de diagnóstico (não linkada no menu)
├── js/
│   ├── config.js                    window.ANAROSA_CONFIG (catalogProvider, supabaseUrl) — PÚBLICO
│   ├── products.js                  mock (mantido como fallback)
│   ├── services/catalog-service.js  CatalogService + MockCatalogProvider + SupabaseCatalogProvider
│   ├── services/cart-service.js     CartService — carrinho real (linhas, variação, qty) em localStorage
│   ├── app.js                       Home; catálogo + carrinho + modal de variação
│   ├── checkout.js                  wizard do checkout.html; chama storefront-checkout no final
│   └── integration-status.js        JS da página de diagnóstico
├── css/checkout.css                 estilos isolados do checkout
├── css/integration-status.css       estilos isolados da página de diagnóstico
├── assets/products/placeholder.svg  imagem padrão para produto sem foto (modo real)
├── supabase/
│   ├── config.toml                  verify_jwt=false por função (proteção é feita no código)
│   ├── migrations/20260904120000_bling_integration_initial.sql
│   ├── migrations/20260904130000_bling_webhook_cron.sql   pg_cron: varredura automática da fila de webhooks
│   ├── migrations/20260904140000_fix_service_role_permissions.sql
│   ├── migrations/20260911150000_gestao_admin_panel.sql   store_admins + RPCs do painel
│   ├── migrations/20260912090000_fix_store_order_items_select.sql   SELECT faltante p/ admin-orders
│   └── functions/
│       ├── deno.json                tasks test/check
│       ├── _shared/                 módulos reutilizados (abaixo)
│       ├── _tests/                  testes Deno (sem rede, sem banco)
│       ├── bling-auth-start/        POST admin  → URL de autorização + state
│       ├── bling-oauth-callback/    GET         → troca code→token, salva, redireciona
│       ├── bling-status/            GET         → status não sensível
│       ├── bling-sync-products/     POST admin  → sync completa (manual)
│       ├── bling-sync-product/      POST admin  → sync de 1 produto
│       ├── bling-webhook/           POST Bling  → HMAC + idempotência + 2xx rápido
│       ├── bling-webhook-process/   POST admin  → reprocessa pending/failed
│       ├── storefront-products/     GET público → lista do cache
│       ├── storefront-product/      GET público → detalhe do cache
│       ├── storefront-checkout/     POST público → registra pedido (preço/estoque do backend; NUNCA chama o Bling)
│       ├── bling-create-order/      POST admin  → DESATIVADO por flag
│       └── integration-health/     GET         → { ok, database, blingConfigured, blingConnected }
├── docs/                            ARCHITECTURE, BLING_SETUP_MANUAL, BLING_DATA_FLOW, TESTING
├── .env.example                     variáveis (sem valores)
├── .gitignore                       .env*, .supabase/, node_modules, etc.
└── package.json                     scripts: test, check, lint:js, secrets:scan, dev
```

### `_shared/`

| Módulo | Responsabilidade |
| --- | --- |
| `config.ts` | **único lugar** com URLs do Bling e leitura de env (`getBlingConfig`, `getAppConfig`, `SUPPORTED_WEBHOOK_EVENTS`) |
| `errors.ts` | erros tipados (`BlingApiError`, `BlingAuthError`, `BlingRateLimitError`, `TokenRefreshError`, `NotConnectedError`, `UnauthorizedError`, `ValidationError`…) |
| `crypto.ts` | Web Crypto: random state, SHA-256, HMAC-SHA256, `timingSafeEqual`, Basic Auth |
| `logger.ts` | logger com sanitização (JWT, Bearer/Basic, chaves sensíveis, query strings) + sink para `integration_logs` |
| `cors.ts` / `responses.ts` | CORS restrito ao `STOREFRONT_URL` (+ localhost) e respostas JSON/redirect sem stack trace |
| `supabase.ts` | cliente service role (único import do SDK) + `dbLogSink` |
| `admin-auth.ts` | header `x-integration-admin-secret` (timing-safe, falha fechada) |
| `oauth-state.ts` | criação/validação do state (hash, TTL, uso único) — stores memória e Supabase |
| `bling-auth.ts` | `buildAuthorizeUrl`, `exchangeAuthorizationCode`, `refreshAccessToken` (Basic + form + `enable-jwt: 1`) |
| `token-store.ts` | `bling_connections`: leitura, gravação, lock de refresh, `toPublicInfo` |
| `bling-client.ts` | `BlingClient`: request com timeout, 401→refresh→1 retry, 429→Retry-After (GET), paginação, `getProducts/getProductById/getStocks/getCategories/createOrder/getOrderById` |
| `product-mapper.ts` | Bling → `store_products`/`store_product_variants`/`store_inventory`/`store_categories`; `computeAvailableStock` |
| `order-mapper.ts` | validação, totais, idempotency key, payload `POST /pedidos/vendas` |
| `catalog-repo.ts` | upserts por `bling_id`, slug estável/único, soft-disable, leitura pública, diagnósticos, `resolveOrderItems` (checkout: preço/estoque/situação sempre do backend) |
| `storefront-serializer.ts` | formato público (sem custo/tokens/metadata) + disponibilidade |
| `sync-service.ts` | `syncAllProducts`, `syncProductById`, `syncStockForProducts`, `syncCategories` |
| `webhook.ts` | verificação HMAC, parse, `WebhookEventStore` (memória/Supabase), backoff |
| `webhook-handlers.ts` | handlers produto/estoque/pedido, dispatcher, `processRegisteredEvent`, `processPendingEvents` |
| `context.ts` | monta dependências, `serve()` com preflight/erros/flush, `runInBackground` |

## Banco de dados

Migrations: `20260904120000_bling_integration_initial.sql` (schema principal), `20260904130000_bling_webhook_cron.sql` (pg_cron + pg_net), `20260904140000_fix_service_role_permissions.sql` e `20260912090000_fix_store_order_items_select.sql` (grants explícitos de `service_role` nas tabelas/funções acima — RLS por si só não concede privilégio de tabela; cada tabela nova lida pelo código precisa do seu próprio GRANT) e `20260911150000_gestao_admin_panel.sql` (painel /gestao/).

| Tabela | Uso | Acesso |
| --- | --- | --- |
| `bling_connections` | tokens (TEXT — JWT de 1,5 a 3 mil chars), `expires_at`, `status`, `refresh_lock_until`, `last_sync_at` | **secreta** |
| `bling_oauth_states` | `state_hash` único, `expires_at`, `used_at` | **secreta** |
| `bling_webhook_events` | `event_id` PK (idempotência), `status`, `retry_count`, `next_retry_at`, `payload` | **secreta** |
| `integration_logs` | logs sanitizados (operação, nível, entidade, detalhes) | **secreta** |
| `store_categories` | categorias do Bling (slug, hierarquia) | via Edge Functions |
| `store_products` | produto (pai ou simples) — `bling_id` único, slug único, `images`/`metadata` jsonb | via Edge Functions |
| `store_product_variants` | variações (cor/tamanho/atributos) — `bling_id` único | via Edge Functions |
| `store_inventory` | uma linha por (`bling_product_id`, `deposit_id`); `available_stock` **gerada** pela função central | via Edge Functions |
| `store_orders` / `store_order_items` | pedidos da loja; `idempotency_key` único; `bling_sync_status` | via Edge Functions |

Segurança: RLS habilitado em todas; **nenhuma policy** para `anon`/`authenticated`;
privilégios revogados; RPCs `security definer` com `EXECUTE` revogado de
`public/anon/authenticated`. Só a service role (Edge Functions) acessa.

RPCs: `bling_consume_oauth_state`, `bling_register_webhook_event`,
`bling_claim_webhook_event`, `bling_try_acquire_refresh_lock`,
`bling_complete_token_refresh`, `bling_fail_token_refresh`,
`bling_cleanup_oauth_states`. View interna: `store_stock_totals`.

## Carrinho e checkout (frontend + storefront-checkout)

O carrinho (`js/services/cart-service.js`) guarda linhas (produto +
variação opcional + quantidade) em `localStorage`; o preço ali é só
exibição. `checkout.html`/`js/checkout.js` conduzem o cliente por
carrinho → dados → entrega/retirada → pagamento (preferência; nenhum
dado de cartão é coletado) → revisão → confirmação.

Na revisão, o navegador rechama `storefront-product` para cada item e
avisa se preço/estoque mudaram — só para UX. A confirmação de fato
chama **`storefront-checkout`** (público, sem admin secret, porque
precisa ser acionável por qualquer cliente):

1. recebe só `{ slug, variantBlingId?, quantity }` por item — **nunca**
   um preço;
2. `CatalogRepository.resolveOrderItems()` busca produto/variação
   ATUAIS no cache e rejeita (400) produto inativo, variação
   inexistente/inativa ou estoque insuficiente — o preço usado é
   sempre o que está em `store_products`/`store_product_variants`
   naquele momento;
3. grava em `store_orders`/`store_order_items` com
   `idempotency_key` (mesmo pedido → mesma chave → nunca duplica) e
   `bling_sync_status` **sempre** `'disabled'` — este endpoint nunca
   chama a API do Bling, independente de `BLING_ORDER_SYNC_ENABLED`.

Isso é diferente de `bling-create-order` (admin-only, já existente):
aquele É o caminho que um dia criará o pedido no Bling quando a flag
for ligada; `storefront-checkout` é o caminho público de **intake**
do pedido, deliberadamente sem esse poder. Ligar a criação real a
partir do storefront é uma decisão futura separada — troque
`storefront-checkout` para checar `ctx.blingConfig.orderSyncEnabled` e
reusar `mapOrderToBling`/`ctx.client().createOrder()` só quando o
fluxo operacional (pagamento real, aprovação) estiver definido.

## Gestão Anarosa (/gestao/) — painel administrativo

Autenticação real via **Supabase Auth** (não o `INTEGRATION_ADMIN_SECRET`
usado pelas ferramentas de desenvolvimento). Um login válido no Supabase
Auth *não* dá acesso por si só: o `user_id` também precisa estar na
allowlist `store_admins` (tabela secreta, só `service_role`).

```
navegador (supabase-js + anon key)
  │ signInWithPassword → sessão real (access_token)
  ▼
Edge Functions admin-* ── requireAdminUser(): valida o token via
                           auth.getUser() + confere store_admins
  │ (service_role)
  ▼
store_orders / store_products / store_product_variants / store_inventory /
bling_connections / bling_webhook_events (leitura) + RPCs
admin_dashboard_summary() / admin_customers_summary()
```

O navegador nunca lê essas tabelas diretamente (sem RLS "aberta" para
`authenticated`) — todo dado passa por uma Edge Function que já fez a
verificação de allowlist. `admin-products`/`admin-orders` são somente
leitura (Bling é fonte de verdade; sem edição de produto no navegador).
`admin-customers` não duplica dado: agrega `store_orders` por telefone.

Migration: `supabase/migrations/20260911150000_gestao_admin_panel.sql`.
Manual de configuração: `docs/GESTAO_SETUP_MANUAL.md`.

## Segurança — resumo

- Segredos apenas em Supabase Secrets / `.env` local (ignorado). `.env.example` sem valores.
- Frontend: apenas `catalogProvider`, `supabaseUrl` e (opcional) anon key — pública por design.
- OAuth: state aleatório (32 bytes), hash no banco, TTL 10 min, uso único; `client_secret` só no servidor; tokens nunca voltam ao navegador; `authorization_code` não é armazenado.
- Webhook: HMAC-SHA256 do **raw body** com `client_secret`, comparação timing-safe, 401 se inválido; idempotência por `eventId`.
- Admin: `INTEGRATION_ADMIN_SECRET` (≥16 chars) via header; sem secret configurado tudo falha fechado; a página de diagnóstico guarda o valor só em `sessionStorage`.
- Logs: sanitização de `Authorization`, tokens, `client_secret`, `code`, Basic Auth, JWTs, query strings.
- CORS: só `STOREFRONT_URL` (www/apex) e localhost.
- Cliente Bling: timeout, sem loops, POST sem retry automático.

## Fila de webhooks — limitação e mitigação automática

Edge Functions não oferecem fila durável nativa. A estratégia adotada:

1. `bling-webhook` responde 2xx **antes** de processar (só valida, registra e agenda).
2. O processamento roda em `EdgeRuntime.waitUntil` (continua após a resposta).
3. Se o worker for encerrado antes de concluir, o evento permanece `pending`/`failed`
   em `bling_webhook_events`.
4. **Varredura automática via `pg_cron` + `pg_net`** (implementada em
   `supabase/migrations/20260904130000_bling_webhook_cron.sql`): a cada
   minuto, `private.bling_process_webhook_queue()` dispara um `POST` (via
   `net.http_post`, assíncrono) para `bling-webhook-process?limit=20`,
   reprocessando o que ficou pendente.

Proteções embutidas nessa varredura:

| Risco | Mitigação |
| --- | --- |
| Duas varreduras sobrepostas | `private.try_acquire_cron_lock('bling-webhook-process', 55)` — lock com TTL de 55s (mesmo padrão de `bling_try_acquire_refresh_lock`) |
| Processar o mesmo evento duas vezes | já resolvido pelo `claim` atômico (`bling_claim_webhook_event`), usado tanto pelo processamento em background quanto pela varredura — independe de quantas vezes a função é chamada |
| Volume alto por execução | `limit=20` por chamada (bounded) |
| Loop infinito | cron roda 1x/minuto, cada tick faz **um** disparo fire-and-forget e retorna; nenhuma repetição interna |
| Erro de rede/config trava o banco | toda a função roda dentro de `exception when others then return;` — nunca propaga erro para o pg_cron |
| Segredo em SQL versionado | a migration só cria a estrutura (`private.integration_settings`); a URL e o `INTEGRATION_ADMIN_SECRET` são inseridos **manualmente** depois do deploy (ver `docs/BLING_SETUP_MANUAL.md`, ETAPA 5-B). Sem esses valores, a função é um no-op silencioso |

O schema `private` não é exposto via PostgREST (só `public` é publicado por
padrão) e suas tabelas têm RLS habilitado sem nenhuma policy — a mesma
defesa em profundidade já usada em `bling_connections`.

## Pontos a confirmar na documentação oficial do Bling

Isolados em configuração/código para ajuste sem refatoração:

1. ~~Endpoint de token~~ **Confirmado**: `BLING_TOKEN_URL` = `https://api.bling.com.br/Api/v3/oauth/token` (host `api.bling.com.br`, igual ao `BLING_API_BASE_URL`; distinto do host `www.bling.com.br` usado por `BLING_AUTH_URL`).
2. **Campos do `data` nos webhooks de estoque** — a doc pública não lista os nomes completos. `extractStockFromWebhook()` aceita `produto.id`/`idProduto`/`id` e `deposito.id`/`idDeposito`; independentemente disso, o handler consulta `GET /estoques/saldos`, então a única dependência real é o **id do produto**.
3. **Parâmetros de `GET /produtos`** — `criterio=5` (todos) e `limite=100` conforme a referência atual; ajustar em `bling-client.ts` se a API mudar.
4. **Payload de `POST /pedidos/vendas`** — revisar `mapOrderToBling()` antes de ligar `BLING_ORDER_SYNC_ENABLED` (campos de contato, transporte, parcelas).
5. **IDs de situação de pedido** — variam por conta; `mapBlingOrderStatus()` é conservador (`pending` para ids desconhecidos).
6. **Escopos** — nomes exatos na tela de criação do app (ver manual).
7. **Assinatura de `net.http_post`** (extensão `pg_net`, não é API do Bling) — usada em `private.bling_process_webhook_queue()` com os parâmetros `url`, `body`, `headers`, `timeout_milliseconds`, que é a assinatura documentada pela Supabase no momento desta entrega. Se a versão do `pg_net` instalada no projeto divergir, a chamada falha dentro do `exception when others` (silenciosa, sem quebrar o cron) — confirme rodando manualmente `select private.bling_process_webhook_queue();` após configurar `private.integration_settings` (ETAPA 5-B) e olhando `select * from net._http_response order by id desc limit 5;`.
