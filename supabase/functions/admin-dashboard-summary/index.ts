/**
 * GET /admin-dashboard-summary  (painel /gestao/ — sessão Supabase Auth)
 * Resumo do Dashboard numa única chamada (ver admin_dashboard_summary()
 * na migration). Nenhum segredo, nenhum dado de outro cliente.
 */
import { requireAdminUser } from '../_shared/admin-user-auth.ts';
import { serve } from '../_shared/context.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';

serve(async (req, ctx) => {
  if (req.method !== 'GET') return methodNotAllowed(req, ['GET']);
  const admin = await requireAdminUser(req, ctx.db);

  const summary = await ctx.adminRepo.getDashboardSummary();
  ctx.logger.info('admin.dashboard', 'resumo consultado', { entityId: admin.id });

  return json(req, { ok: true, summary });
});
