/**
 * POST /admin-product-update  (painel /gestao/ — sessão Supabase Auth)
 *
 * Atualiza produto no BLING (fonte de verdade) — PUT /produtos/{id}
 * (developer.bling.com.br/referencia#/Produtos/put_produtos__idProduto_).
 * O Supabase NUNCA é escrito diretamente: depois do PUT, uma leitura
 * segura (syncProductById) reflete no cache o que o Bling confirmou.
 *
 * PUT /produtos/{id} SUBSTITUI o cadastro inteiro (não é um PATCH
 * parcial) — a documentação/SDK de referência mostra que o array
 * `variacoes` faz parte do corpo e a resposta relata variações
 * criadas/atualizadas/DELETADAS. Por isso, nesta primeira versão, só
 * produtos SEM variação podem ser editados por aqui — editar um
 * produto com variação por um PUT que omite `variacoes` arriscaria
 * apagar as variações existentes no Bling. Ver
 * docs/BLING_PRODUCT_MANAGEMENT.md.
 */
import { requireAdminUser } from '../_shared/admin-user-auth.ts';
import { buildBlingProductUpdatePayload, isValidBlingId, validateProductAdminInput } from '../_shared/product-admin-mapper.ts';
import { serve } from '../_shared/context.ts';
import { NotFoundError, ValidationError } from '../_shared/errors.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';
import { syncProductById } from '../_shared/sync-service.ts';

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_SECONDS = 60;

serve(async (req, ctx) => {
  if (req.method !== 'POST') return methodNotAllowed(req, ['POST']);
  const admin = await requireAdminUser(req, ctx.db);

  const allowed = await ctx.db.rpc('rl_check_and_increment', {
    p_bucket: `admin-product-update:${admin.id}`,
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

  const product = await ctx.repo.findProductByBlingId(blingId);
  if (!product) throw new NotFoundError('Produto não encontrado no catálogo sincronizado.');
  if (product.parent_bling_id != null) {
    throw new ValidationError('Este id pertence a uma variação — edite o produto principal, ou altere direto no Bling.');
  }
  const hasVariants = await ctx.repo.productHasVariants(product.id);
  if (hasVariants) {
    throw new ValidationError('Produtos com variação não podem ser editados por aqui nesta versão — altere direto no Bling.');
  }

  const input = validateProductAdminInput(raw);
  if (input.categoriaId) {
    const categoryId = await ctx.repo.findCategoryIdByBlingId(input.categoriaId);
    if (!categoryId) {
      throw new ValidationError('Categoria não encontrada no catálogo sincronizado.', { field: 'categoriaId' });
    }
  }

  // PUT substitui o cadastro inteiro — parte do registro ATUAL do
  // Bling para não apagar campos que este formulário não edita
  // (ver product-admin-mapper.ts:buildBlingProductUpdatePayload).
  const current = await ctx.client().getProductById(blingId);
  const payload = buildBlingProductUpdatePayload(input, (current?.data ?? {}) as Record<string, unknown>);
  await ctx.client().updateProduct(blingId, payload);

  ctx.logger.info('admin.product_update', 'produto atualizado no Bling', {
    entityType: 'product',
    entityId: blingId,
    adminUserId: admin.id,
  });

  const syncResult = await syncProductById(
    { client: ctx.client(), repo: ctx.repo, logger: ctx.logger, tokenStore: ctx.tokenStore },
    blingId,
    { syncStock: true },
  );

  return json(req, { ok: true, blingId, productId: syncResult.productId, message: 'Produto atualizado no Bling e sincronizado.' }, 200);
});
