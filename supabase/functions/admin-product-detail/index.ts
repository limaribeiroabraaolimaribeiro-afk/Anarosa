import { serve } from '../_shared/context.ts';
import { requireAdminUser } from '../_shared/admin-user-auth.ts';
import { productEditorView, productRevision } from '../_shared/product-editor.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';
import { ValidationError } from '../_shared/errors.ts';
serve(async (req, ctx) => {
  if (req.method !== 'GET') return methodNotAllowed(req, ['GET']);
  await requireAdminUser(req, ctx.db);
  const capabilities = {
    images: Deno.env.get('BLING_PRODUCT_IMAGES_ENABLED') === 'true',
    binaryUpload: false,
  };
  const id = new URL(req.url).searchParams.get('id') || '';
  if (!id) return json(req, { ok: true, product: {}, revision: null, capabilities });
  if (!/^[1-9]\d{0,15}$/.test(id)) throw new ValidationError('Produto inválido.');
  const { data } = await ctx.client().getProductById(id);
  return json(req, {
    ok: true,
    product: productEditorView(data),
    revision: await productRevision(data),
    capabilities,
  });
});
