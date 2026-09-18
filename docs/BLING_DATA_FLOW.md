# Fluxo de dados — Bling ↔ Supabase ↔ lojaanarosa.com.br

```
                 ┌────────────────────────────────────────────┐
                 │                 BLING (ERP)                │
                 │  fonte operacional de verdade:             │
                 │  produtos · variações · estoque · pedidos  │
                 └───────┬───────────────────────▲────────────┘
     webhooks (push)     │                       │ API v3 (pull / POST pedidos)
     X-Bling-Signature   │                       │ Bearer JWT + enable-jwt: 1
                         ▼                       │
┌────────────────────────────────────────────────┴──────────────────────────┐
│                        SUPABASE (backend seguro)                          │
│                                                                           │
│  Edge Functions                          PostgreSQL                       │
│  ─ bling-webhook ──────────────────────▶ bling_webhook_events (idempot.)  │
│  ─ bling-webhook-process ─┐              store_products / _variants        │
│  ─ bling-sync-products ───┼─ upsert ───▶ store_inventory / store_categories│
│  ─ bling-sync-product ────┘              bling_connections (tokens, RLS)   │
│  ─ bling-auth-start / bling-oauth-callback ─▶ bling_oauth_states           │
│  ─ storefront-products / storefront-product ◀─ leitura do cache           │
│  ─ bling-create-order (DESATIVADO) ─────▶ store_orders / store_order_items │
│  ─ bling-status / integration-health     integration_logs                 │
└──────────────────────────────▲────────────────────────────────────────────┘
                               │ HTTPS (somente dados públicos)
                               │
                 ┌─────────────┴─────────────┐
                 │   lojaanarosa.com.br (HTML/JS)│
                 │   CatalogService          │
                 │   mock ⇄ supabase         │
                 └───────────────────────────┘
```

O navegador **nunca** fala com o Bling. Tokens ficam apenas em
`bling_connections` (service role).

---

## 1. Autorização (uma vez, manual)

```
operador → integration-status.html → POST bling-auth-start (admin secret)
        ← { authorizeUrl }            state aleatório; SHA-256 salvo (TTL 10 min)
operador → Bling: /oauth/authorize?response_type=code&client_id&state
Bling    → GET bling-oauth-callback?code&state
             1. RPC bling_consume_oauth_state(hash)  → existe? não expirou? não usado? (marca usado)
             2. POST BLING_TOKEN_URL  Basic client_id:client_secret
                                       Content-Type: application/x-www-form-urlencoded
                                       enable-jwt: 1
                                       grant_type=authorization_code&code=...
             3. salva access_token/refresh_token/expires_at em bling_connections
             4. redirect → integration-status.html?bling=connected
```

## 2. Renovação do token (automática)

Antes de cada chamada, `BlingClient.getValidAccessToken()`:

```
expires_at - now <= 120 s ?
  não → usa o token
  sim → RPC bling_try_acquire_refresh_lock(id, 30 s)
          obteve  → POST token (grant_type=refresh_token, enable-jwt: 1)
                    RPC bling_complete_token_refresh (atômico, libera lock)
          não     → aguarda (6 tentativas com backoff) e relê o banco
```

Um `401` inesperado dispara o mesmo caminho e **uma única** repetição.

## 3. Sincronização completa (manual — `bling-sync-products`)

```
GET /categorias/produtos (paginado)          → store_categories
GET /produtos?criterio=5&pagina=N&limite=100 → lista (ativos + inativos)
   para cada item sem idProdutoPai:
     GET /produtos/{id}                        → mapBlingProduct()
        ├─ store_products  (upsert por bling_id; slug estável)
        └─ store_product_variants (upsert por bling_id; ausentes → active=false)
GET /estoques/saldos?idsProdutos[]=…        → store_inventory
   (linha "__total__" + uma linha por depósito)
bling_connections.last_sync_at = now()
```

Estimativa de chamadas: 1 por página de lista + 1 por produto pai/simples
+ 1 a cada 50 ids para estoque. O Bling limita ~3 req/s; o client trata
`429` respeitando `Retry-After`.

## 4. Webhooks (push do Bling)

```
POST bling-webhook (raw body)
  1. HMAC-SHA256(client_secret, body) == X-Bling-Signature-256 ? senão 401
  2. parse → eventId, event, companyId, date, data
  3. RPC bling_register_webhook_event → novo?  não → 200 {duplicate:true}
  4. evento suportado? não → status "ignored", 202
  5. 202 {accepted:true} IMEDIATO
  6. background (EdgeRuntime.waitUntil): claim → handler → processed/failed
```

| Evento | Handler | Ação no cache |
| --- | --- | --- |
| `product.created` / `product.updated` | `handleProductEvent` | `GET /produtos/{id}` (estado atual) → upsert produto + variações + estoque |
| `product.deleted` | `handleProductEvent` | `active=false` (soft-disable; histórico preservado) |
| `stock.created` / `stock.updated` / `stock.deleted` / `virtual_stock.updated` | `handleStockEvent` | identifica o produto no payload e **consulta `GET /estoques/saldos`** (não confia no valor do payload → imune a eventos fora de ordem) |
| `order.created` / `order.updated` | `handleOrderEvent` | se o pedido existir em `store_orders` (originado na loja), `GET /pedidos/vendas/{id}` e atualiza `status`; pedidos de balcão/marketplace são apenas registrados (nenhum pedido é criado) |
| `order.deleted` | `handleOrderEvent` | `status='cancelled'` no pedido local correspondente |

Falhas viram `status='failed'` com `next_retry_at` (backoff 1 min → 6 h)
e são reprocessadas por `bling-webhook-process` (manual ou agendado).

## 5. Vitrine (pull do site)

```
index.html → CatalogService(provider = window.ANAROSA_CONFIG.catalogProvider)
  mock     → js/products.js
  supabase → GET storefront-products?limit=200 (cache 60 s no navegador)
             GET storefront-products?q=… (busca) / ?category=…
             GET storefront-product?slug=…
```

Formato público (nada além disto sai do backend):

```json
{
  "id": "uuid", "blingId": "1001", "sku": "OG-001",
  "name": "…", "slug": "…", "shortDescription": "…", "description": "…",
  "category": { "name": "Bebê", "slug": "bebe" }, "brand": "…",
  "price": 59.9, "promotionalPrice": null,
  "images": [{ "url": "…", "alt": null }],
  "variants": [{ "id": "uuid", "blingId": "1002", "sku": "…", "name": "…",
                 "color": "Azul", "size": "M", "price": 59.9,
                 "promotionalPrice": null, "attributes": { "Cor": "Azul" },
                 "stock": 2, "available": true }],
  "stock": 2, "available": true, "tags": ["novo"], "updatedAt": "…"
}
```

`tags` vem de `store_products.metadata.tags` (curadoria: `novo`,
`mais-vendido`, `oferta`, `escolha-da-semana`, `destaque`). Sem tags, as
seções da Home mostram o catálogo completo. `promotionalPrice` fica `null`
até definirmos a regra comercial (o cadastro básico do Bling v3 não tem
preço promocional; só listas de preço).

## 6. Estoque — regra central

Implementada **uma vez** no banco (`public.store_available_stock`, coluna
gerada `store_inventory.available_stock`) e espelhada em
`computeAvailableStock()` (TypeScript) com teste de paridade:

```
available = max( virtual_stock ?? physical_stock ?? 0 , 0 )
```

- **físico**: o que está na prateleira (`saldoFisico`).
- **virtual**: físico menos reservas de pedidos em aberto no Bling
  (`saldoVirtual`) — é o que pode ser vendido; por isso tem prioridade.
- **múltiplos depósitos**: uma linha por `deposit_id`; a view
  `store_stock_totals` soma os depósitos (ignorando a linha `__total__`).
  A vitrine usa a soma dos depósitos e, se não houver, a linha `__total__`.
- Sem informação de estoque (`null`) o produto **não é bloqueado** — o
  Bling ainda não informou; a venda continua sujeita à confirmação do
  pedido. Isso evita esconder o catálogo por um cache vazio.
- O navegador **não calcula estoque**: só lê `stock`/`available` prontos.

## 7. Pedidos (preparado, DESATIVADO)

```
checkout (futuro) → POST bling-create-order
  validateOrderInput → idempotency_key (fornecida ou hash do conteúdo)
  store_orders (unique idempotency_key) → existe? devolve o mesmo pedido
  BLING_ORDER_SYNC_ENABLED=false → bling_sync_status='disabled', 202, FIM
  BLING_ORDER_SYNC_ENABLED=true  → POST /pedidos/vendas UMA vez
                                    sucesso → bling_id, 'synced'
                                    falha   → 'failed' + erro, sem retry
```

Dois cliques ou um retry HTTP com o mesmo conteúdo → mesma chave → mesmo
`store_orders.id`; nunca dois pedidos no Bling.

## 8. Marketplaces (futuro, sem código aqui)

```
Shopee ─┐
ML     ─┼─▶ BLING ◀─▶ (esta integração) ◀─▶ lojaanarosa.com.br
Física ─┘
```

O Bling atua como hub: pedidos e estoque de marketplaces entram no Bling e
chegam à loja pelos mesmos webhooks de estoque/pedido. Nenhuma API de
marketplace é (nem deve ser) chamada por este projeto.
