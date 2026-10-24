/**
 * Admin-only Bling OAuth: start reauthorization after scope changes.
 * Generates single-use CSRF state on the server and redirects through
 * the official Bling authorization screen. No client secret in browser.
 */
import { requireAdminUser } from '../_shared/admin-user-auth.ts';
import { buildAuthorizeUrl } from '../_shared/bling-auth.ts';
import { isBlingConfigured } from '../_shared/config.ts';
import { serve } from '../_shared/context.ts';
import { ConfigError, ValidationError } from '../_shared/errors.ts';
import { createOAuthState, SupabaseOAuthStateStore } from '../_shared/oauth-state.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';

serve(async (req, ctx) => {
  if (req.method !== 'POST') return methodNotAllowed(req, ['POST']);
  const admin = await requireAdminUser(req, ctx.db);
  if (!isBlingConfigured(ctx.blingConfig)) {
    throw new ConfigError('As credenciais de integração com o Bling não estão configuradas.');
  }
  const { data: allowed, error } = await ctx.db.rpc('rl_check_and_increment', {
    p_bucket: `gestao-bling-reconnect:${admin.id}`,
    p_limit: 5,
    p_window_seconds: 600,
  });
  if (error || allowed !== true) {
    throw new ValidationError('Muitas tentativas de autorização. Tente novamente mais tarde.');
  }
  const store = new SupabaseOAuthStateStore(ctx.db);
  const { state, expiresAt } = await createOAuthState(store, ctx.blingConfig.oauthStateTtlSeconds);
  const authorizeUrl = buildAuthorizeUrl(ctx.blingConfig, state);
  ctx.logger.info('gestao.bling.reconnect', 'Autorização solicitada', { adminId: admin.id });
  return json(req, { ok: true, authorizeUrl, expiresAt: expiresAt.toISOString() });
});
