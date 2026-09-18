/**
 * E2E SIMULADO (sem dinheiro real, sem rede real): carrinho → itens em
 * centavos → link InfinitePay (fetch mockado) → webhook simulado →
 * payment_check mockado (paid=true, amount=6000) → pedido vira "paid"
 * via mark_order_paid. Espelha o exemplo pedido: "Camiseta Ogochi
 * Infantil R$ 60,00".
 */
import assert from 'node:assert/strict';
import type { AppContext } from '../_shared/context.ts';
import { InfinitePayClient } from '../_shared/infinitepay-client.ts';
import { buildCheckoutItems } from '../_shared/payment-mapper.ts';
import { reconcilePayment } from '../_shared/payment-reconcile.ts';
import { mockFetch, silentLogger, TEST_INFINITEPAY_CONFIG } from './helpers.ts';

Deno.test('E2E simulado: camiseta R$60 → link criado → webhook → payment_check paid → pedido pago', async () => {
  const order = { id: 'order-e2e-1', total: 60, payment_status: 'pending' as const };

  // 1) checkout → itens em centavos (nunca confia em preço do cliente;
  //    aqui já representamos o preço "resolvido pelo backend").
  const { items, totalCents } = buildCheckoutItems({
    items: [{ name: 'Camiseta Ogochi Infantil', sku: 'OG-001', quantity: 1, unitPrice: 60 }],
    shippingCost: 0,
    discount: 0,
    orderTotal: order.total,
  });
  assert.equal(totalCents, 6000);

  // 2) infinitepay-create-payment chamaria isto:
  const { fetchImpl, calls } = mockFetch([
    ['/links', () => new Response(JSON.stringify({ url: 'https://checkout.infinitepay.test/xyz789' }), { status: 200 })],
    ['/payment_check', () => new Response(JSON.stringify({
      success: true, paid: true, amount: 6000, paid_amount: 6000, installments: 1, capture_method: 'pix',
    }), { status: 200 })],
  ]);
  const { logger } = silentLogger();
  const client = new InfinitePayClient({ config: TEST_INFINITEPAY_CONFIG, logger, fetchImpl });

  const link = await client.createCheckoutLink({
    orderNsu: order.id,
    items,
    redirectUrl: 'https://loja.test/pedido-confirmado.html?token=tok123',
    webhookUrl: 'https://loja.test/functions/v1/infinitepay-webhook',
  });
  assert.equal(link.url, 'https://checkout.infinitepay.test/xyz789');

  // 3) InfinitePay dispara o webhook (simulado) — não confiamos nele
  //    diretamente: só usamos order_nsu/transaction_nsu/slug para
  //    disparar a reconciliação real via payment_check.
  const webhookPayload = {
    order_nsu: order.id,
    transaction_nsu: 'txn-e2e-1',
    invoice_slug: 'xyz789',
    amount: 6000,
    capture_method: 'pix',
  };

  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const fakeCtx = {
    db: {
      // deno-lint-ignore no-explicit-any
      rpc: async (name: string, args: any) => {
        rpcCalls.push({ name, args });
        if (name === 'mark_order_paid') return { data: true, error: null };
        return { data: null, error: null };
      },
    },
    logger,
    paymentClient: () => client,
  } as unknown as AppContext;

  const result = await reconcilePayment(fakeCtx, order, {
    transactionNsu: webhookPayload.transaction_nsu,
    invoiceSlug: webhookPayload.invoice_slug,
  });

  // 4) pedido vira "paid" — sem nenhuma cobrança/pedido real (tudo mockado).
  assert.deepEqual(result, { paid: true, changed: true, reason: 'confirmed' });
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].name, 'mark_order_paid');
  assert.equal(rpcCalls[0].args.p_order_id, order.id);
  assert.equal(rpcCalls[0].args.p_transaction_nsu, 'txn-e2e-1');

  // A chamada de payment_check foi feita de verdade contra o fetch mockado:
  const checkCall = calls.find((c) => c.url.includes('/payment_check'));
  assert.ok(checkCall, 'payment_check deveria ter sido chamado para reconciliar');
  const checkBody = JSON.parse(checkCall!.body ?? '{}');
  assert.equal(checkBody.order_nsu, order.id);
  assert.equal(checkBody.transaction_nsu, 'txn-e2e-1');
});
