/**
 * POST /bling-sync-products  (admin, execução MANUAL)
 * Sincronização completa: categorias → produtos (com variações) → estoque.
 * Somente leitura no Bling.
 */
import { requireAdmin } from '../_shared/admin-auth.ts';
import { serve } from '../_shared/context.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';
import { syncAllProducts } from '../_shared/sync-service.ts';

serve(async (req, ctx) => {
  if (req.method !== 'POST') return methodNotAllowed(req, ['POST']);
  requireAdmin(req);

  const summary = await syncAllProducts({
    client: ctx.client(),
    repo: ctx.repo,
    logger: ctx.logger,
    tokenStore: ctx.tokenStore,
  });

  return json(req, { ok: summary.errors.length === 0, summary });
});
