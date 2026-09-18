/**
 * Utilitários de teste: fetch mockado (nenhuma chamada real ao Bling),
 * configs de teste e logger silencioso.
 */
import type { BlingConfig, InfinitePayConfig } from '../_shared/config.ts';
import { createLogger, type Logger } from '../_shared/logger.ts';
import type { FetchLike } from '../_shared/bling-auth.ts';

export const TEST_INFINITEPAY_CONFIG: InfinitePayConfig = {
  handle: 'maia_14',
  apiBaseUrl: 'https://api.checkout.infinitepay.test',
  requestTimeoutMs: 2000,
  webhookUrl: 'https://example.invalid/functions/v1/infinitepay-webhook',
  redirectUrl: 'https://example.invalid/pedido-confirmado.html',
};

export const TEST_BLING_CONFIG: BlingConfig = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret-not-real',
  redirectUri: 'https://example.invalid/functions/v1/bling-oauth-callback',
  apiBaseUrl: 'https://api.bling.test/Api/v3',
  authUrl: 'https://www.bling.test/Api/v3/oauth/authorize',
  tokenUrl: 'https://www.bling.test/Api/v3/oauth/token',
  requestTimeoutMs: 2000,
  refreshSkewSeconds: 120,
  oauthStateTtlSeconds: 600,
  productsPageSize: 100,
  orderSyncEnabled: false,
};

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export type RouteHandler = (call: RecordedCall, index: number) => Response | Promise<Response>;

/** Cria um fetch falso que grava chamadas e responde por rota (substring da URL). */
export function mockFetch(routes: Array<[match: string | RegExp, handler: RouteHandler]>) {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    const h = new Headers(init?.headers ?? {});
    h.forEach((v, k) => (headers[k.toLowerCase()] = v));
    const call: RecordedCall = {
      url: input,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers,
      body: typeof init?.body === 'string' ? init.body : null,
    };
    calls.push(call);
    for (const [match, handler] of routes) {
      const hit = typeof match === 'string' ? input.includes(match) : match.test(input);
      if (hit) return await handler(call, calls.length - 1);
    }
    return new Response(JSON.stringify({ error: { type: 'not_mocked' } }), { status: 599 });
  };
  return { fetchImpl, calls };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export function silentLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const fake = {
    log: (s: string) => lines.push(s),
    warn: (s: string) => lines.push(s),
    error: (s: string) => lines.push(s),
  };
  return { logger: createLogger({ console: fake }), lines };
}

export const noSleep = () => Promise.resolve();

export function tokenBody(overrides: Record<string, unknown> = {}) {
  return {
    access_token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0LWFjY2VzcyJ9.c2lnbmF0dXJlLXRlc3QtdmFsdWU',
    refresh_token: 'refresh-token-test-value-0001',
    token_type: 'Bearer',
    expires_in: 21600,
    scope: 'produtos estoques pedidos',
    ...overrides,
  };
}
