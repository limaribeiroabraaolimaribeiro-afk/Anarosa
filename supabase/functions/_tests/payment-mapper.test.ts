import assert from 'node:assert/strict';
import { buildCheckoutItems, toCents } from '../_shared/payment-mapper.ts';

Deno.test('toCents: converte reais para centavos sem erro de float', () => {
  assert.equal(toCents(60), 6000);
  assert.equal(toCents(79.9), 7990);
  assert.equal(toCents(0.1 + 0.2), 30); // clássico erro de float (0.1+0.2=0.30000000000000004)
});

Deno.test('buildCheckoutItems: item único sem desconto/frete — soma bate exatamente', () => {
  const { items, totalCents } = buildCheckoutItems({
    items: [{ name: 'Camiseta Ogochi Infantil', sku: 'OG-001', quantity: 1, unitPrice: 60 }],
    shippingCost: 0,
    discount: 0,
    orderTotal: 60,
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].price, 6000);
  assert.equal(items[0].quantity, 1);
  assert.equal(items[0].description, 'Camiseta Ogochi Infantil (OG-001)');
  assert.equal(totalCents, 6000);
});

Deno.test('buildCheckoutItems: múltiplos itens + frete — soma bate com orderTotal', () => {
  const { items, totalCents } = buildCheckoutItems({
    items: [
      { name: 'Camiseta P', quantity: 2, unitPrice: 60 },
      { name: 'Camiseta M', quantity: 1, unitPrice: 65.5 },
    ],
    shippingCost: 15,
    discount: 0,
    orderTotal: 2 * 60 + 65.5 + 15,
  });
  assert.equal(totalCents, toCents(2 * 60 + 65.5 + 15));
  const sum = items.reduce((s, it) => s + it.quantity * it.price, 0);
  assert.equal(sum, totalCents, 'soma dos itens enviados à InfinitePay deve bater exatamente com o total');
  assert.ok(items.some((it) => it.description === 'Frete' && it.price === 1500));
});

Deno.test('buildCheckoutItems: desconto proporcional nunca gera preço negativo e soma bate exatamente', () => {
  const { items, totalCents } = buildCheckoutItems({
    items: [
      { name: 'Item A', quantity: 3, unitPrice: 33.33 },
      { name: 'Item B', quantity: 1, unitPrice: 10 },
    ],
    shippingCost: 0,
    discount: 20, // gera razão de desconto não-inteira em centavos por item
    orderTotal: 3 * 33.33 + 10 - 20,
  });
  const sum = items.reduce((s, it) => s + it.quantity * it.price, 0);
  assert.equal(sum, totalCents);
  assert.equal(totalCents, toCents(3 * 33.33 + 10 - 20));
  for (const it of items) assert.ok(it.price >= 0, 'nenhum item pode ter preço negativo');
});

Deno.test('buildCheckoutItems: desconto igual ao subtotal — zera itens sem ficar negativo', () => {
  const { items, totalCents } = buildCheckoutItems({
    items: [{ name: 'Item único', quantity: 1, unitPrice: 50 }],
    shippingCost: 10,
    discount: 50,
    orderTotal: 10,
  });
  assert.equal(totalCents, 1000);
  for (const it of items) assert.ok(it.price >= 0);
});

Deno.test('buildCheckoutItems: desconto maior que o subtotal é limitado (nunca fica negativo)', () => {
  const { totalCents } = buildCheckoutItems({
    items: [{ name: 'Item', quantity: 1, unitPrice: 50 }],
    shippingCost: 0,
    discount: 9999, // tentativa de "desconto" absurdo — clamp interno
    orderTotal: 0,
  });
  assert.equal(totalCents, 0);
});

Deno.test('buildCheckoutItems: descrição sanitizada (sem quebras de linha, tamanho limitado)', () => {
  const { items } = buildCheckoutItems({
    items: [{ name: 'Nome\ncom\tquebras   e   espaços'.repeat(10), quantity: 1, unitPrice: 10 }],
    shippingCost: 0,
    discount: 0,
    orderTotal: 10,
  });
  assert.ok(!items[0].description.includes('\n'));
  assert.ok(!items[0].description.includes('\t'));
  assert.ok(items[0].description.length <= 250);
});

Deno.test('buildCheckoutItems: sem itens e sem frete — retorna vazio', () => {
  const { items, totalCents } = buildCheckoutItems({ items: [], shippingCost: 0, discount: 0, orderTotal: 0 });
  assert.deepEqual(items, []);
  assert.equal(totalCents, 0);
});
