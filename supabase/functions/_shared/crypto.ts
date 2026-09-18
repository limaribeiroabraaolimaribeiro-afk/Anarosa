/**
 * Primitivas criptográficas via Web Crypto (disponível no Deno e no Node ≥ 20).
 * Nenhuma dependência externa.
 */

const encoder = new TextEncoder();

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64Encode(text: string): string {
  const bytes = encoder.encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Gera um valor aleatório criptograficamente seguro (base64url). */
export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return bytesToHex(new Uint8Array(digest));
}

/** HMAC-SHA256 em hexadecimal (minúsculo). */
export async function hmacSha256Hex(secret: string, payload: string | Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const data = typeof payload === 'string' ? encoder.encode(payload) : payload;
  const sig = await crypto.subtle.sign('HMAC', key, data as BufferSource);
  return bytesToHex(new Uint8Array(sig));
}

/**
 * Comparação em tempo constante (independe do ponto de divergência).
 * Strings de tamanhos diferentes retornam false sem vazar o tamanho por
 * atalho: percorremos sempre o maior comprimento.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  const len = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

/** Cabeçalho Basic Auth para client_id:client_secret. */
export function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${base64Encode(`${clientId}:${clientSecret}`)}`;
}
