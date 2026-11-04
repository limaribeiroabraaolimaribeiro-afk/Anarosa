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
    // Se o usuário excluiu antes no painel Bling, basta reconciliar o catálogo.
    // Nunca envie uma nova exclusão de um produto já com situação E.
    const alreadyDeletedInBling = String(remote.situacao ?? '').toUpperCase() === 'E';
    let deletionMethod: 'already_deleted' | 'individual' | 'batch_single_id' = 'already_deleted';
    if (!alreadyDeletedInBling) {
      await submitted();
      let singleError: BlingApiError | null = null;
      try {
        await ctx.client().deleteProduct(blingId);
        deletionMethod = 'individual';
      } catch (error) {
        if (error instanceof BlingApiError && error.status === 403 &&
            error.blingType === 'insufficient_scope') {
          throw new ValidationError(
            'O aplicativo ANAROSA não tem permissão para excluir produtos no Bling.',
            { reason: 'bling_delete_permission_missing', blingStatus: 403 },
          );
        }
        if (!(error instanceof BlingApiError && error.status === 400)) throw error;
        singleError = error;

        // Apenas 400 (rejeição definitiva). Se o Bling já marcou E,
        // reconciliar o cache sem mandar novo DELETE.
        let alreadyMarkedDeleted = false;
        try {
          const inspected = (await ctx.client().getProductById(blingId)).data as Record<string, unknown> | undefined;
          alreadyMarkedDeleted = String(inspected?.situacao ?? '').toUpperCase() === 'E';
        } catch {
          // Uma consulta inconclusiva não comprova sucesso ou exclusão.
        }
        if (!alreadyMarkedDeleted) {
          // Endpoint documentado DELETE /produtos?idsProdutos[]=ID.
          // Exatamente um ID confirmado pelo usuário, sem alterar outras linhas.
          try {
            await ctx.client().deleteProductViaBatch(blingId);
          } catch (batchError) {
            if (!(batchError instanceof BlingApiError && batchError.status === 400)) throw batchError;
            // Endpoint em lote pode retornar HTTP 200 com alerta por produto.
            const details = (batchError.blingFields?.length ? batchError.blingFields : singleError.blingFields ?? [])
              .slice(0, 3)
              .map(field => [field.code ? 'Código ' + field.code : '', field.element || '', field.msg]
                .filter(Boolean).join(' — ')).join('; ');
            throw new ValidationError(
              'O Bling recusou a exclusão individual e a exclusão em lote (HTTP 400). ' +
              (details ? 'Detalhes do Bling: ' + details.slice(0, 480) + '. ' :
                (batchError.blingDescription ? 'Detalhes do Bling: ' + batchError.blingDescription.slice(0, 180) + '. ' : '')) +
              'O produto foi mantido na ANAROSA e no Bling.',
              { reason: 'bling_delete_rejected', blingStatus: 400,
                blingType: batchError.blingType ?? singleError.blingType ?? null },
            );
          }
          deletionMethod = 'batch_single_id';
        } else {
          deletionMethod = 'individual';
        }
      }

      // O retorno 2xx do DELETE em lote pode conter "alertas" e não
      // implica exclusão efetiva. Exige consultar o ERP antes de ocultar.
      let confirmed = false;
      try {
        const verified = (await ctx.client().getProductById(blingId)).data as Record<string, unknown> | undefined;
        confirmed = String(verified?.id) === blingId &&
          String(verified?.situacao ?? '').toUpperCase() === 'E';
      } catch {
        // Não considerar um timeout, 404 ou erro como confirmação.
      }
      if (!confirmed) {
        throw new ValidationError(
          'O Bling recebeu a solicitação, mas ainda não confirmou a situação Excluído (E). ' +
          'O produto continua na ANAROSA. Atualize depois de conferir o Bling; não repita a operação sem verificar.',
          { reason: 'bling_delete_unverified' },
        );
      }
    }
    ctx.logger.info('admin.product_delete', 'Exclusão confirmada no Bling', {
      entityType: 'product', entityId: blingId, adminUserId: admin.id, deletionMethod,
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
        ok: true, blingId, deletedInBling: true, syncPending: true,
        message: 'Excluído no Bling, mas a retirada do catálogo ainda precisa de conferência. Não repita a exclusão.',
      };
    }
    return { ok: true, blingId, deletedInBling: true,
      message: alreadyDeletedInBling
        ? 'Produto já estava excluído no Bling e foi retirado da gestão ANAROSA.'
        : 'Produto excluído no Bling e retirado do catálogo ANAROSA.' };
  });
  return json(req, result, result.syncPending ? 202 : 200);
});
