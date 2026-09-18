/**
 * CORS restrito à origem da loja (STOREFRONT_URL) + localhost em dev.
 */
import { getAppConfig } from './config.ts';

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

export function resolveAllowedOrigin(requestOrigin: string | null): string | null {
  const { storefrontUrl } = getAppConfig();
  if (!requestOrigin) return storefrontUrl;
  if (requestOrigin === storefrontUrl) return requestOrigin;
  // www ↔ apex da mesma loja
  try {
    const a = new URL(requestOrigin).hostname.replace(/^www\./, '');
    const b = new URL(storefrontUrl).hostname.replace(/^www\./, '');
    if (a === b) return requestOrigin;
  } catch {
    // origem inválida → nega
  }
  if (LOCAL_ORIGIN.test(requestOrigin)) return requestOrigin;
  return null;
}

export function corsHeaders(req: Request, extra: Record<string, string> = {}): Record<string, string> {
  const origin = resolveAllowedOrigin(req.headers.get('origin'));
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type, x-integration-admin-secret, x-idempotency-key',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
    ...extra,
  };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

/** Resposta para preflight; retorna null se não for OPTIONS. */
export function handlePreflight(req: Request): Response | null {
  if (req.method !== 'OPTIONS') return null;
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}
