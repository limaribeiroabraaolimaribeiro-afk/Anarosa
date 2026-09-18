/**
 * Simula os 5 cenários pedidos na auditoria de 2026-09-17 para o claim
 * de infinitepay-create-payment: UPDATE claim funciona; InfinitePay dá
 * timeout; dá 500; processo morre entre o claim e a gravação de
 * payment_url; cliente tenta de novo. Em nenhum cenário o pedido pode
 * ficar bloqueado para sempre, criar um segundo pedido, mudar o
 * total/preço ou marcar pagamento como pago.
 *
 * O fake abaixo implementa só a semântica desta query específica
 * (id, payment_status, payment_url IS NULL, OR de
 * payment_claim_expires_at) — não é um simulador genérico de Postgres,
 * é fiel apenas ao que tryClaimPaymentLinkCreation/releasePaymentLinkClaim
 * realmente enviam.
 */
import assert from 'node:assert/strict';
import { releasePaymentLinkClaim, tryClaimPaymentLinkCreation } from '../_shared/payment-claim.ts';

interface OrderRow {
  id: string;
  payment_status: string;
  payment_url: string | null;
  payment_provider: string | null;
  payment_claim_expires_at: string | null;
  [k: string]: unknown;
}

function buildFakeDb(row: OrderRow) {
  // deno-lint-ignore no-explicit-any
  return {
    from(table: string) {
      if (table !== 'store_orders') throw new Error(`fake db: tabela inesperada "${table}"`);
      const filters: Record<string, unknown> = {};
      let orClause: string | null = null;
      let updatePayload: Record<string, unknown> | null = null;
      // Calcula o resultado (aplica a mutação se os filtros baterem).
      // Precisa ser chamável tanto de .maybeSingle() (cadeia do claim,
      // que termina em .select().maybeSingle()) quanto de .then()
      // (cadeia do release, que termina em .is() sem select nenhum —
      // exatamente como o supabase-js real, onde o próprio
      // PostgrestFilterBuilder é "thenable" a qualquer momento da cadeia).
      const compute = () => {
        let matches = Object.entries(filters).every(([col, val]) => row[col] === val);
        if (matches && orClause) {
          // "payment_claim_expires_at.is.null,payment_claim_expires_at.lt.<iso>"
          const now = new Date();
          const expiresAt = row.payment_claim_expires_at;
          matches = expiresAt == null || new Date(expiresAt) < now;
        }
        if (!matches) return { data: null, error: null };
        if (updatePayload) Object.assign(row, updatePayload);
        return { data: { id: row.id }, error: null };
      };
      // deno-lint-ignore no-explicit-any
      const builder: any = {
        update(payload: Record<string, unknown>) { updatePayload = payload; return builder; },
        eq(col: string, val: unknown) { filters[col] = val; return builder; },
        is(col: string, val: unknown) { filters[col] = val; return builder; },
        or(clause: string) { orClause = clause; return builder; },
        select() { return builder; },
        maybeSingle() { return Promise.resolve(compute()); },
        // deno-lint-ignore no-explicit-any
        then(resolve: any, reject: any) { return Promise.resolve(compute()).then(resolve, reject); },
      };
      return builder;
    },
  };
}

function pendingOrder(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id: 'order-1',
    payment_status: 'pending',
    payment_url: null,
    payment_provider: null,
    payment_claim_expires_at: null,
    ...overrides,
  };
}

Deno.test('claim: UPDATE claim funciona no caminho normal', async () => {
  const row = pendingOrder();
  const db = buildFakeDb(row);
  const claimed = await tryClaimPaymentLinkCreation(db, row.id, 30_000);
  assert.equal(claimed, true);
  assert.equal(row.payment_provider, 'infinitepay');
  assert.ok(row.payment_claim_expires_at, 'deve gravar um prazo de expiração');
});

Deno.test('claim: segunda tentativa concorrente (mesmo pedido, claim ainda válido) não reivindica de novo', async () => {
  const row = pendingOrder();
  const db = buildFakeDb(row);
  const first = await tryClaimPaymentLinkCreation(db, row.id, 30_000);
  const second = await tryClaimPaymentLinkCreation(db, row.id, 30_000);
  assert.equal(first, true);
  assert.equal(second, false, 'não pode reivindicar duas vezes enquanto o claim anterior não expirou');
});

Deno.test('claim: InfinitePay /links dá timeout/500 → release libera o pedido para nova tentativa imediata', async () => {
  const row = pendingOrder();
  const db = buildFakeDb(row);
  assert.equal(await tryClaimPaymentLinkCreation(db, row.id, 30_000), true);

  // simula o catch do index.ts: libera o claim após falha da InfinitePay
  await releasePaymentLinkClaim(db, row.id, { payment_raw_status: { last_create_error: 'infinitepay_timeout' } });
  assert.equal(row.payment_provider, null);
  assert.equal(row.payment_claim_expires_at, null);

  // nova tentativa do cliente funciona imediatamente, sem esperar TTL
  const retried = await tryClaimPaymentLinkCreation(db, row.id, 30_000);
  assert.equal(retried, true, 'após liberar o claim, uma nova tentativa deve conseguir reivindicar de novo');
});

Deno.test('claim: processo morre ENTRE o claim e a gravação de payment_url — pedido NÃO fica bloqueado para sempre', async () => {
  const row = pendingOrder();
  const db = buildFakeDb(row);
  // claim reivindicado; processo "morre" aqui — nem grava payment_url,
  // nem chega a rodar o release (nenhuma das duas coisas acontece).
  assert.equal(await tryClaimPaymentLinkCreation(db, row.id, 30_000), true);
  assert.equal(row.payment_url, null);
  assert.equal(row.payment_provider, 'infinitepay');

  // cliente tenta de novo IMEDIATAMENTE (dentro do TTL) — deve continuar
  // bloqueado (correto: pode haver uma tentativa legítima em andamento).
  const tooSoon = await tryClaimPaymentLinkCreation(db, row.id, 30_000);
  assert.equal(tooSoon, false);

  // simula o tempo passando além do TTL (30s) sem nenhum release ter
  // rodado — o claim expira sozinho.
  row.payment_claim_expires_at = new Date(Date.now() - 1000).toISOString();
  const afterTtl = await tryClaimPaymentLinkCreation(db, row.id, 30_000);
  assert.equal(afterTtl, true, 'depois do TTL expirar, uma nova tentativa deve conseguir reivindicar — nunca fica bloqueado para sempre');
  assert.equal(row.payment_url, null, 'o pedido continua sem link — nenhum estado inconsistente foi criado');
  assert.equal(row.payment_status, 'pending', 'nunca marca pago/mudou status por causa do claim expirado');
});

Deno.test('claim: pedido com payment_url já gravado nunca é reivindicado de novo (evita segundo link)', async () => {
  const row = pendingOrder({ payment_url: 'https://checkout.infinitepay.test/existing' });
  const db = buildFakeDb(row);
  const claimed = await tryClaimPaymentLinkCreation(db, row.id, 30_000);
  assert.equal(claimed, false, 'payment_url IS NULL é exigido pelo claim — pedido já com link não deve reentrar aqui');
});

Deno.test('claim: pedido já pago nunca é reivindicado (payment_status != pending)', async () => {
  const row = pendingOrder({ payment_status: 'paid' });
  const db = buildFakeDb(row);
  const claimed = await tryClaimPaymentLinkCreation(db, row.id, 30_000);
  assert.equal(claimed, false);
});

Deno.test('release: nunca desfaz um claim que já resultou em payment_url gravado', async () => {
  const row = pendingOrder({ payment_provider: 'infinitepay', payment_url: 'https://checkout.infinitepay.test/ok' });
  const db = buildFakeDb(row);
  await releasePaymentLinkClaim(db, row.id, {});
  assert.equal(row.payment_provider, 'infinitepay', 'release só afeta linhas com payment_url ainda nulo');
  assert.equal(row.payment_url, 'https://checkout.infinitepay.test/ok');
});
