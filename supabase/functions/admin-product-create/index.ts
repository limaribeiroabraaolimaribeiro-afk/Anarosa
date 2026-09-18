/**
 * POST /admin-product-create  (painel /gestao/ — sessão Supabase Auth)
 *
 * Cria produto no BLING (fonte de verdade) — POST /produtos
 * (developer.bling.com.br/referencia#/Produtos/post_produtos). O
 * Supabase NUNCA é escrito diretamente aqui: depois de criar no Bling,
 * fazemos uma leitura segura (syncProductById, a mesma usada pelos
 * webhooks) para refletir no cache o que o Bling confirmou.
 *
 * Nesta primeira versão: só produto SIMPLES (sem variação) — ver
 * docs/BLING_PRODUCT_MANAGEMENT.md.
 */
import { requireAdminUser } from '../_shared/admin-user-auth.ts';
import { buildBlingProductPayload, validateProductAdminInput } from '../_shared/product-admin-mapper.ts';
import { serve } from '../_shared/context.ts';
import { ValidationError } from '../_shared/errors.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';
import { syncProductById } from '../_shared/sync-service.ts';
import { toId } from '../_shared/product-mapper.ts';

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_SECONDS = 60;

serve(async (req, ctx) => {
  if (req.method !== 'POST') return methodNotAllowed(req, ['POST']);
  const admin = await requireAdminUser(req, ctx.db);

  const allowed = await ctx.db.rpc('rl_check_and_increment', {
    p_bucket: `admin-product-create:${admin.id}`,
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
  const input = validateProductAdminInput(raw);

  if (input.categoriaId) {
    const categoryId = await ctx.repo.findCategoryIdByBlingId(input.categoriaId);
    if (!categoryId) {
      throw new ValidationError('Categoria não encontrada no catálogo sincronizado.', { field: 'categoriaId' });
    }
  }

  const payload = buildBlingProductPayload(input);
  const result = await ctx.client().createProduct(payload);
  const blingId = toId(result?.data?.id);
  if (!blingId) {
    throw new Error('bling_create_product_no_id: Bling não retornou o id do produto criado.');
  }

  ctx.logger.info('admin.product_create', 'produto criado no Bling', {
    entityType: 'product',
    entityId: blingId,
    adminUserId: admin.id,
  });

  // Leitura segura pós-escrita — reflete no cache exatamente o que o
  // Bling confirmou (mesmo caminho que product.created/updated usa).
  const syncResult = await syncProductById(
    { client: ctx.client(), repo: ctx.repo, logger: ctx.logger, tokenStore: ctx.tokenStore },
    blingId,
    { syncStock: true },
  );

  return json(req, { ok: true, blingId, productId: syncResult.productId, message: 'Produto criado no Bling e sincronizado.' }, 201);
});
