import { serve } from '../_shared/context.ts';
import { requireAdminUser } from '../_shared/admin-user-auth.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';
import { ValidationError } from '../_shared/errors.ts';
serve(async (req, ctx) => {
  if (req.method !== 'GET') return methodNotAllowed(req, ['GET']);
  await requireAdminUser(req, ctx.db);
  const id = new URL(req.url).searchParams.get('id') || '';
  if (!/^[1-9]\d{0,15}$/.test(id)) throw new ValidationError('SKU inválido.');
  const [stock, operations] = await Promise.all([
    ctx.db.from('store_inventory').select('deposit_id,physical_stock,virtual_stock,updated_at').eq(
      'bling_product_id',
      id,
    ),
    ctx.db.from('store_admin_operations').select('operation_key,status,result,created_at').like(
      'resource',
      `stock:${id}:%`,
    ).order('created_at', { ascending: false }).limit(30),
  ]);
  if (stock.error || operations.error) throw new Error('stock_history_unavailable');
  return json(req, { ok: true, balances: stock.data, operations: operations.data });
});
