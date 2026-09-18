/**
 * GET /storefront-product?slug=<slug>
 * Detalhe público de um produto a partir do cache. Nunca consulta o Bling.
 */
import { serve } from '../_shared/context.ts';
import { NotFoundError, ValidationError } from '../_shared/errors.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';

serve(async (req, ctx) => {
  if (req.method !== 'GET') return methodNotAllowed(req, ['GET']);

  const url = new URL(req.url);
  const slug = url.searchParams.get('slug')?.trim() ?? '';
  if (!/^[a-z0-9-]{1,140}$/.test(slug)) throw new ValidationError('slug inválido.');

  const product = await ctx.repo.getPublicProductBySlug(slug);
  if (!product) throw new NotFoundError('Produto não encontrado.');

  return json(req, { ok: true, product }, 200, {
    'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
  });
});
