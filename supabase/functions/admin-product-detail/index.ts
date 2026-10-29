import { serve } from '../_shared/context.ts';
import { canWriteProductImages } from '../_shared/product-image-permission.ts';
import { requireAdminUser } from '../_shared/admin-user-auth.ts';
import { productEditorView, productRevision } from '../_shared/product-editor.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';
import { ValidationError } from '../_shared/errors.ts';
serve(async (req, ctx) => {
  if (req.method !== 'GET') return methodNotAllowed(req, ['GET']);
  await requireAdminUser(req, ctx.db);
  const imagesEnabled = await canWriteProductImages(ctx.tokenStore);
  const capabilities = {
    images: imagesEnabled,
    binaryUpload: imagesEnabled,
  };
  const id = new URL(req.url).searchParams.get('id') || '';
  if (!id) return json(req, { ok: true, product: {}, revision: null, capabilities });
  if (!/^[1-9]\d{0,15}$/.test(id)) throw new ValidationError('Produto inválido.');
  const { data } = await ctx.client().getProductById(id);
  const merchandising = await ctx.repo.getMerchandisingByBlingId(id);
  return json(req, {
    ok: true,
    product: { ...productEditorView(data), merchandising: merchandising ?? {
      tags: [], colecao: '', segmento: '', precoPromocional: null,
    } },
    revision: await productRevision(data),
    capabilities,
  });
});
