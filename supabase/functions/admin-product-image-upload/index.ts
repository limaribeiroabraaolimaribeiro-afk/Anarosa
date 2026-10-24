/** Upload autenticado: fotos públicas do catálogo, nunca documentos ou notas fiscais.
 * Segurança: JWT + store_admins.active, limite de bytes, assinatura de formato,
 * throttling por admin e bucket somente com leitura pública. */
import { requireAdminUser } from '../_shared/admin-user-auth.ts';
import { canWriteProductImages } from '../_shared/product-image-permission.ts';
import { serve } from '../_shared/context.ts';
import { ValidationError } from '../_shared/errors.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';

const BUCKET = 'anarosa-product-images';
const MAX_BYTES = 3 * 1024 * 1024;
const MAGIC = {
  jpeg: { mime: 'image/jpeg', extension: 'jpg' },
  png: { mime: 'image/png', extension: 'png' },
  webp: { mime: 'image/webp', extension: 'webp' },
} as const;
function detect(bytes: Uint8Array): keyof typeof MAGIC | null {
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((n, i) => bytes[i] === n)) return 'png';
  if (bytes.length >= 12 &&
      String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
      String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'webp';
  return null;
}

serve(async (req, ctx) => {
  if (req.method !== 'POST') return methodNotAllowed(req, ['POST']);
  const admin = await requireAdminUser(req, ctx.db);
  if (!await canWriteProductImages(ctx.tokenStore)) {
    throw new ValidationError('A conexão do Bling não possui a autorização atual de imagens.');
  }
  const rate = await ctx.db.rpc('rl_check_and_increment', {
    p_bucket: `admin-image-upload:${admin.id}`, p_limit: 20, p_window_seconds: 60,
  });
  if (rate.error || rate.data !== true) throw new ValidationError('Limite de envios temporariamente atingido.');
  const length = Number(req.headers.get('content-length') || 0);
  if (length > MAX_BYTES + 10240) throw new ValidationError('Imagem maior que 3 MB.');
  let form: FormData;
  try { form = await req.formData(); } catch { throw new ValidationError('Envie uma foto válida.'); }
  const file = form.get('photo');
  if (!(file instanceof File) || file.size < 1 || file.size > MAX_BYTES) {
    throw new ValidationError('Selecione JPG, PNG ou WebP de até 3 MB.');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = detect(bytes);
  if (!type) throw new ValidationError('Formato de imagem inválido.');
  const details = MAGIC[type];
  const objectPath = `${admin.id}/${crypto.randomUUID()}.${details.extension}`;
  const { error } = await ctx.db.storage.from(BUCKET).upload(objectPath, bytes, {
    contentType: details.mime, cacheControl: '31536000', upsert: false,
  });
  if (error) throw new Error('admin_product_image_upload_failed');
  const { data } = ctx.db.storage.from(BUCKET).getPublicUrl(objectPath);
  if (!data?.publicUrl?.startsWith('https://')) throw new Error('admin_product_image_url_failed');
  return json(req, { ok: true, url: data.publicUrl }, 201);
});