/**
 * GET /storefront-image?blingId=...&slot=0
 * Resolve uma foto INTERNA do Bling para Supabase Storage permanente.
 * Público apenas para produtos ativos; nunca aceita URLs arbitrárias.
 * Primeira chamada: reconsulta link assinado válido do Bling e copia os bytes.
 * Chamadas seguintes: redireciona ao objeto público em cache sem usar a API Bling.
 */
import { serve } from '../_shared/context.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';
import { extractImages } from '../_shared/product-mapper.ts';
import { isBlingInternalImage, imageSourcePath } from '../_shared/catalog-image-url.ts';

const BUCKET = 'anarosa-product-images';
const MAX_BYTES = 5 * 1024 * 1024;
const signedHost = 'orgbling.s3.amazonaws.com';
type CacheItem = { sourcePath: string; publicUrl: string };
type Picture = { url: string; source?: string };

function pictureLocation(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === signedHost ? parsed : null;
  } catch { return null; }
}
function validImageType(bytes: Uint8Array): { mime: string; ext: string } | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return { mime: 'image/png', ext: 'png' };
  if (new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' &&
      new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}
function publicRedirect(req: Request, target: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      ...corsHeaders(req),
      Location: target,
      'Cache-Control': 'public, max-age=300',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

serve(async (req, ctx) => {
  if (req.method !== 'GET') return methodNotAllowed(req, ['GET']);
  const url = new URL(req.url);
  const blingId = url.searchParams.get('blingId') ?? '';
  const slot = Number(url.searchParams.get('slot') ?? '');
  if (!/^[1-9]\d{0,17}$/.test(blingId) || !Number.isInteger(slot) || slot < 0 || slot > 11) {
    return json(req, { ok: false, message: 'Foto não encontrada.' }, 404);
  }
  const { data: product, error: readError } = await ctx.db.from('store_products')
    .select('id, images, metadata, active, parent_bling_id')
    .eq('bling_id', blingId).eq('active', true).is('parent_bling_id', null).maybeSingle();
  if (readError) throw new Error('catalog_image_read_failed');
  if (!product) return json(req, { ok: false, message: 'Produto não encontrado.' }, 404);

  const photos = (Array.isArray(product.images) ? product.images : []) as Picture[];
  const original = photos[slot];
  if (!isBlingInternalImage(original)) return json(req, { ok: false, message: 'Foto não encontrada.' }, 404);
  const sourcePath = imageSourcePath(original.url);
  const existing = (product.metadata?.imageCache ?? {}) as Record<string, CacheItem>;
  const saved = existing[String(slot)];
  if (saved?.sourcePath === sourcePath && typeof saved.publicUrl === 'string') {
    const allowedPrefix = `${ctx.appConfig.supabaseUrl}/storage/v1/object/public/${BUCKET}/`;
    if (saved.publicUrl.startsWith(allowedPrefix)) return publicRedirect(req, saved.publicUrl);
  }

  // Limite de primeiros downloads por IP. Falha de rate-limit não libera acesso irrestrito.
  // Não use o cabeçalho X-Forwarded-For, que pode ser definido pelo cliente.
  const bucket = `storefront-image:${blingId}`;
  const { data: allowed, error: limitError } = await ctx.db.rpc('rl_check_and_increment', {
    p_bucket: bucket, p_limit: 20, p_window_seconds: 60,
  });
  if (limitError || allowed !== true) {
    return json(req, { ok: false, message: 'Tente novamente em instantes.' }, 429);
  }

  const response = await ctx.client().getProductById(blingId);
  const fresh = extractImages(response.data ?? {});
  const freshImage = fresh.find((p) =>
    isBlingInternalImage(p) && imageSourcePath(p.url) === sourcePath);
  if (!freshImage) return json(req, { ok: false, message: 'Foto não disponível no Bling.' }, 404);
  const remote = pictureLocation(freshImage.url);
  if (!remote) return json(req, { ok: false, message: 'Origem da foto inválida.' }, 404);

  const upstream = await fetch(remote.toString(), {
    redirect: 'error', signal: AbortSignal.timeout(12000),
    headers: { Accept: 'image/jpeg,image/png,image/webp' },
  });
  const claimedSize = Number(upstream.headers.get('content-length') ?? '0');
  if (!upstream.ok || (claimedSize > MAX_BYTES)) {
    return json(req, { ok: false, message: 'O Bling não disponibilizou a foto.' }, 502);
  }
  const reader = upstream.body?.getReader();
  if (!reader) return json(req, { ok: false, message: 'Foto indisponível.' }, 502);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_BYTES) { await reader.cancel(); return json(req, { ok: false, message: 'Foto muito grande.' }, 502); }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const type = validImageType(bytes);
  if (!type) return json(req, { ok: false, message: 'Formato da foto não suportado.' }, 502);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sourcePath ?? ''));
  const photoKey = [...new Uint8Array(digest)].slice(0, 12).map(x => x.toString(16).padStart(2, '0')).join('');
  const objectPath = `bling-permanent/${blingId}/${photoKey}.${type.ext}`;
  const storage = ctx.db.storage.from(BUCKET);
  const { error: uploadError } = await storage.upload(objectPath, bytes, {
    contentType: type.mime, cacheControl: '31536000', upsert: false,
  });
  if (uploadError && !/already exists|duplicate|exist/i.test(uploadError.message || '')) {
    throw new Error('catalog_image_upload_failed');
  }
  const { data: publicData } = storage.getPublicUrl(objectPath);
  const publicUrl = publicData?.publicUrl;
  if (!publicUrl || !publicUrl.startsWith(`${ctx.appConfig.supabaseUrl}/storage/v1/object/public/${BUCKET}/`)) {
    throw new Error('catalog_image_public_url_failed');
  }
  const newMetadata = {
    ...(product.metadata ?? {}),
    imageCache: {
      ...existing, [String(slot)]: { sourcePath, publicUrl },
    },
  };
  const { error: saveError } = await ctx.db.from('store_products')
    .update({ metadata: newMetadata }).eq('id', product.id);
  if (saveError) ctx.logger.warn('catalog.image', 'mídia salva mas cache pendente', { entityId: blingId });
  return publicRedirect(req, publicUrl);
});
