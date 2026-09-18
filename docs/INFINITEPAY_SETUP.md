# InfinitePay — Checkout Integrado (ANAROSA)

Documentação da integração real de pagamento do site com a InfinitePay.
**Nenhuma cobrança real foi feita durante o desenvolvimento** — tudo foi
testado com `fetch` mockado (ver `supabase/functions/_tests/`).

## 1. Arquitetura

```
Cliente
  → checkout.html (carrinho, dados, entrega, pagamento)
  → storefront-checkout            (cria o pedido — preço/estoque validados no backend)
  → infinitepay-create-payment     (cria o link de cobrança — recalcula tudo a partir do pedido)
  → redireciona para a InfinitePay (checkout.infinitepay.com.br/<slug>)
  → cliente paga (Pix ou cartão — dados de cartão nunca passam pelo nosso site)
  → InfinitePay chama infinitepay-webhook  (gatilho, NÃO prova de pagamento)
  → infinitepay-webhook registra o evento e responde 200 IMEDIATAMENTE
  → reconciliação real roda em BACKGROUND (EdgeRuntime.waitUntil) e,
    se não rodar/falhar, é reprocessada por infinitepay-webhook-process
    (agendado via pg_cron, mesmo padrão do bling-webhook-process)
  → reconciliação chama payment_check (fonte de verdade)
  → payment_status = 'paid'  (RPC mark_order_paid, idempotente)
  → cliente é redirecionado para pedido-confirmado.html?token=<public_token>
  → Gestão Anarosa mostra o pedido como pago
```

`BLING_ORDER_SYNC_ENABLED` continua `false`. Um pedido pago só marca
`bling_sync_status='pending'` (fila) — **nada consome essa fila ainda**;
criar o pedido real no Bling a partir daí é uma etapa futura,
deliberadamente fora desta tarefa.

## 2. Documentação oficial usada

- https://www.infinitepay.io/checkout-documentacao (endpoints, payload, webhook)
- https://ajuda.infinitepay.io/pt-BR/articles/10766888-como-usar-o-checkout-integrado-da-infinitepay

Consultadas em 2026-09-14/15. Nenhum endpoint, campo ou header foi
inventado — o que a documentação não define está listado na seção 7.

## 3. Configuração (variáveis de ambiente / secrets do Supabase)

| Variável | Valor | Observação |
|---|---|---|
| `INFINITEPAY_HANDLE` | `maia_14` | Infinite Tag da conta, **sem** o `$`. Não é uma credencial secreta na doc oficial, mas fica centralizada em `_shared/config.ts` — nunca hardcoded em Edge Function. |
| `INFINITEPAY_API_BASE_URL` | `https://api.checkout.infinitepay.io` | Padrão já embutido; só sobrescreva se a doc oficial mudar o host. |
| `INFINITEPAY_WEBHOOK_URL` | `https://gpmbkptimjipqsayrvce.supabase.co/functions/v1/infinitepay-webhook` | Padrão calculado a partir de `SUPABASE_URL` se não definida. |
| `INFINITEPAY_REDIRECT_URL` | `https://www.lojaanarosa.com.br/pedido-confirmado.html` | Padrão calculado a partir de `STOREFRONT_URL` se não definida. O backend sempre anexa `?token=<public_token>` por pedido. |

Nenhuma dessas variáveis pode aparecer no frontend — todas são lidas
só dentro das Edge Functions (`_shared/config.ts:getInfinitePayConfig()`).

## 4. Endpoints oficiais usados

### `POST https://api.checkout.infinitepay.io/links`
Cria o link de pagamento. Corpo enviado por `infinitepay-create-payment`:
`handle`, `order_nsu` (= `store_orders.id`, UUID — nunca reaproveitado
entre tentativas: o mesmo pedido sempre gera o mesmo `order_nsu`),
`items[]` (preço em **centavos**, calculado por `_shared/payment-mapper.ts`
a partir do pedido já validado — nunca do navegador), `redirect_url`,
`webhook_url`, `customer` (opcional) e `address` (opcional, só para
entrega — retirada nunca envia endereço). Resposta esperada: `{ "url": "..." }`.

### `POST https://api.checkout.infinitepay.io/payment_check`
Única fonte de verdade sobre pagamento. Corpo: `handle`, `order_nsu`,
`transaction_nsu`, `slug`. Resposta usada: `success`, `paid`, `amount`,
`paid_amount`, `installments`, `capture_method`.

### Webhook (`webhook_url` enviado na criação do link)
Payload recebido: `invoice_slug`, `amount`, `paid_amount`, `installments`,
`capture_method`, `transaction_nsu`, `order_nsu`, `receipt_url`, `items`.
Resposta: sempre `200 { success: true }` quando o corpo é JSON válido
com `order_nsu` (ver seção 6 sobre por quê).

## 5. Por que o webhook NUNCA marca "pago" por si só

A documentação oficial consultada **não define nenhum mecanismo de
assinatura/HMAC** para este webhook (sem header de assinatura, sem
secret compartilhado documentado). Por isso, tanto `infinitepay-webhook`
quanto `storefront-order-status` (quando o cliente volta com os
parâmetros do `redirect_url`) tratam qualquer dado recebido como **um
gatilho, nunca uma prova**:

1. registra o evento (idempotente, dedupe por `transaction_nsu` —
   `payment_webhook_events`, migration `20260914160000`);
2. chama `POST /payment_check` de volta para a InfinitePay, usando o
   `handle` que só o backend conhece;
3. só marca `payment_status = 'paid'` (RPC `mark_order_paid`) se
   `success === true`, `paid === true` **e** `amount` bater exatamente
   com o total do pedido (em centavos, calculado no backend);
4. se o valor divergir, o pedido **nunca** é marcado como pago — vira
   `payment_status = 'failed'` (RPC `payment_flag_failed`, estado
   INTERNO nosso, não um valor que a InfinitePay reporta) e fica visível
   na Gestão Anarosa para atendimento manual.

Isso está implementado em `supabase/functions/_shared/payment-reconcile.ts`
e coberto por testes em `_tests/payment-reconcile.test.ts` e
`_tests/e2e-infinitepay-flow.test.ts`.

## 6. Idempotência

- **Pedido**: `store_orders.idempotency_key` (unique) — clique duplo no
  checkout nunca cria dois pedidos (já existia antes desta tarefa).
- **Link de pagamento**: `infinitepay-create-payment` "reivindica" a
  criação com um claim ATÔMICO E COM PRAZO (`payment-claim.ts`,
  `payment_claim_expires_at`, 30s) antes de chamar a InfinitePay; se
  `payment_url` já existir, devolve o mesmo link em vez de criar outro.
  O prazo existe para o caso do processo morrer entre o claim e a
  gravação de `payment_url` — sem ele, o pedido ficaria bloqueado para
  sempre (ver seção 9).
- **Webhook**: dedupe por `(provider, transaction_nsu)` — evento
  repetido é ignorado sem reprocessar (`payment_register_webhook_event`).
- **Confirmação de pagamento**: `mark_order_paid` só transiciona
  `pending → paid` (guarda `WHERE payment_status = 'pending'`); uma
  segunda chamada (webhook duplicado, retorno do cliente + webhook
  quase simultâneos) é um no-op seguro.

## 7. Limitações conhecidas (documentação oficial não cobre)

- **Sem assinatura de webhook documentada** — mitigado pela
  reconciliação via `payment_check` (seção 5). Se a InfinitePay vier a
  documentar um mecanismo de assinatura, deve ser adicionado como uma
  camada extra, não uma substituição desta reconciliação.
- **Sem ambiente de sandbox documentado** — todos os testes automatizados
  usam `fetch` mockado; a primeira cobrança real (valor baixo, ver
  `docs/GO_LIVE_CHECKLIST.md` quando criado) precisa ser feita
  manualmente e com atenção.
- **Estados de pagamento**: a doc oficial só evidencia `paid: true/false`.
  Por isso `payment_status` só tem `pending | paid | failed | cancelled`
  — `failed` e `cancelled` são decisões internas nossas (anomalia
  detectada / cancelamento manual), não valores que a InfinitePay envia.
  Não implementamos `refunded`/`expired` por falta de evidência oficial.
- **`paid_amount` vs `amount`**: o exemplo da própria documentação mostra
  `amount: 1000, paid_amount: 1010` — valores diferentes (provável
  acréscimo de parcelamento). A reconciliação compara contra `amount`
  (o valor da cobrança), nunca contra `paid_amount`.

## 8. Arquivos

- `supabase/functions/_shared/config.ts` — `getInfinitePayConfig()`
- `supabase/functions/_shared/infinitepay-client.ts` — `createCheckoutLink`, `checkPayment`
- `supabase/functions/_shared/payment-mapper.ts` — reais → centavos, itens
- `supabase/functions/_shared/payment-reconcile.ts` — reconciliação (webhook + retorno do cliente)
- `supabase/functions/_shared/payment-claim.ts` — claim atômico com TTL do link de pagamento
- `supabase/functions/_shared/payment-webhook-queue.ts` — fila/retry do webhook (background + sweep)
- `supabase/functions/infinitepay-create-payment/index.ts`
- `supabase/functions/infinitepay-webhook/index.ts`
- `supabase/functions/infinitepay-webhook-process/index.ts` — sweep de reprocessamento (admin/cron)
- `supabase/functions/storefront-order-status/index.ts`
- `pedido-confirmado.html` + `js/pedido-confirmado.js`

## 9. Auditoria de confiabilidade pré-produção (2026-09-17)

Dois achados corrigidos antes de qualquer chamada real:

1. **`infinitepay-webhook` aguardava `payment_check` de forma síncrona**
   antes de responder — risco de exceder o tempo recomendado pela
   InfinitePay (<1s) e, pior, se o processo morresse durante essa
   chamada, o evento nunca seria reconciliado (a InfinitePay não
   redelivera depois de um 200). Corrigido: o evento é registrado e o
   webhook responde 200 IMEDIATAMENTE; a reconciliação roda em
   background (`EdgeRuntime.waitUntil`) e, se isso não acontecer/falhar,
   uma fila com backoff (`payment_webhook_events.retry_count`/
   `next_retry_at`) é reprocessada por `infinitepay-webhook-process`
   (mesmo padrão já usado pelo `bling-webhook-process`). **Ativação
   manual necessária** (mesma etapa do Bling): inserir em
   `private.integration_settings` as chaves
   `infinitepay_webhook_process_url` (URL da função
   `infinitepay-webhook-process`) e `infinitepay_webhook_process_secret`
   (valor de `INTEGRATION_ADMIN_SECRET`) — sem isso, o sweep de pg_cron
   simplesmente não faz nada (nenhum erro), e só o processamento em
   background continua ativo.
2. **Claim de criação do link sem prazo** — se o processo morresse entre
   reivindicar o claim e gravar `payment_url`, o pedido ficava bloqueado
   para sempre (nenhuma tentativa futura conseguia reivindicar de novo).
   Corrigido com TTL de 30s (`payment_claim_expires_at`) — ver
   `_shared/payment-claim.ts` e os 5 cenários simulados em
   `_tests/payment-claim.test.ts`.

Migration: `20260917120000_infinitepay_reliability_fixes.sql`.
- `supabase/migrations/20260914160000_orders_payments_omnichannel.sql`

## 9. Rollback

Se algo precisar ser desligado rapidamente:
1. Remover/limpar `INFINITEPAY_HANDLE` do ambiente — `infinitepay-create-payment`
   passa a responder `config_error` (nenhum link novo é criado).
2. O checkout continua funcionando para "Cartão na retirada" e
   "Combinar pelo WhatsApp" (não dependem da InfinitePay).
3. Nenhuma migration precisa ser revertida — as colunas novas ficam
   inertes se a integração for desligada (não há trigger automático de
   Bling consumindo `bling_sync_status='pending'` nesta versão).
