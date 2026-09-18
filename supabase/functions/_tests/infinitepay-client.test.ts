import assert from 'node:assert/strict';
import { InfinitePayClient } from '../_shared/infinitepay-client.ts';
import { InfinitePayApiError, InfinitePayTimeoutError } from '../_shared/errors.ts';
import { mockFetch, silentLogger, TEST_INFINITEPAY_CONFIG } from './helpers.ts';

Deno.test('createCheckoutLink: envia handle/order_nsu/items e devolve a url', async () => {
  const { fetchImpl, calls } = mockFetch([
    ['/links', () => new Response(JSON.stringify({ url: 'https://checkout.infinitepay.test/abc123' }), { status: 200 })],
  ]);
  const client = new InfinitePayClient({ config: TEST_INFINITEPAY_CONFIG, logger: silentLogger().logger, fetchImpl });

  const result = await client.createCheckoutLink({
    orderNsu: 'order-1',
    items: [{ quantity: 1, price: 6000, description: 'Camiseta' }],
    redirectUrl: 'https://loja.test/pedido-confirmado.html',
    webhookUrl: 'https://loja.test/functions/v1/infinitepay-webhook',
  });

  assert.equal(result.url, 'https://checkout.infinitepay.test/abc123');
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].body ?? '{}');
  assert.equal(body.handle, 'maia_14');
  assert.equal(body.order_nsu, 'order-1');
  assert.deepEqual(body.items, [{ quantity: 1, price: 6000, description: 'Camiseta' }]);
  assert.equal(body.redirect_url, 'https://loja.test/pedido-confirmado.html');
  assert.equal(body.webhook_url, 'https://loja.test/functions/v1/infinitepay-webhook');
});

Deno.test('createCheckoutLink: resposta sem "url" → InfinitePayApiError', async () => {
  const { fetchImpl } = mockFetch([['/links', () => new Response(JSON.stringify({}), { status: 200 })]]);
  const client = new InfinitePayClient({ config: TEST_INFINITEPAY_CONFIG, logger: silentLogger().logger, fetchImpl });
  await assert.rejects(
    () => client.createCheckoutLink({ orderNsu: 'o1', items: [{ quantity: 1, price: 100, description: 'x' }], redirectUrl: 'https://x', webhookUrl: 'https://y' }),
    (err: unknown) => err instanceof InfinitePayApiError,
  );
});

Deno.test('createCheckoutLink: HTTP 500 → InfinitePayApiError com status', async () => {
  const { fetchImpl } = mockFetch([['/links', () => new Response('erro interno', { status: 500 })]]);
  const client = new InfinitePayClient({ config: TEST_INFINITEPAY_CONFIG, logger: silentLogger().logger, fetchImpl });
  await assert.rejects(
    () => client.createCheckoutLink({ orderNsu: 'o1', items: [{ quantity: 1, price: 100, description: 'x' }], redirectUrl: 'https://x', webhookUrl: 'https://y' }),
    (err: unknown) => err instanceof InfinitePayApiError && err.status === 500,
  );
});

Deno.test('checkPayment: paid=true — campos convertidos corretamente', async () => {
  const { fetchImpl, calls } = mockFetch([
    ['/payment_check', () => new Response(JSON.stringify({
      success: true, paid: true, amount: 6000, paid_amount: 6010, installments: 2, capture_method: 'credit_card',
    }), { status: 200 })],
  ]);
  const client = new InfinitePayClient({ config: TEST_INFINITEPAY_CONFIG, logger: silentLogger().logger, fetchImpl });
  const result = await client.checkPayment({ orderNsu: 'order-1', transactionNsu: 'txn-1', slug: 'abc123' });
  assert.equal(result.success, true);
  assert.equal(result.paid, true);
  assert.equal(result.amount, 6000);
  assert.equal(result.paidAmount, 6010);
  assert.equal(result.installments, 2);
  assert.equal(result.captureMethod, 'credit_card');
  const body = JSON.parse(calls[0].body ?? '{}');
  assert.equal(body.handle, 'maia_14');
  assert.equal(body.transaction_nsu, 'txn-1');
  assert.equal(body.slug, 'abc123');
});

Deno.test('checkPayment: paid=false é uma resposta válida (não lança)', async () => {
  const { fetchImpl } = mockFetch([
    ['/payment_check', () => new Response(JSON.stringify({ success: true, paid: false }), { status: 200 })],
  ]);
  const client = new InfinitePayClient({ config: TEST_INFINITEPAY_CONFIG, logger: silentLogger().logger, fetchImpl });
  const result = await client.checkPayment({ orderNsu: 'o1', transactionNsu: 't1', slug: 's1' });
  assert.equal(result.paid, false);
  assert.equal(result.amount, null);
});

Deno.test('checkPayment: timeout de rede → InfinitePayTimeoutError', async () => {
  const cfg = { ...TEST_INFINITEPAY_CONFIG, requestTimeoutMs: 20 };
  const fetchImpl = ((_input: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    })) as typeof fetch;
  const client = new InfinitePayClient({ config: cfg, logger: silentLogger().logger, fetchImpl });
  await assert.rejects(
    () => client.checkPayment({ orderNsu: 'o1', transactionNsu: 't1', slug: 's1' }),
    (err: unknown) => err instanceof InfinitePayTimeoutError,
  );
});
