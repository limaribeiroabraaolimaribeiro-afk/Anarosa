/**
 * Reautoriza o aplicativo privado Anarosa no Bling.
 * Autorização obrigatória pelo Supabase Auth + store_admins.active.
 * Um state aleatório e de uso único protege o callback OAuth existente.
 */
import { requireAdminUser } from '../_shared/admin-user-auth.ts';
import { buildAuthorizeUrl } from '../_shared/bling-auth.ts';
import { getBlingConfig, isBlingConfigured } from '../_shared/config.ts';
import { handlePreflight } from '../_shared/cors.ts';
import { ConfigError, ValidationError } from '../_shared/errors.ts';
import { createOAuthState, SupabaseOAuthStateStore } from '../_shared/oauth-state.ts';
import { json, errorResponse, methodNotAllowed } from '../_shared/responses.ts';
import { getServiceClient } from '../_shared/supabase.ts';

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  try {
    if (req.method !== 'POST') return methodNotAllowed(req, ['POST']);
    const db = getServiceClient();
    const admin = await requireAdminUser(req, db);
    const cfg = getBlingConfig();
    if (!isBlingConfigured(cfg)) {
      throw new ConfigError('Integração Bling não configurada.');
    }
    const { data: allowed, error } = await db.rpc('rl_check_and_increment', {
      p_bucket: `gestao-bling-reconnect:${admin.id}`,
      p_limit: 5,
      p_window_seconds: 600,
    });
    if (error || allowed !== true) {
      throw new ValidationError('Muitas tentativas de autorização. Tente novamente mais tarde.');
    }
    const { state, expiresAt } = await createOAuthState(
      new SupabaseOAuthStateStore(db), cfg.oauthStateTtlSeconds,
    );
    return json(req, {
      ok: true,
      authorizeUrl: buildAuthorizeUrl(cfg, state),
      expiresAt: expiresAt.toISOString(),
    });
  } catch (err) {
    return errorResponse(req, err);
  }
});
