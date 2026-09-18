import assert from 'node:assert/strict';
import { CatalogRepository } from '../_shared/catalog-repo.ts';

// deno-lint-ignore no-explicit-any
function buildFakeDb(rows: Record<string, unknown>[], error: Record<string, unknown> | null = null) {
  return {
    // deno-lint-ignore no-explicit-any
    from(table: string): any {
      if (table !== 'store_categories') throw new Error(`fake db: tabela inesperada "${table}"`);
      return {
        select: () => ({
          eq: () => ({
            order: () => Promise.resolve({ data: error ? null : rows, error }),
          }),
        }),
      };
    },
  };
}

Deno.test('listActiveCategories: mapeia bling_id/name do cache (nunca inventa categoria)', async () => {
  const repo = new CatalogRepository(buildFakeDb([
    { bling_id: '10', name: 'Camisetas' },
    { bling_id: '11', name: 'Calças' },
  ]));
  const items = await repo.listActiveCategories();
  assert.deepEqual(items, [
    { blingId: '10', name: 'Camisetas' },
    { blingId: '11', name: 'Calças' },
  ]);
});

Deno.test('listActiveCategories: cache vazio → lista vazia (não lança)', async () => {
  const repo = new CatalogRepository(buildFakeDb([]));
  assert.deepEqual(await repo.listActiveCategories(), []);
});

Deno.test('listActiveCategories: erro do banco vira DatabaseError (nunca mensagem vazia)', async () => {
  const repo = new CatalogRepository(buildFakeDb([], { message: 'connection refused', code: '08006' }));
  await assert.rejects(() => repo.listActiveCategories(), (err: Error) => {
    assert.match(err.message, /list_active_categories_failed/);
    return true;
  });
});
