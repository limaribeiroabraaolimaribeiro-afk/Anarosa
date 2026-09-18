import assert from 'node:assert/strict';
import { CatalogRepository } from '../_shared/catalog-repo.ts';

// deno-lint-ignore no-explicit-any
function buildFakeDb(variantRows: Record<string, unknown>[]) {
  return {
    // deno-lint-ignore no-explicit-any
    from(table: string): any {
      if (table === 'store_product_variants') {
        return {
          select: () => ({
            eq: (_col: string, productId: string) => ({
              limit: () => Promise.resolve({ data: variantRows.filter((v) => v.product_id === productId), error: null }),
            }),
          }),
        };
      }
      throw new Error(`fake db: tabela inesperada "${table}"`);
    },
  };
}

Deno.test('productHasVariants: produto sem variação → false (editável)', async () => {
  const repo = new CatalogRepository(buildFakeDb([]));
  assert.equal(await repo.productHasVariants('p-1'), false);
});

Deno.test('productHasVariants: produto com variação → true (bloqueia edição via admin-product-update)', async () => {
  const repo = new CatalogRepository(buildFakeDb([{ id: 'v-1', product_id: 'p-1' }]));
  assert.equal(await repo.productHasVariants('p-1'), true);
});

Deno.test('productHasVariants: variações de OUTRO produto não afetam o resultado', async () => {
  const repo = new CatalogRepository(buildFakeDb([{ id: 'v-1', product_id: 'p-2' }]));
  assert.equal(await repo.productHasVariants('p-1'), false);
});
