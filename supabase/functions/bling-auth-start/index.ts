/**
 * POST /bling-auth-start  (admin)
 * Gera state seguro, grava o hash e devolve a URL oficial de autorização.
 * Nunca envia client_secret; nunca devolve dados confidenciais.
 */
import { requireAdmin } from '../_shared/admin-auth.ts';
import { buildAuthorizeUrl } from '../_shared/bling-auth.ts';
import { isBlingConfigured } from '../_shared/config.ts';
import { serve } from '../_shared/context.ts';
import { ConfigError } from '../_shared/errors.ts';
import { createOAuthState, SupabaseOAuthStateStore } from '../_shared/oauth-state.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';

serve(async (req, ctx) => {
  if (req.method !== 'POST') return methodNotAllowed(req, ['POST']);
  requireAdmin(req);

  if (!isBlingConfigured(ctx.blingConfig)) {
    throw new ConfigError('Bling não configurado: defina BLING_CLIENT_ID, BLING_CLIENT_SECRET e BLING_REDIRECT_URI.');
  }

  const store = new SupabaseOAuthStateStore(ctx.db);
  const { state, expiresAt } = await createOAuthState(store, ctx.blingConfig.oauthStateTtlSeconds);
  const authorizeUrl = buildAuthorizeUrl(ctx.blingConfig, state);

  ctx.logger.info('oauth.start', 'state gerado', { expiresAt: expiresAt.toISOString() });

  return json(req, {
    ok: true,
    authorizeUrl,
    expiresAt: expiresAt.toISOString(),
    redirectUri: ctx.blingConfig.redirectUri,
  });
});
