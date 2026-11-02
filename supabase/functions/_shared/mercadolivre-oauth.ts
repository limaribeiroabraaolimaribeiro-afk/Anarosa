/** Cliente OAuth Mercado Livre (Brasil) – somente no backend. */
import { randomToken, sha256Hex, bytesToBase64Url } from './crypto.ts';

export const ML_CALLBACK_URI =
  'https://gpmbkptimjipqsayrvce.supabase.co/functions/v1/mercadolivre-oauth-callback';
export const ML_RETURN_URI = 'https://www.lojaanarosa.com.br/gestao/#/integracao';
const TOKEN_URL = 'https://api.mercadolibre.com/oauth/token';
const API_URL = 'https://api.mercadolibre.com';
const AUTH_URL = 'https://auth.mercadolivre.com.br/authorization';

export type MlCredentials = { clientId: string; clientSecret: string; expectedSellerId: string };
export type MlTokens = {
  access_token: string; refresh_token: string; expires_in: number;
  scope: string; user_id: string | number;
};

export function mlCredentials(): MlCredentials {
  return {
    clientId: Deno.env.get('ML_CLIENT_ID')?.trim() || '',
    clientSecret: Deno.env.get('ML_CLIENT_SECRET')?.trim() || '',
    expectedSellerId: Deno.env.get('ML_EXPECTED_SELLER_ID')?.trim() || '',
  };
}
export function mlReady(c: MlCredentials): boolean {
  return /^\d{6,30}$/.test(c.clientId) && c.clientSecret.length > 0;
}
export async function makeMlChallenge() {
  const verifier = randomToken(64);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge: bytesToBase64Url(digest) };
}
export function authorizeMl(clientId: string, state: string, challenge: string) {
  if (!/^\d{6,30}$/.test(clientId) || !/^[A-Za-z0-9_-]{40,128}$/.test(state)) {
    throw new Error('invalid_oauth_parameters');
  }
  const url = new URL(AUTH_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', ML_CALLBACK_URI);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}
export async function mlExchange(c: MlCredentials, data: Record<string,string>, fetchImpl=fetch): Promise<MlTokens> {
  const body = new URLSearchParams({ ...data, client_id: c.clientId, client_secret: c.clientSecret });
  let response: Response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method:'POST',
      headers:{'content-type':'application/x-www-form-urlencoded','accept':'application/json'},
      body,
      signal: AbortSignal.timeout(15000),
    });
  } catch { throw new Error('ml_token_network_error'); }
  if (!response.ok) throw new Error('ml_oauth_exchange_failed_' + response.status);
  const token = await response.json().catch(() => null) as Partial<MlTokens> | null;
  if (!token || typeof token.access_token !== 'string' || typeof token.refresh_token !== 'string' ||
      !Number.isFinite(Number(token.expires_in)) || Number(token.expires_in) <= 0 ||
      !/^[0-9]+$/.test(String(token.user_id ?? ''))) {
    throw new Error('ml_invalid_token_response');
  }
  return { access_token: token.access_token, refresh_token:token.refresh_token,
    expires_in:Number(token.expires_in), scope:String(token.scope||''), user_id:String(token.user_id) };
}
export async function mlSeller(accessToken: string, fetchImpl=fetch): Promise<{id: string; nickname: string}> {
  let r: Response;
  try {
    r = await fetchImpl(API_URL+'/users/me',{
      headers:{'Authorization':'Bearer '+accessToken,'Accept':'application/json'},
      signal: AbortSignal.timeout(15000),
    });
  } catch { throw new Error('ml_user_network_error'); }
  if (!r.ok) throw new Error('ml_user_verification_failed_'+r.status);
  const user = await r.json().catch(()=>null) as {id?:unknown;nickname?:unknown}|null;
  if (!user || !/^[0-9]+$/.test(String(user.id??''))) throw new Error('ml_user_response_invalid');
  return {id:String(user.id),nickname:String(user.nickname||'').slice(0,100)};
}
export function oauthHash(state: string): Promise<string> {
  return sha256Hex(state);
}
