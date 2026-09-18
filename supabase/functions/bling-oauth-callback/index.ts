/**
 * GET /bling-oauth-callback?code=...&state=...
 *
 * 1. valida state (existe, não expirou, não usado) e o marca como usado;
 * 2. troca o authorization_code por tokens NO SERVIDOR (Basic Auth +
 *    x-www-form-urlencoded + enable-jwt: 1);
 * 3. persiste tokens com segurança e calcula expires_at;
 * 4. redireciona para a página de status. Tokens nunca voltam ao navegador.
 */
import { exchangeAuthorizationCode } from '../_shared/bling-auth.ts';
import { isBlingConfigured } from '../_shared/config.ts';
import { serve } from '../_shared/context.ts';
import { describeError } from '../_shared/errors.ts';
import { SupabaseOAuthStateStore, validateOAuthState } from '../_shared/oauth-state.ts';
import { methodNotAllowed, redirect } from '../_shared/responses.ts';

function resultRedirect(base: string, params: Record<string, string>): Response {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return redirect(url.toString());
}

serve(async (req, ctx) => {
  if (req.method !== 'GET') return methodNotAllowed(req, ['GET']);

  const successUrl = ctx.appConfig.oauthSuccessRedirectUrl;
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const providerError = url.searchParams.get('error');

  if (providerError) {
    ctx.logger.warn('oauth.callback', 'Bling retornou erro de autorização', { providerError });
    return resultRedirect(successUrl, { bling: 'error', reason: 'provider_denied' });
  }

  if (!isBlingConfigured(ctx.blingConfig)) {
    return resultRedirect(successUrl, { bling: 'error', reason: 'not_configured' });
  }

  const stateStore = new SupabaseOAuthStateStore(ctx.db);
  const validState = await validateOAuthState(stateStore, state);
  if (!validState) {
    ctx.logger.warn('oauth.callback', 'state inválido, expirado ou reutilizado');
    return resultRedirect(successUrl, { bling: 'error', reason: 'invalid_state' });
  }

  if (!code) {
    return resultRedirect(successUrl, { bling: 'error', reason: 'missing_code' });
  }

  try {
    const tokens = await exchangeAuthorizationCode(ctx.blingConfig, code);
    await ctx.tokenStore.saveConnection(tokens, {
      metadata: { connectedVia: 'bling-oauth-callback', tokenFormat: tokens.accessToken.startsWith('eyJ') ? 'jwt' : 'opaque' },
    });
    ctx.logger.info('oauth.callback', 'conexão Bling autorizada', {
      expiresAt: tokens.expiresAt.toISOString(),
      scope: tokens.scope,
    });
    return resultRedirect(successUrl, { bling: 'connected' });
  } catch (err) {
    const d = describeError(err);
    ctx.logger.error('oauth.callback', 'falha na troca do authorization_code', {
      errorCode: d.code,
      httpStatus: d.details?.blingStatus ?? null,
    });
    return resultRedirect(successUrl, { bling: 'error', reason: d.code });
  }
});
