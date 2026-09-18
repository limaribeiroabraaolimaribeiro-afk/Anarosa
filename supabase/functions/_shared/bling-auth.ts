/**
 * OAuth 2.0 Authorization Code com o Bling (API v3).
 *
 * - authorize: response_type=code, client_id, state (sem client_secret)
 * - token: POST BLING_TOKEN_URL, Basic Auth client_id:client_secret,
 *   Content-Type application/x-www-form-urlencoded, header enable-jwt: 1
 * - refresh: grant_type=refresh_token, mesmos headers
 *
 * Funções puras com `fetch` injetável (testes não tocam a rede).
 */
import { BLING_DEFAULTS, type BlingConfig } from './config.ts';
import { basicAuthHeader } from './crypto.ts';
import { BlingTimeoutError, ConfigError, TokenRefreshError, BlingApiError } from './errors.ts';

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  expiresIn: number;
  expiresAt: Date;
  scope: string | null;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function assertBlingCredentials(cfg: BlingConfig): void {
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new ConfigError('BLING_CLIENT_ID / BLING_CLIENT_SECRET não configurados.');
  }
}

/** Monta a URL de autorização oficial. Nunca inclui client_secret. */
export function buildAuthorizeUrl(cfg: BlingConfig, state: string): string {
  if (!cfg.clientId) throw new ConfigError('BLING_CLIENT_ID não configurado.');
  const url = new URL(cfg.authUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('state', state);
  return url.toString();
}

export function computeExpiresAt(expiresInSeconds: number, now: Date = new Date()): Date {
  const secs = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds : 0;
  return new Date(now.getTime() + secs * 1000);
}

/** Converte a resposta JSON do endpoint de token em TokenSet. */
export function parseTokenResponse(body: unknown, now: Date = new Date()): TokenSet {
  const b = (body ?? {}) as Record<string, unknown>;
  const accessToken = typeof b.access_token === 'string' ? b.access_token : '';
  if (!accessToken) {
    throw new TokenRefreshError('Resposta de token sem access_token.', {
      keys: Object.keys(b),
    });
  }
  const expiresIn = Number(b.expires_in);
  return {
    accessToken,
    refreshToken: typeof b.refresh_token === 'string' ? b.refresh_token : null,
    tokenType: typeof b.token_type === 'string' ? b.token_type : 'Bearer',
    expiresIn: Number.isFinite(expiresIn) ? expiresIn : 0,
    expiresAt: computeExpiresAt(expiresIn, now),
    scope: typeof b.scope === 'string' ? b.scope : null,
  };
}

async function postTokenRequest(
  cfg: BlingConfig,
  form: URLSearchParams,
  fetchImpl: FetchLike,
  operation: string,
): Promise<TokenSet> {
  assertBlingCredentials(cfg);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);

  let res: Response;
  try {
    res = await fetchImpl(cfg.tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: basicAuthHeader(cfg.clientId, cfg.clientSecret),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        [BLING_DEFAULTS.jwtHeaderName]: BLING_DEFAULTS.jwtHeaderValue,
      },
      body: form.toString(),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw new BlingTimeoutError(operation);
    throw new TokenRefreshError(`Falha de rede em ${operation}.`, { operation });
  } finally {
    clearTimeout(timer);
  }

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (!res.ok) {
    const p = (payload ?? {}) as Record<string, unknown>;
    const errObj = (p.error ?? {}) as Record<string, unknown>;
    throw new BlingApiError(res.status, `Bling recusou ${operation}.`, {
      operation,
      blingType: typeof errObj.type === 'string' ? errObj.type : (typeof p.error === 'string' ? p.error : undefined),
      blingMessage: typeof errObj.message === 'string'
        ? errObj.message
        : (typeof p.error_description === 'string' ? p.error_description : undefined),
    });
  }

  return parseTokenResponse(payload);
}

/** Troca authorization_code por tokens (no servidor). */
export function exchangeAuthorizationCode(
  cfg: BlingConfig,
  code: string,
  fetchImpl: FetchLike = fetch,
): Promise<TokenSet> {
  if (!code) throw new TokenRefreshError('authorization_code ausente.');
  const form = new URLSearchParams();
  form.set('grant_type', 'authorization_code');
  form.set('code', code);
  // Observação: o Bling usa o "link de redirecionamento" cadastrado no app;
  // redirect_uri não é exigido no corpo. Mantido fora para seguir a doc.
  return postTokenRequest(cfg, form, fetchImpl, 'oauth.exchange_code');
}

/** Renova tokens com grant_type=refresh_token (header enable-jwt: 1). */
export function refreshAccessToken(
  cfg: BlingConfig,
  refreshToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<TokenSet> {
  if (!refreshToken) throw new TokenRefreshError('refresh_token ausente.');
  const form = new URLSearchParams();
  form.set('grant_type', 'refresh_token');
  form.set('refresh_token', refreshToken);
  return postTokenRequest(cfg, form, fetchImpl, 'oauth.refresh');
}
