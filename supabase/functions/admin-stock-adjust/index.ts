/**
 * POST /admin-stock-adjust  (painel /gestao/ — sessão Supabase Auth)
 *
 * Lança um ajuste de estoque no BLING — POST /estoques
 * (developer.bling.com.br/referencia#/Estoques/post_estoques). O
 * Supabase NUNCA recebe o novo saldo diretamente: depois do POST,
 * consultamos o saldo ATUAL no Bling (syncStockForProducts, mesmo
 * caminho usado pelo webhook de estoque) e atualizamos o cache com o
 * que o Bling confirmou.
 *
 * "operacao" (documentado oficialmente em estoques.operacao):
 *   entrada  (E) — SOMA quantidade ao saldo atual
 *   saida    (S) — SUBTRAI quantidade do saldo atual
 *   balanco  (B) — quantidade PASSA A SER o saldo atual (absoluto)
 * A UI precisa deixar isso explícito — nunca tratamos "quantidade"
 * como um delta genérico.
 */
import { requireAdminUser } from '../_shared/admin-user-auth.ts';
import { validateStockAdjustmentInput } from '../_shared/product-admin-mapper.ts';
import { serve } from '../_shared/context.ts';
import { NotFoundError, ValidationError } from '../_shared/errors.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';
import { syncStockForProducts } from '../_shared/sync-service.ts';

const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_SECONDS = 60;

serve(async (req, ctx) => {
  if (req.method !== 'POST') return methodNotAllowed(req, ['POST']);
  const admin = await requireAdminUser(req, ctx.db);

  const allowed = await ctx.db.rpc('rl_check_and_increment', {
    p_bucket: `admin-stock-adjust:${admin.id}`,
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
  const input = validateStockAdjustmentInput(raw);

  const product = await ctx.repo.findProductByBlingId(input.blingProductId);
  const variant = product ? null : await ctx.repo.findVariantByBlingId(input.blingProductId);
  if (!product && !variant) throw new NotFoundError('Produto ou variação não encontrado no catálogo sincronizado.');

  const result = await ctx.client().createStockEntry({
    produto: { id: Number(input.blingProductId) },
    deposito: { id: Number(input.depositoId) },
    operacao: input.operacao,
    quantidade: input.quantidade,
    ...(input.observacoes ? { observacoes: input.observacoes } : {}),
  });

  ctx.logger.info('admin.stock_adjust', `lançamento de estoque (${input.operacao})`, {
    entityType: 'product',
    entityId: input.blingProductId,
    adminUserId: admin.id,
    depositoId: input.depositoId,
    quantidade: input.quantidade,
    blingStockEntryId: result?.data?.id ?? null,
  });

  const updatedRows = await syncStockForProducts(
    { client: ctx.client(), repo: ctx.repo, logger: ctx.logger, tokenStore: ctx.tokenStore },
    [input.blingProductId],
  );

  return json(req, { ok: true, updatedRows, message: 'Estoque ajustado no Bling e saldo sincronizado.' }, 200);
});
