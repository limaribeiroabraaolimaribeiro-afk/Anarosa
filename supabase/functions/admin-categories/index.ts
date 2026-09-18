/**
 * GET /admin-categories  (painel /gestao/ — sessão Supabase Auth)
 *
 * Lista categorias REAIS do Bling, a partir do CACHE já sincronizado
 * (store_categories, populado por GET /categorias/produtos — mesmo
 * escopo já usado pela sincronização de catálogo). Nenhuma chamada
 * nova ao Bling é feita aqui — evita gasto de rate limit só para
 * preencher um <select>. Usado pelo formulário de produto da Gestão
 * para nunca exigir que a cliente digite o id numérico da categoria.
 */
import { requireAdminUser } from '../_shared/admin-user-auth.ts';
import { serve } from '../_shared/context.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';

serve(async (req, ctx) => {
  if (req.method !== 'GET') return methodNotAllowed(req, ['GET']);
  await requireAdminUser(req, ctx.db);

  const items = await ctx.repo.listActiveCategories();
  return json(req, { ok: true, items }, 200);
});
