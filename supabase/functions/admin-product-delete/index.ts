/**
 * Exclui um produto do Bling após confirmação explícita do SKU/ID.
 * Mantém registros locais para integridade referencial e histórico.
 * Recusa qualquer produto vinculado a pedidos ou anúncios da loja.
 */
import { requireAdminUser } from '../_shared/admin-user-auth.ts';
import { runAdminMutation } from '../_shared/admin-mutation.ts';
import { serve } from '../_shared/context.ts';
import { ValidationError, NotFoundError, BlingApiError } from '../_shared/errors.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';

const validId = (id: unknown): id is string => typeof id === 'string' && /^[1-9][0-9]{0,15}$/.test(id);

serve(async (req, ctx) => {
  if (req.method !== 'POST') return methodNotAllowed(req, ['POST']);
  const admin = await requireAdminUser(req, ctx.db);
  const { data: allowed, error: rateError } = await ctx.db.rpc('rl_check_and_increment', {
    p_bucket: `admin-product-delete:${admin.id}`, p_limit: 5, p_window_seconds: 60,
  });
  if (rateError || allowed !== true) throw new ValidationError('Muitas tentativas de exclusão. Aguarde um minuto.');

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { throw new ValidationError('Solicitação inválida.'); }
  const blingId = body.blingId;
  if (!validId(blingId) || body.confirmar !== true ||
      typeof body.confirmText !== 'string' || body.confirmText.length > 80) {
    throw new ValidationError('Confirme o produto e digite o SKU ou ID solicitado.');
  }

  const { data: cached, error: cachedError } = await ctx.db.from('store_products')
    .select('id,bling_id,name,sku,parent_bling_id,deleted_from_bling_at')
    .eq('bling_id', blingId).maybeSingle();
  if (cachedError) throw new Error('product_delete_lookup_failed');
  if (!cached || cached.parent_bling_id != null || cached.deleted_from_bling_at) {
    throw new NotFoundError('Produto não disponível para exclusão.');
  }
  const expected = String(cached.sku || blingId).trim();
  if (body.confirmText.trim() !== expected) {
    throw new ValidationError('O código digitado não corresponde ao SKU/ID deste produto.');
  }

  const result = await runAdminMutation(ctx, {
    key: body.operationKey as string,
    resource: `product:${blingId}`,
    actor: admin.id,
    payload: { blingId, confirmText: body.confirmText, confirmar: true },
  }, async (submitted) => {
    // Reconsulta histórico de compras e anúncios dentro do lock.
    const [variantRows, childRows] = await Promise.all([
      ctx.db.from('store_product_variants').select('bling_id').eq('product_id', cached.id),
      ctx.db.from('store_products').select('id,bling_id').eq('parent_bling_id', blingId),
    ]);
    if (variantRows.error || childRows.error) throw new Error('product_delete_relations_failed');
    const productIds = [cached.id, ...(childRows.data ?? []).map((r: {id: string}) => r.id)];
    const ids = [...new Set([blingId, ...(variantRows.data ?? []).map((r: {bling_id: string}) => String(r.bling_id)),
      ...(childRows.data ?? []).map((r: {bling_id: string}) => String(r.bling_id))])];

    const [orders, listings] = await Promise.all([
      ctx.db.from('store_order_items').select('id').in('product_id', productIds).limit(1),
      ctx.db.from('store_marketplace_listings').select('id').in('bling_product_id', ids).limit(1),
    ]);
    if (orders.error || listings.error) throw new Error('product_delete_safety_check_failed');
    if ((orders.data ?? []).length) {
      throw new ValidationError('Este produto possui histórico de pedidos. Para preservar as vendas, use Desativar.');
    }
    if ((listings.data ?? []).length) {
      throw new ValidationError('Produto vinculado a anúncios. Desvincule e revise os anúncios no marketplace antes de excluir.');
    }

    // Confere o mesmo produto no Bling imediatamente antes de enviá-lo à lixeira.
    const remote = (await ctx.client().getProductById(blingId)).data as Record<string, unknown> | undefined;
    if (!remote || String(remote.id) !== blingId ||
        String(remote.codigo ?? '').trim() !== String(cached.sku ?? '').trim()) {
      throw new ValidationError('O produto foi alterado no Bling. Atualize o catálogo antes de excluir.');
    }
    await submitted();
    try {
      await ctx.client().deleteProduct(blingId);
    } catch (error) {
      // A API confirmou rejeição HTTP 403: nenhuma exclusão foi realizada.
      // O token foi emitido sem a permissão de exclusão do aplicativo Bling.
      if (error instanceof BlingApiError && error.status === 403 &&
          error.blingType === 'insufficient_scope') {
        throw new ValidationError(
          'O Bling recusou a exclusão: o aplicativo ANAROSA não tem permissão para excluir produtos. ' +
          'No Bling, habilite a permissão de exclusão de produtos no aplicativo da ANAROSA e depois ' +
          'entre em Gestão > Integração > Reconectar Bling. Nenhum produto foi excluído.',
          { reason: 'bling_delete_permission_missing' },
        );
      }
      throw error;
    }
    ctx.logger.info('admin.product_delete', 'Exclusão confirmada no Bling', {
      entityType: 'product', entityId: blingId, adminUserId: admin.id,
    });

    // Tombstone: remoção da vitrine e da listagem da Gestão sem apagar histórico.
    const timestamp = new Date().toISOString();
    const [parentUpdate, childUpdate, variantsUpdate] = await Promise.all([
      ctx.db.from('store_products').update({
        active: false, deleted_from_bling_at: timestamp, synced_at: timestamp,
      }).eq('id', cached.id),
      ctx.db.from('store_products').update({
        active: false, deleted_from_bling_at: timestamp, synced_at: timestamp,
      }).eq('parent_bling_id', blingId),
      ctx.db.from('store_product_variants').update({active:false,synced_at:timestamp}).eq('product_id', cached.id),
    ]);
    if (parentUpdate.error || childUpdate.error || variantsUpdate.error) {
      return {
        ok: true, blingId, syncPending: true,
        message: 'Excluído no Bling, mas a retirada do catálogo ainda precisa de conferência. Não repita a exclusão.',
      };
    }
    return { ok: true, blingId, message: 'Produto excluído no Bling e retirado do catálogo ANAROSA.' };
  });
  return json(req, result, result.syncPending ? 202 : 200);
});
