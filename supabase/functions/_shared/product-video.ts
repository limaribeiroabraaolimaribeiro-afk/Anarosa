/** Vídeos editoriais da loja: links somente do bucket aprovado neste projeto. */
export const PRODUCT_VIDEO_BUCKET = 'anarosa-product-videos';
export const PRODUCT_VIDEO_MAX_BYTES = 30 * 1024 * 1024;
export function isPublishedProductVideoUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 1024) return false;
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  if (!supabaseUrl) return false;
  try {
    const url = new URL(value);
    const prefix = new URL('/storage/v1/object/public/' + PRODUCT_VIDEO_BUCKET + '/', supabaseUrl);
    if (url.protocol !== 'https:' || url.origin !== prefix.origin || url.search || url.hash ||
        !url.pathname.startsWith(prefix.pathname)) return false;
    const name = url.pathname.slice(prefix.pathname.length);
    return /^[a-f0-9-]{36}\\/[a-f0-9-]{36}\\.(mp4|webm)$/.test(name);
  } catch { return false; }
}
