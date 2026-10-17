import { serve } from '../_shared/context.ts';
import { requireAdminUser } from '../_shared/admin-user-auth.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';
import { ValidationError } from '../_shared/errors.ts';
import { processOrderJob, workerDeps } from '../_shared/bling-order-worker.ts';
serve(async (req, ctx) => {
  if (req.method !== 'POST') return methodNotAllowed(req, ['POST']);
  const admin = await requireAdminUser(req, ctx.db);
  const body = await req.json();
  if (!/^[a-f0-9-]{36}$/i.test(body.id ?? '')) throw new ValidationError('Pedido inválido.');
  if (body.action === 'sync') {
    return json(req, { ok: true, result: await processOrderJob(workerDeps(ctx, body.id)) });
  }
  const { error } = await ctx.db.rpc('admin_order_action', {
    p_id: body.id,
    p_action: body.action,
    p_actor: admin.id,
    p_reason: body.reason,
  });
  if (error) {
    throw new ValidationError(
      'Ação não permitida neste estado. Pagamentos e pedidos já enviados ao Bling exigem conferência na origem.',
    );
  }
  return json(req, { ok: true });
});
