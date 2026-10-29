import type { Handler } from './context.ts';
import { requireAdminUser } from './admin-user-auth.ts';
import { buildProductEditorPayload, productRevision, validateMerchandising } from './product-editor.ts';
import { canWriteProductImages } from './product-image-permission.ts';
import { json, methodNotAllowed } from './responses.ts';
import { ValidationError } from './errors.ts';
import { syncProductById } from './sync-service.ts';
import { runAdminMutation } from './admin-mutation.ts';

export function productSave(update: boolean): Handler {
  return async (req, ctx) => {
    if (req.method !== 'POST') return methodNotAllowed(req, ['POST']);
    const admin = await requireAdminUser(req, ctx.db);
    const body = await req.json();
    const rate = await ctx.db.rpc('rl_check_and_increment', {
      p_bucket: `product-save:${admin.id}`,
      p_limit: 20,
      p_window_seconds: 60,
    });
    if (rate.error || rate.data !== true) throw new ValidationError('Aguarde antes de salvar novamente.');
    if (update && !/^[1-9]\d{0,15}$/.test(body.blingId ?? '')) throw new ValidationError('Produto inválido.');
    // Validar a curadoria antes de qualquer escrita no Bling.
    const merchandising = validateMerchandising(body);
    const saved = await runAdminMutation(ctx, {
      key: body.operationKey,
      resource: update ? `product:${body.blingId}` : `sku:${String(body.sku).trim().toLowerCase()}`,
      actor: admin.id,
      payload: body,
    }, async (submitted) => {
      const current = update ? (await ctx.client().getProductById(body.blingId)).data : null;
      if (current && await productRevision(current) !== body.revision) {
        throw new ValidationError('O produto mudou no Bling. Reabra o editor antes de salvar.');
      }
      const payload = buildProductEditorPayload(
        body,
        current,
        await canWriteProductImages(ctx.tokenStore),
      );
      if (body.categoriaId && !await ctx.repo.findCategoryIdByBlingId(body.categoriaId)) {
        throw new ValidationError('Categoria não encontrada.');
      }
      const skus = [
        payload.codigo,
        ...(payload.variacoes ?? []).map((v: Record<string, unknown>) => v.codigo),
      ];
      const matches = (await ctx.client().findProductsBySku(skus)).data ?? [];
      const allowed = new Set([
        body.blingId,
        ...(current?.variacoes as Array<Record<string, unknown>> ?? []).map((v) => String(v.id)),
      ]);
      if (matches.some((v) => !allowed.has(String(v.id)))) {
        throw new ValidationError('SKU já cadastrado no Bling. Use um código único.');
      }
      await submitted();
      const result = update
        ? await ctx.client().patchProduct(body.blingId, payload)
        : await ctx.client().createProduct(payload);
      const id = update ? body.blingId : String(result.data?.id ?? '');
      if (!id) throw new Error('product_save_no_id');
      ctx.logger.info('admin.product_save', 'Produto salvo no Bling', {
        entityType: 'product',
        entityId: id,
        adminUserId: admin.id,
      });
      try {
        await syncProductById(
          { client: ctx.client(), repo: ctx.repo, logger: ctx.logger, tokenStore: ctx.tokenStore },
          id,
          { syncStock: true },
        );
        if (merchandising) await ctx.repo.saveMerchandisingByBlingId(id, merchandising);
      } catch {
        return {
          ok: true,
          blingId: id,
          syncPending: true,
          message: 'Salvo no Bling. A atualização da vitrine está pendente; não crie o produto novamente.',
        };
      }
      return { ok: true, blingId: id, message: 'Salvo no Bling e sincronizado.' };
    });
    return json(req, saved, saved.syncPending ? 202 : update ? 200 : 201);
  };
}
