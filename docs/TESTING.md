# Testes — integração ANAROSA × Bling

Nenhum teste toca a conta real do Bling. Todas as chamadas externas são
mockadas (`_tests/helpers.ts` → `mockFetch`). Também não é necessário
Supabase rodando: os módulos recebem o banco por injeção e os testes usam
implementações em memória (`MemoryTokenStore`, `MemoryOAuthStateStore`,
`MemoryWebhookEventStore`).

## Pré-requisitos

- Node 18+ (o Deno é obtido via `npx deno@2`, sem instalação global)
- Python 3 (apenas para servir o site localmente)

## Comandos

```bash
# testes das Edge Functions (Deno)
npm test

# checagem de tipos de todos os módulos e funções
npm run check

# sintaxe do JS do frontend
npm run lint:js

# procurar segredos versionados por engano
npm run secrets:scan

# servir o site em http://127.0.0.1:5500
npm run dev
```

Equivalente direto, sem npm:

```bash
cd supabase/functions
npx -y deno@2 test --allow-env --allow-read _tests/
npx -y deno@2 task check
```

## O que a suíte cobre (63 testes)

| Arquivo | Cobertura |
| --- | --- |
| `_tests/oauth-state.test.ts` | geração do state (aleatório, só o hash vai ao banco), validação, **expirado**, **reutilizado**, malformado; URL de autorização sem `client_secret` |
| `_tests/webhook.test.ts` | vetor conhecido de HMAC-SHA256, `timingSafeEqual`, **assinatura válida**, **inválida/ausente/secret errado**, parse do payload, **evento duplicado**, claim atômico (processa uma única vez), evento não suportado, `product.deleted` → soft-disable, estoque consulta o saldo atual, backoff |
| `_tests/product-mapper.test.ts` | slugify, **produto simples**, inativo/excluído, **produto pai + variações cor/tamanho**, variação isolada, parser de atributos, saldos com múltiplos depósitos, regra de `available_stock`, extração de estoque do webhook, categoria, serialização pública (não vaza metadata, calcula disponibilidade) |
| `_tests/token-refresh.test.ts` | **cálculo de expiração**, JWT grande, troca de code (Basic Auth + form-urlencoded + `enable-jwt: 1`), refresh, **refresh flow mockado** no `BlingClient` (token perto de expirar, 401 → refresh → 1 repetição, 401 persistente, refresh falho, **concorrência com lock**, lock preso), 429 com Retry-After (GET repete 1x; POST nunca), 5xx em POST não repete, sem conexão, paginação, status público sem tokens |
| `_tests/logger.test.ts` | **sanitização** de chaves sensíveis, JWT/Bearer/Basic em strings, query strings, `Headers`, entradas do sink sem segredos, sink falho não propaga |
| `_tests/order.test.ts` | totais, validação, **idempotency key** determinística e fornecida, mapeamento para `POST /pedidos/vendas`, status |
| `_tests/admin-auth.test.ts` | admin falha fechada sem secret, secret curto, secret correto/incorreto; URLs padrão centralizadas; `BLING_ORDER_SYNC_ENABLED` desligada por padrão |

## Validações manuais executadas nesta entrega

- `deno check` em todos os módulos `_shared/*` e nas 11 Edge Functions: OK.
- Site servido localmente e verificado com navegador headless (Edge) em
  **320 px** e **1366 px**: sem erros de console, sem scroll horizontal,
  cards renderizados a partir do mock, busca e carrinho funcionando.
- Modo `catalogProvider: "supabase"` com API simulada:
  - API fora do ar → estado de erro amigável, **nenhum produto mock exibido**;
  - API OK → produtos reais renderizados, badge "Novo" via tag, produto
    `available: false` recebe classe `is-soldout` e perde o botão de compra.
- `integration-status.html` sem backend configurado: botões
  administrativos desabilitados.

## Migration SQL

Sem `psql`/Docker disponíveis nesta máquina a migration foi revisada
manualmente. Para validar de fato:

```bash
supabase start          # requer Docker
supabase db reset       # aplica supabase/migrations/* do zero
```

Ou, após `supabase link`, `supabase db push --dry-run` mostra o que seria
aplicado sem executar.

## Testes ponta a ponta (após a configuração manual)

Ver `docs/BLING_SETUP_MANUAL.md` — ETAPA 6. Resumo:

1. `integration-health` → `database: true`, `blingConfigured: true`.
2. Conectar Bling → `bling-status` com `connected: true`.
3. `bling-sync-products` → o produto de teste **CAMISETA OGOCHI INFANTIL**
   aparece em `store_products` (somente leitura no Bling).
4. Alterar preço/estoque do produto de teste **pela interface do Bling**
   → webhook chega, `bling_webhook_events` registra e o cache atualiza.

Para simular um webhook localmente sem o Bling:

```bash
SECRET='<BLING_CLIENT_SECRET>'
BODY='{"eventId":"local-1","event":"product.updated","companyId":"1","date":"2026-09-04T12:00:00-03:00","version":"1.0","data":{"id":123}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')
curl -i -X POST "<URL_DAS_FUNCTIONS>/bling-webhook" \
  -H "Content-Type: application/json" \
  -H "X-Bling-Signature-256: sha256=$SIG" \
  --data "$BODY"
```

Enviar o mesmo `eventId` duas vezes deve responder `200 {"duplicate":true}`
na segunda chamada.
