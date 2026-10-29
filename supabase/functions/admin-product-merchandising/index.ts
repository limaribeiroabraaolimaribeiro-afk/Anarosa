/**
 * POST /admin-product-merchandising
 * Atualiza apenas a curadoria local vinculada ao produto já cadastrado
 * no Bling. Nunca escreve preço-base, variações, estoque ou tags no ERP.
 */
import { serve } from '../_shared/context.ts';
import { requireAdminUser } from '../_shared/admin-user-auth.ts';
import { validateMerchandising } from '../_shared/product-editor.ts';
import { ValidationError } from '../_shared/errors.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';

serve(async (req, ctx) => {
  if (req.method !== 'POST') return methodNotAllowed(req, ['POST']);
  const admin = await requireAdminUser(req, ctx.db);
  const body = await req.json() as Record<string, unknown>;
  const id = typeof body.blingId === 'string' ? body.blingId.trim() : '';
  if (!/^[1-9]\d{0,15}$/.test(id)) throw new ValidationError('Produto inválido.');
  const { data: allowed, error: rateError } = await ctx.db.rpc('rl_check_and_increment', {
    p_bucket: `product-merchandising:${admin.id}`,
    p_limit: 30,
    p_window_seconds: 60,
  });
  if (rateError || allowed !== true) throw new ValidationError('Aguarde antes de salvar novamente.');

  // Conferimos o preço de venda REAL do Bling, nunca o enviado pelo browser.
  const { data: blingProduct } = await ctx.client().getProductById(id);
  if (!blingProduct || blingProduct.id == null || String(blingProduct.id) !== id) {
    throw new ValidationError('Produto não localizado no Bling.');
  }
  const merchandising = validateMerchandising({
    preco: blingProduct.preco,
    merchandising: body.merchandising,
  });
  if (!merchandising) throw new ValidationError('Informe os dados comerciais.');
  if (!await ctx.repo.findProductByBlingId(id)) {
    throw new ValidationError('Produto não sincronizado. Atualize o catálogo antes de editar destaques.');
  }
  await ctx.repo.saveMerchandisingByBlingId(id, merchandising);
  return json(req, { ok: true, merchandising, message: 'Tags e informações da loja atualizadas.' });
});
