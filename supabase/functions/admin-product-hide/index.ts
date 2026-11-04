/**
 * Retira um produto SOMENTE da loja/gestão. Nunca escreve no Bling.
 * Útil quando DELETE /produtos/{id} é recusado pela API mas o lojista
 * deseja parar de exibir o cadastro, sem apagar histórico de pedidos.
 */
import { requireAdminUser } from '../_shared/admin-user-auth.ts';
import { serve } from '../_shared/context.ts';
import { NotFoundError, ValidationError } from '../_shared/errors.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';

serve(async (req, ctx) => {
  if (req.method !== 'POST') return methodNotAllowed(req, ['POST']);
  const admin = await requireAdminUser(req, ctx.db);
  const { data: allowed, error: rateError } = await ctx.db.rpc('rl_check_and_increment', {
    p_bucket: `admin-product-hide:${admin.id}`, p_limit: 8, p_window_seconds: 60,
  });
  if (rateError || allowed !== true) throw new ValidationError('Limite de operações atingido. Aguarde um minuto.');

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { throw new ValidationError('Solicitação inválida.'); }
  const id = body.blingId;
  if (typeof id !== 'string' || !/^[1-9][0-9]{0,15}$/.test(id) ||
      body.confirmation !== 'REMOVE_ONLY_FROM_ANAROSA' ||
      typeof body.confirmText !== 'string' || body.confirmText.length > 80) {
    throw new ValidationError('Confirme que deseja remover somente da loja ANAROSA.');
  }
  const { data: product, error } = await ctx.db.from('store_products')
    .select('id,bling_id,parent_bling_id,sku,hidden_from_gestao_at,deleted_from_bling_at')
    .eq('bling_id', id).maybeSingle();
  if (error) throw new Error('product_hide_lookup_failed');
  if (!product || product.parent_bling_id != null) throw new NotFoundError('Produto não encontrado.');
  if (body.confirmText.trim() !== String(product.sku || id).trim()) {
    throw new ValidationError('SKU/ID não corresponde ao produto selecionado.');
  }
  if (product.hidden_from_gestao_at || product.deleted_from_bling_at) {
    return json(req, { ok: true, removedFromStore: true, deletedInBling: Boolean(product.deleted_from_bling_at),
      message: 'Este produto já não aparece na gestão da ANAROSA.' });
  }
  const timestamp = new Date().toISOString();
  const [parent, children, variants] = await Promise.all([
    ctx.db.from('store_products').update({ active: false, hidden_from_gestao_at: timestamp, synced_at: timestamp })
      .eq('id', product.id).is('hidden_from_gestao_at', null),
    ctx.db.from('store_products').update({ active: false, hidden_from_gestao_at: timestamp, synced_at: timestamp })
      .eq('parent_bling_id', id),
    ctx.db.from('store_product_variants').update({ active: false, synced_at: timestamp })
      .eq('product_id', product.id),
  ]);
  if (parent.error || children.error || variants.error) throw new Error('product_hide_update_failed');
  ctx.logger.info('admin.product_hide', 'produto ocultado somente na ANAROSA', {
    entityType: 'product', entityId: id, adminUserId: admin.id,
  });
  return json(req, {
    ok: true, removedFromStore: true, deletedInBling: false,
    message: 'Produto removido da loja e da gestão ANAROSA. O cadastro permanece no Bling e os anúncios externos não foram alterados.',
  });
});
