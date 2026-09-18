import assert from 'node:assert/strict';
import { ValidationError } from '../_shared/errors.ts';
import {
  buildIdempotencyKey,
  computeOrderTotals,
  mapBlingOrderStatus,
  mapOrderToBling,
  validateOrderInput,
} from '../_shared/order-mapper.ts';

const VALID = {
  customer: { name: 'Maria Teste', email: 'maria@example.com', document: '123.456.789-09' },
  items: [
    { blingProductId: '2000', variantBlingId: '2001', sku: 'RD-AZ-M', name: 'Camiseta Azul M', quantity: 2, unitPrice: 89.9 },
    { blingProductId: '1001', name: 'Camiseta Ogochi', quantity: 1, unitPrice: 59.9 },
  ],
  shipping: { method: 'correios', cost: 20, address: { street: 'Rua A', number: '1', city: 'Luiz Alves', state: 'SC', zip: '89128000' } },
  discount: 10,
};

Deno.test('order: totais', () => {
  assert.deepEqual(computeOrderTotals(VALID.items, 10, 20), { subtotal: 239.7, discount: 10, shipping: 20, total: 249.7 });
  assert.equal(computeOrderTotals([{ quantity: 1, unitPrice: 5 }], 100, 0).total, 0, 'nunca negativo');
});

Deno.test('order: validação normaliza documento e calcula totais', async () => {
  const order = await validateOrderInput(VALID);
  assert.equal(order.customer.document, '12345678909');
  assert.equal(order.subtotal, 239.7);
  assert.equal(order.total, 249.7);
  assert.equal(order.items[0].total, 179.8);
  assert.match(order.idempotencyKey, /^auto-[a-f0-9]{40}$/);
});

Deno.test('order: entrada inválida → ValidationError com lista de erros', async () => {
  await assert.rejects(
    () => validateOrderInput({ customer: { name: '' }, items: [{ blingProductId: '', quantity: 0, unitPrice: -1 }] }),
    (err: ValidationError) => {
      assert.ok(err instanceof ValidationError);
      const errors = err.details?.errors as string[];
      assert.ok(errors.some((e) => e.includes('customer.name')));
      assert.ok(errors.some((e) => e.includes('quantity')));
      assert.ok(errors.some((e) => e.includes('unitPrice')));
      return true;
    },
  );
  await assert.rejects(() => validateOrderInput({ customer: { name: 'X' }, items: [] }), ValidationError);
});

Deno.test('order idempotency: mesmo conteúdo → mesma chave; conteúdo diferente → chave diferente', async () => {
  const a = await buildIdempotencyKey(VALID);
  const b = await buildIdempotencyKey(JSON.parse(JSON.stringify(VALID)));
  const c = await buildIdempotencyKey({ ...VALID, items: [{ ...VALID.items[0], quantity: 3 }] });
  assert.equal(a, b);
  assert.notEqual(a, c);
  // ordem dos itens não altera a chave
  const d = await buildIdempotencyKey({ ...VALID, items: [VALID.items[1], VALID.items[0]] });
  assert.equal(a, d);
});

Deno.test('order idempotency: chave fornecida pelo cliente é respeitada e validada', async () => {
  assert.equal(await buildIdempotencyKey({ ...VALID, idempotencyKey: 'checkout:abc-123' }), 'checkout:abc-123');
  await assert.rejects(() => buildIdempotencyKey({ ...VALID, idempotencyKey: 'x' }), ValidationError);
  await assert.rejects(() => buildIdempotencyKey({ ...VALID, idempotencyKey: 'bad key with spaces' }), ValidationError);
});

Deno.test('order: mapeamento para POST /pedidos/vendas', async () => {
  const order = await validateOrderInput({ ...VALID, idempotencyKey: 'checkout:abc-123' });
  const payload = mapOrderToBling(order, { date: new Date('2026-09-04T10:00:00Z') });
  assert.equal(payload.data, '2026-09-04');
  assert.equal(payload.contato.nome, 'Maria Teste');
  assert.equal(payload.contato.tipoPessoa, 'F');
  assert.equal(payload.contato.numeroDocumento, '12345678909');
  assert.equal(payload.itens.length, 2);
  assert.deepEqual(payload.itens[0].produto, { id: 2001 }, 'variação usa o id da variação');
  assert.deepEqual(payload.itens[1].produto, { id: 1001 });
  assert.equal(payload.itens[0].quantidade, 2);
  assert.equal(payload.itens[0].valor, 89.9);
  assert.deepEqual(payload.desconto, { valor: 10, unidade: 'REAL' });
  assert.equal(payload.transporte.frete, 20);
  assert.ok(payload.observacoesInternas.includes('checkout:abc-123'));
});

Deno.test('order: status do Bling → interno (conservador)', () => {
  assert.equal(mapBlingOrderStatus({ situacao: { id: 12 } }), 'cancelled');
  assert.equal(mapBlingOrderStatus({ situacao: { id: 999 } }), 'pending');
  assert.equal(mapBlingOrderStatus({}), 'pending');
});
