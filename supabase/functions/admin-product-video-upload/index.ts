/** Upload de vídeos promocionais autenticado, separado das imagens sincronizadas com Bling. */
import { requireAdminUser } from '../_shared/admin-user-auth.ts';
import { serve } from '../_shared/context.ts';
import { ValidationError } from '../_shared/errors.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';
import { PRODUCT_VIDEO_BUCKET, PRODUCT_VIDEO_MAX_BYTES } from '../_shared/product-video.ts';

function identify(bytes: Uint8Array): { mime: string; extension: string } | null {
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
  if (bytes.length >= 12 && ascii(4, 4) === 'ftyp')
    return { mime: 'video/mp4', extension: 'mp4' };
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 &&
      bytes[2] === 0xdf && bytes[3] === 0xa3)
    return { mime: 'video/webm', extension: 'webm' };
  return null;
}

serve(async (req, ctx) => {
  if (req.method !== 'POST') return methodNotAllowed(req, ['POST']);
  const admin = await requireAdminUser(req, ctx.db);
  const { data: allowed, error: rateError } = await ctx.db.rpc('rl_check_and_increment', {
    p_bucket: `admin-video-upload:${admin.id}`, p_limit: 6, p_window_seconds: 60,
  });
  if (rateError || allowed !== true) throw new ValidationError('Limite de vídeos por minuto atingido.');
  const length = Number(req.headers.get('content-length') || 0);
  if (length > PRODUCT_VIDEO_MAX_BYTES + 10240) throw new ValidationError('O vídeo deve ter até 30 MB.');
  let data: FormData;
  try { data = await req.formData(); } catch { throw new ValidationError('Envie um vídeo MP4 ou WebM.'); }
  const file = data.get('video');
  if (!(file instanceof File) || file.size < 1 || file.size > PRODUCT_VIDEO_MAX_BYTES ||
      !['video/mp4', 'video/webm'].includes(file.type)) {
    throw new ValidationError('Selecione um vídeo MP4 ou WebM de até 30 MB.');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const detected = identify(bytes);
  if (!detected || detected.mime !== file.type) throw new ValidationError('O conteúdo do arquivo não corresponde ao formato do vídeo.');
  const path = `${admin.id}/${crypto.randomUUID()}.${detected.extension}`;
  const { error } = await ctx.db.storage.from(PRODUCT_VIDEO_BUCKET).upload(path, bytes, {
    contentType: detected.mime, cacheControl: '31536000', upsert: false,
  });
  if (error) throw new Error('admin_product_video_upload_failed');
  const { data: publicFile } = ctx.db.storage.from(PRODUCT_VIDEO_BUCKET).getPublicUrl(path);
  if (!publicFile?.publicUrl?.startsWith('https://')) throw new Error('admin_product_video_url_failed');
  return json(req, { ok: true, url: publicFile.publicUrl }, 201);
});
