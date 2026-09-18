import assert from 'node:assert/strict';
import { CatalogRepository, OrderItemRejectedError } from '../_shared/catalog-repo.ts';
import { buildIdempotencyKey, validateOrderInput } from '../_shared/order-mapper.ts';

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

interface FakeCatalogData {
  productsBySlug: Record<string, Row | null>;
  variantsByKey: Record<string, Row | null>; // key = `${productId}::${variantBlingId}`
  inventoryTotals: Record<string, { physical_stock: number; virtual_stock: number | null; available_stock: number }>;
}

/**
 * Fake mínimo do cliente Supabase, cobrindo exatamente as chamadas que
 * CatalogRepository.resolveOrderItems() / stockFor() fazem. Não usa
 * rede nem banco real — só valida a LÓGICA de resolução/validação.
 */
function buildFakeDb(data: FakeCatalogData) {
  return {
    // deno-lint-ignore no-explicit-any
    from(table: string): any {
      if (table === 'store_products') {
        return {
          select: () => ({
            eq: (_col: string, slug: string) => ({
              maybeSingle: () => Promise.resolve({ data: data.productsBySlug[slug] ?? null, error: null }),
            }),
          }),
        };
      }
      if (table === 'store_product_variants') {
        return {
          select: () => ({
            eq: (_col1: string, variantBlingId: string) => ({
              eq: (_col2: string, productId: string) => ({
                maybeSingle: () =>
                  Promise.resolve({ data: data.variantsByKey[`${productId}::${variantBlingId}`] ?? null, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === 'store_stock_totals') {
        return { select: () => ({ in: () => Promise.resolve({ data: [], error: null }) }) };
      }
      if (table === 'store_inventory') {
        return {
          select: () => ({
            eq: () => ({
              in: (_col: string, ids: string[]) =>
                Promise.resolve({
                  data: ids
                    .filter((id) => data.inventoryTotals[id])
                    .map((id) => ({ bling_product_id: id, ...data.inventoryTotals[id] })),
                  error: null,
                }),
            }),
          }),
        };
      }
      throw new Error(`fake db: tabela inesperada "${table}"`);
    },
  };
}

const BASE_PRODUCT = {
  id: 'p-1', bling_id: '1001', sku: 'OG-001', name: 'Camiseta Ogochi Infantil',
  price: 60, promotional_price: null, active: true,
};

Deno.test('resolveOrderItems: caminho feliz — produto simples com estoque suficiente', async () => {
  const db = buildFakeDb({
    productsBySlug: { 'camiseta-ogochi-infantil': BASE_PRODUCT },
    variantsByKey: {},
    inventoryTotals: { '1001': { physical_stock: 5, virtual_stock: 5, available_stock: 5 } },
  });
  const repo = new CatalogRepository(db);
  const [item] = await repo.resolveOrderItems([{ slug: 'camiseta-ogochi-infantil', quantity: 2 }]);
  assert.equal(item.blingProductId, '1001');
  assert.equal(item.unitPrice, 60);
  assert.equal(item.name, 'Camiseta Ogochi Infantil');
  assert.equal(item.availableStock, 5);
  assert.equal(item.quantity, 2);
});

Deno.test('resolveOrderItems: preço vem do promotional_price quando existir (nunca do cliente)', async () => {
  const db = buildFakeDb({
    productsBySlug: { produto: { ...BASE_PRODUCT, price: 100, promotional_price: 79.9 } },
    variantsByKey: {},
    inventoryTotals: { '1001': { physical_stock: 3, virtual_stock: 3, available_stock: 3 } },
  });
  const repo = new CatalogRepository(db);
  // O "unitPrice" abaixo não existe no tipo de entrada — resolveOrderItems
  // nem aceita preço vindo do chamador; isto é o ponto do teste.
  const [item] = await repo.resolveOrderItems([{ slug: 'produto', quantity: 1 }]);
  assert.equal(item.unitPrice, 79.9);
});

Deno.test('resolveOrderItems: produto inexistente → product_not_found', async () => {
  const db = buildFakeDb({ productsBySlug: {}, variantsByKey: {}, inventoryTotals: {} });
  const repo = new CatalogRepository(db);
  await assert.rejects(
    () => repo.resolveOrderItems([{ slug: 'nao-existe', quantity: 1 }]),
    (err: OrderItemRejectedError) => {
      assert.ok(err instanceof OrderItemRejectedError);
      assert.equal(err.reason, 'product_not_found');
      assert.equal(err.slug, 'nao-existe');
      assert.equal(err.httpStatus, 400);
      return true;
    },
  );
});

Deno.test('resolveOrderItems: produto inativo → product_inactive, nunca deixa comprar', async () => {
  const db = buildFakeDb({
    productsBySlug: { produto: { ...BASE_PRODUCT, active: false } },
    variantsByKey: {},
    inventoryTotals: { '1001': { physical_stock: 10, virtual_stock: 10, available_stock: 10 } },
  });
  const repo = new CatalogRepository(db);
  await assert.rejects(
    () => repo.resolveOrderItems([{ slug: 'produto', quantity: 1 }]),
    (err: OrderItemRejectedError) => {
      assert.equal(err.reason, 'product_inactive');
      return true;
    },
  );
});

Deno.test('resolveOrderItems: variação existente e ativa — preço/estoque da variação', async () => {
  const db = buildFakeDb({
    productsBySlug: { camiseta: BASE_PRODUCT },
    variantsByKey: {
      'p-1::2001': { id: 'v-1', bling_id: '2001', product_id: 'p-1', sku: 'OG-001-M', name: 'M', price: 65, promotional_price: null, active: true },
    },
    inventoryTotals: { '2001': { physical_stock: 4, virtual_stock: 4, available_stock: 4 } },
  });
  const repo = new CatalogRepository(db);
  const [item] = await repo.resolveOrderItems([{ slug: 'camiseta', variantBlingId: '2001', quantity: 1 }]);
  assert.equal(item.blingProductId, '2001');
  assert.equal(item.variantBlingId, '2001');
  assert.equal(item.unitPrice, 65);
  assert.equal(item.name, 'Camiseta Ogochi Infantil — M');
});

Deno.test('resolveOrderItems: variação inexistente → variant_not_found', async () => {
  const db = buildFakeDb({
    productsBySlug: { camiseta: BASE_PRODUCT },
    variantsByKey: {},
    inventoryTotals: {},
  });
  const repo = new CatalogRepository(db);
  await assert.rejects(
    () => repo.resolveOrderItems([{ slug: 'camiseta', variantBlingId: '9999', quantity: 1 }]),
    (err: OrderItemRejectedError) => {
      assert.equal(err.reason, 'variant_not_found');
      return true;
    },
  );
});

Deno.test('resolveOrderItems: variação inativa → variant_inactive', async () => {
  const db = buildFakeDb({
    productsBySlug: { camiseta: BASE_PRODUCT },
    variantsByKey: {
      'p-1::2001': { id: 'v-1', bling_id: '2001', product_id: 'p-1', name: 'M', price: 65, active: false },
    },
    inventoryTotals: {},
  });
  const repo = new CatalogRepository(db);
  await assert.rejects(
    () => repo.resolveOrderItems([{ slug: 'camiseta', variantBlingId: '2001', quantity: 1 }]),
    (err: OrderItemRejectedError) => {
      assert.equal(err.reason, 'variant_inactive');
      return true;
    },
  );
});

Deno.test('resolveOrderItems: estoque insuficiente → insufficient_stock (nunca deixa passar de propósito)', async () => {
  const db = buildFakeDb({
    productsBySlug: { produto: BASE_PRODUCT },
    variantsByKey: {},
    inventoryTotals: { '1001': { physical_stock: 1, virtual_stock: 1, available_stock: 1 } },
  });
  const repo = new CatalogRepository(db);
  await assert.rejects(
    () => repo.resolveOrderItems([{ slug: 'produto', quantity: 5 }]),
    (err: OrderItemRejectedError) => {
      assert.equal(err.reason, 'insufficient_stock');
      assert.match(err.message, /disponível: 1/);
      assert.match(err.message, /solicitado: 5/);
      return true;
    },
  );
});

Deno.test('resolveOrderItems: sem informação de estoque (null) não bloqueia — mesma regra do storefront público', async () => {
  const db = buildFakeDb({
    productsBySlug: { produto: BASE_PRODUCT },
    variantsByKey: {},
    inventoryTotals: {}, // nenhuma linha de estoque
  });
  const repo = new CatalogRepository(db);
  const [item] = await repo.resolveOrderItems([{ slug: 'produto', quantity: 3 }]);
  assert.equal(item.availableStock, null);
});

Deno.test('resolveOrderItems: segundo item inválido interrompe e aponta o item certo (não o primeiro)', async () => {
  const db = buildFakeDb({
    productsBySlug: {
      valido: BASE_PRODUCT,
      invalido: { ...BASE_PRODUCT, id: 'p-2', bling_id: '1002', active: false },
    },
    variantsByKey: {},
    inventoryTotals: { '1001': { physical_stock: 10, virtual_stock: 10, available_stock: 10 } },
  });
  const repo = new CatalogRepository(db);
  await assert.rejects(
    () => repo.resolveOrderItems([{ slug: 'valido', quantity: 1 }, { slug: 'invalido', quantity: 1 }]),
    (err: OrderItemRejectedError) => {
      assert.equal(err.slug, 'invalido');
      assert.equal(err.reason, 'product_inactive');
      return true;
    },
  );
});

// ---------------------------------------------------------------------
// Integração: itens resolvidos (preço/nome do backend) fluem
// corretamente para validateOrderInput/buildIdempotencyKey — o mesmo
// caminho usado por storefront-checkout.
// ---------------------------------------------------------------------
Deno.test('checkout: itens resolvidos pelo backend geram totais e idempotency key corretos', async () => {
  const db = buildFakeDb({
    productsBySlug: { camiseta: { ...BASE_PRODUCT, price: 60, promotional_price: null } },
    variantsByKey: {},
    inventoryTotals: { '1001': { physical_stock: 10, virtual_stock: 10, available_stock: 10 } },
  });
  const repo = new CatalogRepository(db);
  const resolved = await repo.resolveOrderItems([{ slug: 'camiseta', quantity: 2 }]);

  const order = await validateOrderInput({
    customer: { name: 'Cliente Teste', phone: '47999999999' },
    shipping: { method: 'pickup' },
    payment: { method: 'pix' },
    items: resolved.map((r) => ({
      blingProductId: r.blingProductId,
      variantBlingId: r.variantBlingId,
      sku: r.sku,
      name: r.name,
      quantity: r.quantity,
      unitPrice: r.unitPrice,
    })),
  });

  assert.equal(order.subtotal, 120);
  assert.equal(order.total, 120);
  assert.match(order.idempotencyKey, /^auto-[a-f0-9]{40}$/);

  const again = await buildIdempotencyKey({
    customer: { name: 'Cliente Teste', phone: '47999999999' },
    items: [{ blingProductId: '1001', name: 'Camiseta Ogochi Infantil', quantity: 2, unitPrice: 60 }],
  });
  assert.equal(order.idempotencyKey, again, 'mesmo pedido → mesma chave (protege contra clique duplo)');
});
