/**
 * GET /admin-products  (painel /gestao/ — sessão Supabase Auth)
 * Visão administrativa do catálogo: inclui produtos inativos, mostra
 * bling_id/timestamps. Bling é fonte de verdade — este endpoint é
 * somente leitura, não existe edição de produto pelo navegador.
 */
import { requireAdminUser } from '../_shared/admin-user-auth.ts';
import { serve } from '../_shared/context.ts';
import { ValidationError } from '../_shared/errors.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';

serve(async (req, ctx) => {
  if (req.method !== 'GET') return methodNotAllowed(req, ['GET']);
  await requireAdminUser(req, ctx.db);

  const url = new URL(req.url);
  const activeParam = url.searchParams.get('active');
  const stockParam = url.searchParams.get('stock');
  if (stockParam && !['esgotado', 'baixo'].includes(stockParam)) {
    throw new ValidationError('stock inválido.', { allowed: ['esgotado', 'baixo'] });
  }

  const { items, total } = await ctx.repo.listAdminProducts({
    active: activeParam === 'true' ? true : activeParam === 'false' ? false : null,
    stock: (stockParam as 'esgotado' | 'baixo' | null) ?? null,
    category: url.searchParams.get('category'),
    search: url.searchParams.get('search'),
    limit: Number(url.searchParams.get('limit')) || undefined,
    offset: Number(url.searchParams.get('offset')) || undefined,
  });

  return json(req, { ok: true, items, total });
});
