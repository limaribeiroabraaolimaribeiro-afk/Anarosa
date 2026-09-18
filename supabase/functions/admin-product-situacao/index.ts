/**
 * POST /admin-product-situacao  (painel /gestao/ — sessão Supabase Auth)
 *
 * Ativa/desativa produto no BLING — PATCH /produtos/{id}/situacoes
 * (developer.bling.com.br/referencia#/Produtos/patch_produtos__idProduto__situacoes).
 * Diferente de PUT /produtos/{id}, este PATCH só altera a situação —
 * nunca toca no array de variações, então é seguro para QUALQUER
 * produto (simples, com variação, ou uma variação individual).
 * Depois de confirmar no Bling, sincroniza o cache (syncProductById).
 */
import { requireAdminUser } from '../_shared/admin-user-auth.ts';
import { isValidBlingId } from '../_shared/product-admin-mapper.ts';
import { serve } from '../_shared/context.ts';
import { NotFoundError, ValidationError } from '../_shared/errors.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';
import { syncProductById } from '../_shared/sync-service.ts';

const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_SECONDS = 60;

serve(async (req, ctx) => {
  if (req.method !== 'POST') return methodNotAllowed(req, ['POST']);
  const admin = await requireAdminUser(req, ctx.db);

  const allowed = await ctx.db.rpc('rl_check_and_increment', {
    p_bucket: `admin-product-situacao:${admin.id}`,
    p_limit: RATE_LIMIT_MAX,
    p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
  });
  if (allowed.data === false) throw new ValidationError('Muitas tentativas. Aguarde um instante e tente novamente.');

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ValidationError('Body JSON inválido.');
  }
  const body = (raw ?? {}) as Record<string, unknown>;
  const blingId = typeof body.blingId === 'string' ? body.blingId.trim() : '';
  if (!isValidBlingId(blingId)) throw new ValidationError('blingId inválido.');
  if (typeof body.ativo !== 'boolean') throw new ValidationError('ativo (boolean) é obrigatório.');

  const product = await ctx.repo.findProductByBlingId(blingId);
  const variant = product ? null : await ctx.repo.findVariantByBlingId(blingId);
  if (!product && !variant) throw new NotFoundError('Produto ou variação não encontrado no catálogo sincronizado.');

  await ctx.client().changeProductSituation(blingId, body.ativo ? 'A' : 'I');

  ctx.logger.info('admin.product_situacao', `situação alterada para ${body.ativo ? 'ativo' : 'inativo'}`, {
    entityType: 'product',
    entityId: blingId,
    adminUserId: admin.id,
  });

  // Se for variação, sincroniza pelo pai (syncProductById já detecta e
  // busca o pai automaticamente) para manter o agrupamento consistente.
  const syncResult = await syncProductById(
    { client: ctx.client(), repo: ctx.repo, logger: ctx.logger, tokenStore: ctx.tokenStore },
    blingId,
    { syncStock: false },
  );

  return json(req, { ok: true, blingId, productId: syncResult.productId, message: 'Situação atualizada no Bling e sincronizada.' }, 200);
});
