/**
 * URLs de imagens do Bling Storage são assinadas e expiram: nunca devemos
 * servir essas URLs diretamente como fonte permanente da vitrine.
 * O endpoint público storefront-image valida o produto antes de converter
 * a mídia original para um arquivo público estável no Storage da ANAROSA.
 */
type Picture = { url?: string; source?: string };
type CacheEntry = { sourcePath?: string; publicUrl?: string };
const S3_HOST = 'orgbling.s3.amazonaws.com';

export function isBlingInternalImage(image: Picture | null | undefined): boolean {
  if (!image?.url || image.source !== 'internal') return false;
  try {
    const u = new URL(image.url);
    return u.protocol === 'https:' && u.hostname === S3_HOST;
  } catch {
    return false;
  }
}

export function imageSourcePath(url: string): string | null {
  try { return new URL(url).pathname; } catch { return null; }
}

export function displayCatalogImage(
  image: Picture | null | undefined,
  blingId: string,
  slot: number,
  metadata: Record<string, unknown> | null | undefined,
  serviceBase?: string,
): string | null {
  if (!image?.url) return null;
  if (!isBlingInternalImage(image)) return image.url;
  const cached = ((metadata?.imageCache ?? {}) as Record<string, CacheEntry>)[String(slot)];
  if (cached?.sourcePath === imageSourcePath(image.url) &&
      typeof cached?.publicUrl === 'string' &&
      cached.publicUrl.startsWith('https://')) return cached.publicUrl;
  let base = serviceBase;
  if (base === undefined) {
    try { base = Deno.env.get('SUPABASE_URL') ?? ''; } catch { base = ''; }
  }
  if (!base || !/^https:\/\//.test(base)) return image.url;
  return `${base.replace(/\/$/, '')}/functions/v1/storefront-image?blingId=${encodeURIComponent(blingId)}&slot=${slot}`;
}
