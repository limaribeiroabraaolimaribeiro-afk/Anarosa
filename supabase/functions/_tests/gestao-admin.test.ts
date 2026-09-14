import assert from 'node:assert/strict';
import { requireAdminUser } from '../_shared/admin-user-auth.ts';
import { UnauthorizedError } from '../_shared/errors.ts';
import { AdminRepository } from '../_shared/admin-repo.ts';
import { CatalogRepository, type AdminProductListItem } from '../_shared/catalog-repo.ts';

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

function req(token?: string) {
  return new Request('https://x.test/admin-dashboard-summary', {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

// ---------------------------------------------------------------------
// requireAdminUser — nunca deixa passar quem não está na allowlist
// ---------------------------------------------------------------------
function fakeAuthDb(opts: {
  getUserResult?: { data: { user: { id: string } } | null; error: unknown };
  adminRow?: Row | null;
  adminError?: unknown;
}) {
  return {
    auth: {
      getUser: (_token: string) =>
        Promise.resolve(opts.getUserResult ?? { data: { user: { id: 'user-1' } }, error: null }),
    },
    from: (_table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: opts.adminRow ?? null, error: opts.adminError ?? null }),
        }),
      }),
    }),
  };
}

Deno.test('requireAdminUser: sem header Authorization → 401', async () => {
  const db = fakeAuthDb({});
  // deno-lint-ignore no-explicit-any
  await assert.rejects(() => requireAdminUser(req(), db as any), UnauthorizedError);
});

Deno.test('requireAdminUser: token inválido/expirado (getUser falha) → 401', async () => {
  const db = fakeAuthDb({ getUserResult: { data: null, error: { message: 'invalid token' } } });
  // deno-lint-ignore no-explicit-any
  await assert.rejects(() => requireAdminUser(req('bad-token'), db as any), UnauthorizedError);
});

Deno.test('requireAdminUser: sessão válida mas usuário NÃO está em store_admins → 401 (login válido ≠ autorizado)', async () => {
  const db = fakeAuthDb({ adminRow: null });
  // deno-lint-ignore no-explicit-any
  await assert.rejects(() => requireAdminUser(req('valid-session-token'), db as any), UnauthorizedError);
});

Deno.test('requireAdminUser: usuário está em store_admins mas active=false → 401', async () => {
  const db = fakeAuthDb({ adminRow: { user_id: 'user-1', email: 'x@x.com', name: 'X', active: false } });
  // deno-lint-ignore no-explicit-any
  await assert.rejects(() => requireAdminUser(req('valid-session-token'), db as any), UnauthorizedError);
});

Deno.test('requireAdminUser: sessão válida + admin ativo → retorna o usuário', async () => {
  const db = fakeAuthDb({ adminRow: { user_id: 'user-1', email: 'dona@anarosa.com', name: 'Dona da loja', active: true } });
  // deno-lint-ignore no-explicit-any
  const admin = await requireAdminUser(req('valid-session-token'), db as any);
  assert.deepEqual(admin, { id: 'user-1', email: 'dona@anarosa.com', name: 'Dona da loja' });
});

Deno.test('requireAdminUser: falha ao consultar store_admins → 401 (fecha, não abre)', async () => {
  const db = fakeAuthDb({ adminError: { message: 'connection reset' } });
  // deno-lint-ignore no-explicit-any
  await assert.rejects(() => requireAdminUser(req('valid-session-token'), db as any), UnauthorizedError);
});

// ---------------------------------------------------------------------
// AdminRepository — pedidos, dashboard, clientes
// ---------------------------------------------------------------------
Deno.test('AdminRepository.listOrders: grupo de status "novos" mapeia para pending', async () => {
  let capturedFilter: unknown = null;
  // deno-lint-ignore no-explicit-any
  const db: any = {
    from: () => ({
      select: () => ({
        order: () => ({
          range: () => ({
            in: (_col: string, values: string[]) => {
              capturedFilter = values;
              return Promise.resolve({ data: [], error: null, count: 0 });
            },
          }),
        }),
      }),
    }),
  };
  const repo = new AdminRepository(db);
  await repo.listOrders({ status: 'novos' });
  assert.deepEqual(capturedFilter, ['pending']);
});

Deno.test('AdminRepository.listOrders: status desconhecido é ignorado silenciosamente pelo repo (validação real fica no endpoint)', async () => {
  // deno-lint-ignore no-explicit-any
  const db: any = {
    from: () => ({
      select: () => ({
        order: () => ({
          range: () => Promise.resolve({ data: [], error: null, count: 0 }),
        }),
      }),
    }),
  };
  const repo = new AdminRepository(db);
  const result = await repo.listOrders({ status: 'nao-existe' });
  assert.deepEqual(result, { items: [], total: 0 });
});

Deno.test('AdminRepository.getOrderDetail: monta itens e campos sensíveis do pedido corretamente', async () => {
  const orderRow = {
    id: 'o-1', order_number: null, created_at: '2026-09-01T10:00:00Z',
    customer_data: { name: 'Maria', phone: '47999998888', email: 'maria@x.com', document: '12345678909' },
    shipping_data: { method: 'pickup' }, payment_data: { method: 'pix' },
    subtotal: 100, discount: 0, shipping: 0, total: 100,
    status: 'pending', bling_sync_status: 'disabled', metadata: { notes: 'entregar de manhã' },
  };
  const itemRows = [{ name: 'Camiseta', sku: 'OG-1', quantity: 2, unit_price: 50, total: 100 }];
  // deno-lint-ignore no-explicit-any
  const db: any = {
    from: (table: string) => {
      if (table === 'store_orders') {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: orderRow, error: null }) }) }) };
      }
      if (table === 'store_order_items') {
        return { select: () => ({ eq: () => Promise.resolve({ data: itemRows, error: null }) }) };
      }
      throw new Error('unexpected table ' + table);
    },
  };
  const repo = new AdminRepository(db);
  const detail = await repo.getOrderDetail('o-1');
  assert.ok(detail);
  assert.equal(detail!.customerName, 'Maria');
  assert.equal(detail!.customerDocument, '12345678909');
  assert.equal(detail!.itemCount, 1);
  assert.equal(detail!.items[0].total, 100);
  assert.equal(detail!.notes, 'entregar de manhã');
  assert.equal(detail!.blingSyncStatus, 'disabled');
});

Deno.test('AdminRepository.getOrderDetail: pedido inexistente → null (não lança)', async () => {
  // deno-lint-ignore no-explicit-any
  const db: any = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) };
  const repo = new AdminRepository(db);
  assert.equal(await repo.getOrderDetail('missing'), null);
});

Deno.test('AdminRepository.getDashboardSummary: mapeia a RPC e nunca inventa valor quando vazio', async () => {
  // deno-lint-ignore no-explicit-any
  const db: any = { rpc: (_name: string, _args: unknown) => Promise.resolve({ data: {}, error: null }) };
  const repo = new AdminRepository(db);
  const summary = await repo.getDashboardSummary();
  assert.deepEqual(summary, {
    newOrders: 0, ordersToday: 0, revenueToday: 0, revenueMonth: 0,
    activeProducts: 0, lowStockProducts: 0, outOfStockProducts: 0, customers: 0,
    lastWebhookAt: null, lastSyncAt: null, blingStatus: 'disconnected', blingConnected: false,
  });
});

Deno.test('AdminRepository.getDashboardSummary: falha da RPC vira DatabaseError (não mensagem vazia)', async () => {
  // deno-lint-ignore no-explicit-any
  const db: any = { rpc: () => Promise.resolve({ data: null, error: { message: '', code: '42501' } }) };
  const repo = new AdminRepository(db);
  await assert.rejects(() => repo.getDashboardSummary(), (err: Error) => {
    assert.match(err.message, /admin_dashboard_summary_failed/);
    assert.doesNotMatch(err.message, /admin_dashboard_summary_failed:\s*$/);
    return true;
  });
});

Deno.test('AdminRepository.getCustomersSummary: repassa parâmetros e converte números', async () => {
  let captured: Row = {};
  // deno-lint-ignore no-explicit-any
  const db: any = {
    rpc: (_name: string, args: Row) => {
      captured = args;
      return Promise.resolve({ data: [{ phone: '47999998888', name: 'Maria', email: null, order_count: '3', total_spent: '270.50', last_order_at: '2026-09-01T00:00:00Z' }], error: null });
    },
  };
  const repo = new AdminRepository(db);
  const items = await repo.getCustomersSummary({ search: 'maria', limit: 10, offset: 0 });
  assert.equal(captured.p_search, 'maria');
  assert.equal(captured.p_limit, 10);
  assert.equal(items[0].orderCount, 3);
  assert.equal(items[0].totalSpent, 270.5);
});

// ---------------------------------------------------------------------
// CatalogRepository.listAdminProducts — filtro de estoque + paginação
// (a correção: paginar no banco ANTES de calcular estoque quebraria
// "total"/páginas ao filtrar por esgotado/baixo)
// ---------------------------------------------------------------------
function fakeAdminProductsDb(products: Row[], inventoryByBlingId: Record<string, number>) {
  return {
    // deno-lint-ignore no-explicit-any
    from(table: string): any {
      if (table === 'store_categories') {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }), in: () => Promise.resolve({ data: [], error: null }) }) };
      }
      if (table === 'store_products') {
        return {
          select: () => ({
            is: () => ({
              order: () => ({
                range: () => Promise.resolve({ data: products, error: null, count: products.length }),
              }),
            }),
          }),
        };
      }
      if (table === 'store_product_variants') {
        return { select: () => ({ in: () => Promise.resolve({ data: [], error: null }) }) };
      }
      if (table === 'store_stock_totals') {
        return { select: () => ({ in: () => Promise.resolve({ data: [], error: null }) }) };
      }
      if (table === 'store_inventory') {
        return {
          select: () => ({
            eq: () => ({
              in: (_col: string, ids: string[]) => Promise.resolve({
                data: ids.filter((id) => id in inventoryByBlingId).map((id) => ({
                  bling_product_id: id, physical_stock: inventoryByBlingId[id], virtual_stock: inventoryByBlingId[id],
                  available_stock: inventoryByBlingId[id],
                })),
                error: null,
              }),
            }),
          }),
        };
      }
      throw new Error('unexpected table ' + table);
    },
  };
}

function product(id: string, blingId: string): Row {
  return { id, bling_id: blingId, sku: `SKU-${blingId}`, name: `Produto ${blingId}`, slug: `produto-${blingId}`, category_id: null, price: 50, promotional_price: null, active: true, images: [], updated_at: null, synced_at: null };
}

Deno.test('listAdminProducts: sem filtro de estoque, total vem da contagem do banco (paginação normal)', async () => {
  const products = [product('p1', '1'), product('p2', '2')];
  const db = fakeAdminProductsDb(products, { '1': 10, '2': 0 });
  const repo = new CatalogRepository(db);
  const { items, total } = await repo.listAdminProducts({ limit: 2, offset: 0 });
  assert.equal(total, 2);
  assert.equal(items.length, 2);
});

Deno.test('listAdminProducts: filtro "esgotado" recalcula total DEPOIS do estoque (não usa a contagem crua do banco)', async () => {
  // 3 produtos ativos; só 1 está esgotado (estoque 0)
  const products = [product('p1', '1'), product('p2', '2'), product('p3', '3')];
  const db = fakeAdminProductsDb(products, { '1': 10, '2': 0, '3': 5 });
  const repo = new CatalogRepository(db);
  const { items, total } = await repo.listAdminProducts({ stock: 'esgotado', limit: 50, offset: 0 });
  assert.equal(total, 1, 'total deve refletir só os produtos esgotados, não os 3 do banco');
  assert.equal(items.length, 1);
  assert.equal((items[0] as AdminProductListItem).blingId, '2');
});

Deno.test('listAdminProducts: filtro "baixo" + paginação em memória fatia corretamente', async () => {
  // 5 produtos com estoque baixo (limiar padrão 5): ids 10,20,30,40,50 com estoque 1..5
  const products = ['10', '20', '30', '40', '50'].map((id, i) => product(`p${i}`, id));
  const stock: Record<string, number> = { '10': 1, '20': 2, '30': 3, '40': 4, '50': 5 };
  const db = fakeAdminProductsDb(products, stock);
  const repo = new CatalogRepository(db);
  const page1 = await repo.listAdminProducts({ stock: 'baixo', limit: 2, offset: 0 });
  const page2 = await repo.listAdminProducts({ stock: 'baixo', limit: 2, offset: 2 });
  assert.equal(page1.total, 5);
  assert.equal(page2.total, 5);
  assert.equal(page1.items.length, 2);
  assert.equal(page2.items.length, 2);
  const seenIds = [...page1.items, ...page2.items].map((i) => (i as AdminProductListItem).blingId);
  assert.equal(new Set(seenIds).size, 4, 'páginas não devem repetir itens');
});

Deno.test('listAdminProducts: estoque desconhecido (null) nunca conta como esgotado nem baixo', async () => {
  const products = [product('p1', '1')];
  const db = fakeAdminProductsDb(products, {}); // sem linha de estoque -> available null
  const repo = new CatalogRepository(db);
  const esgotados = await repo.listAdminProducts({ stock: 'esgotado' });
  const baixos = await repo.listAdminProducts({ stock: 'baixo' });
  assert.equal(esgotados.total, 0);
  assert.equal(baixos.total, 0);
});
