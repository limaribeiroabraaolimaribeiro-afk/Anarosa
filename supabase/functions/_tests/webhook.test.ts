import assert from 'node:assert/strict';
import { hmacSha256Hex, timingSafeEqual } from '../_shared/crypto.ts';
import {
  computeWebhookSignature,
  MemoryWebhookEventStore,
  parseSignatureHeader,
  parseWebhookEvent,
  retryDelaySeconds,
  verifyWebhookSignature,
} from '../_shared/webhook.ts';
import { dispatchWebhookEvent, processRegisteredEvent } from '../_shared/webhook-handlers.ts';
import { silentLogger } from './helpers.ts';

const SECRET = 'webhook-test-secret';
const PAYLOAD = JSON.stringify({
  eventId: 'evt-001',
  date: '2026-09-04T12:00:00-03:00',
  version: '1.0',
  event: 'product.updated',
  companyId: '999',
  data: { id: 123, nome: 'CAMISETA TESTE', preco: 49.9 },
});

Deno.test('crypto: HMAC-SHA256 bate com vetor conhecido', async () => {
  const hex = await hmacSha256Hex('key', 'The quick brown fox jumps over the lazy dog');
  assert.equal(hex, 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
});

Deno.test('crypto: timingSafeEqual', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
  assert.equal(timingSafeEqual('', ''), true);
});

Deno.test('webhook: assinatura válida (sha256=<hex>) é aceita', async () => {
  const sig = `sha256=${await computeWebhookSignature(SECRET, PAYLOAD)}`;
  assert.equal(await verifyWebhookSignature(PAYLOAD, sig, SECRET), true);
  // maiúsculas no hex também são aceitas
  assert.equal(await verifyWebhookSignature(PAYLOAD, sig.toUpperCase().replace('SHA256', 'sha256'), SECRET), true);
});

Deno.test('webhook: assinatura inválida / ausente / secret errado é rejeitada', async () => {
  const sig = `sha256=${await computeWebhookSignature(SECRET, PAYLOAD)}`;
  assert.equal(await verifyWebhookSignature(PAYLOAD + ' ', sig, SECRET), false, 'corpo alterado');
  assert.equal(await verifyWebhookSignature(PAYLOAD, sig, 'outro-secret'), false, 'secret diferente');
  assert.equal(await verifyWebhookSignature(PAYLOAD, null, SECRET), false, 'sem header');
  assert.equal(await verifyWebhookSignature(PAYLOAD, 'sha256=zz', SECRET), false, 'header malformado');
  assert.equal(await verifyWebhookSignature(PAYLOAD, sig, ''), false, 'sem secret configurado');
  assert.equal(parseSignatureHeader('md5=abc'), null);
});

Deno.test('webhook: parse extrai eventId/event/data e rejeita payload inválido', () => {
  const evt = parseWebhookEvent(PAYLOAD);
  assert.equal(evt.eventId, 'evt-001');
  assert.equal(evt.event, 'product.updated');
  assert.equal(evt.companyId, '999');
  assert.equal(evt.data.id, 123);
  assert.throws(() => parseWebhookEvent('not json'));
  assert.throws(() => parseWebhookEvent(JSON.stringify({ event: 'x' })), /eventId/);
  assert.throws(() => parseWebhookEvent(JSON.stringify({ eventId: '1' })), /event/);
});

Deno.test('webhook: evento duplicado não é registrado duas vezes', async () => {
  const store = new MemoryWebhookEventStore();
  const evt = parseWebhookEvent(PAYLOAD);
  assert.equal(await store.register(evt), true);
  assert.equal(await store.register(evt), false);
  assert.equal(store.rows.size, 1);
});

Deno.test('webhook: processamento é executado uma única vez (claim atômico)', async () => {
  const store = new MemoryWebhookEventStore();
  const evt = parseWebhookEvent(PAYLOAD);
  await store.register(evt);

  let syncs = 0;
  const fakeClient = {
    getProductById: () => {
      syncs++;
      return Promise.resolve({ data: { id: 123, nome: 'CAMISETA TESTE', preco: 49.9, situacao: 'A', formato: 'S' } });
    },
    getStocks: () => Promise.resolve([{ produto: { id: 123 }, saldoFisicoTotal: 3, saldoVirtualTotal: 2, depositos: [] }]),
  };
  const fakeRepo = {
    upsertProduct: () => Promise.resolve({ productId: 'p-1', variantIds: new Map() }),
    findCategoryIdByBlingId: () => Promise.resolve(null),
    upsertInventory: (rows: unknown[]) => Promise.resolve(rows.length),
    deactivateByBlingId: () => Promise.resolve('product' as const),
  };
  const { logger } = silentLogger();
  // deno-lint-ignore no-explicit-any
  const deps = { client: fakeClient as any, repo: fakeRepo as any, logger };

  const first = await processRegisteredEvent(evt, store, deps);
  const second = await processRegisteredEvent(evt, store, deps);
  assert.equal(first, 'processed');
  assert.equal(second, 'skipped');
  assert.equal(syncs, 1);
});

Deno.test('webhook: evento não suportado é ignorado sem chamar o Bling', async () => {
  const { logger } = silentLogger();
  const evt = parseWebhookEvent(JSON.stringify({ eventId: 'e2', event: 'invoice.created', data: { id: 1 } }));
  const outcome = await dispatchWebhookEvent(evt, {
    // deno-lint-ignore no-explicit-any
    client: { getProductById: () => assert.fail('não deve chamar') } as any,
    // deno-lint-ignore no-explicit-any
    repo: {} as any,
    logger,
  });
  assert.equal(outcome, 'ignored');
});

Deno.test('webhook: product.deleted faz soft-disable', async () => {
  const { logger } = silentLogger();
  let disabled: string | null = null;
  const evt = parseWebhookEvent(JSON.stringify({ eventId: 'e3', event: 'product.deleted', data: { id: 77 } }));
  const outcome = await dispatchWebhookEvent(evt, {
    // deno-lint-ignore no-explicit-any
    client: {} as any,
    // deno-lint-ignore no-explicit-any
    repo: { deactivateByBlingId: (id: string) => { disabled = id; return Promise.resolve('product'); } } as any,
    logger,
  });
  assert.equal(outcome, 'processed');
  assert.equal(disabled, '77');
});

Deno.test('webhook: evento de estoque consulta o saldo atual no Bling (não confia no payload)', async () => {
  const { logger } = silentLogger();
  const asked: string[] = [];
  const evt = parseWebhookEvent(JSON.stringify({
    eventId: 'e4',
    event: 'stock.updated',
    data: { produto: { id: 55 }, deposito: { id: 1 }, saldoFisico: 999, saldoVirtual: 999 },
  }));
  let written: Array<Record<string, unknown>> = [];
  const outcome = await dispatchWebhookEvent(evt, {
    client: {
      getStocks: (ids: string[]) => {
        asked.push(...ids);
        return Promise.resolve([{ produto: { id: 55 }, saldoFisicoTotal: 4, saldoVirtualTotal: 3, depositos: [{ id: 1, saldoFisico: 4, saldoVirtual: 3 }] }]);
      },
      // deno-lint-ignore no-explicit-any
    } as any,
    repo: {
      upsertInventory: (rows: Array<Record<string, unknown>>) => { written = rows; return Promise.resolve(rows.length); },
      // deno-lint-ignore no-explicit-any
    } as any,
    logger,
  });
  assert.equal(outcome, 'processed');
  assert.deepEqual(asked, ['55']);
  const dep = written.find((r) => r.deposit_id === '1');
  assert.equal(dep?.physical_stock, 4, 'usa o saldo atual do Bling, não o 999 do payload');
});

Deno.test('webhook: backoff cresce e é limitado', () => {
  assert.equal(retryDelaySeconds(0), 60);
  assert.equal(retryDelaySeconds(1), 120);
  assert.equal(retryDelaySeconds(20), 6 * 60 * 60);
});
