/**
 * POST /bling-sync-product  (admin)
 * Body: { "blingId": "123" }
 * Sincroniza um único produto (consulta o estado atual no Bling).
 */
import { requireAdmin } from '../_shared/admin-auth.ts';
import { serve } from '../_shared/context.ts';
import { ValidationError } from '../_shared/errors.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';
import { syncProductById } from '../_shared/sync-service.ts';

serve(async (req, ctx) => {
  if (req.method !== 'POST') return methodNotAllowed(req, ['POST']);
  requireAdmin(req);

  let body: { blingId?: string | number } = {};
  try {
    body = await req.json();
  } catch {
    throw new ValidationError('Body JSON inválido.');
  }
  const blingId = body?.blingId != null ? String(body.blingId).trim() : '';
  if (!/^\d{1,20}$/.test(blingId)) throw new ValidationError('blingId inválido.');

  const result = await syncProductById(
    { client: ctx.client(), repo: ctx.repo, logger: ctx.logger, tokenStore: ctx.tokenStore },
    blingId,
    { syncStock: true },
  );

  return json(req, { ok: true, result });
});
