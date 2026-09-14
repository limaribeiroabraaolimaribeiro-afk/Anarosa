/**
 * GET /admin-customers  (painel /gestao/ — sessão Supabase Auth)
 * Visão agregada de clientes, derivada de store_orders (ver
 * admin_customers_summary() na migration) — nenhuma tabela nova de
 * clientes, nada duplicado.
 */
import { requireAdminUser } from '../_shared/admin-user-auth.ts';
import { serve } from '../_shared/context.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';

serve(async (req, ctx) => {
  if (req.method !== 'GET') return methodNotAllowed(req, ['GET']);
  await requireAdminUser(req, ctx.db);

  const url = new URL(req.url);
  const items = await ctx.adminRepo.getCustomersSummary({
    search: url.searchParams.get('search'),
    limit: Number(url.searchParams.get('limit')) || undefined,
    offset: Number(url.searchParams.get('offset')) || undefined,
  });

  return json(req, { ok: true, items });
});
