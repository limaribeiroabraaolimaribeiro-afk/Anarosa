/** Gestão: status da conta Mercado Livre e início OAuth. Sem expor tokens. */
import { serve } from '../_shared/context.ts';
import { requireAdminUser } from '../_shared/admin-user-auth.ts';
import { randomToken } from '../_shared/crypto.ts';
import { authorizeMl, makeMlChallenge, mlCredentials, mlReady, oauthHash } from '../_shared/mercadolivre-oauth.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';

serve(async (req, ctx) => {
  const admin = await requireAdminUser(req, ctx.db);
  const c = mlCredentials();
  if (req.method === 'GET') {
    const { data, error } = await ctx.db.from('ml_oauth_tokens')
      .select('seller_id,seller_nickname,scope,status,expires_at,connected_at,updated_at')
      .eq('connection_key','anarosa').maybeSingle();
    if (error) throw new Error('mercadolivre_status_read_failed');
    return json(req, {
      ok:true, configured:mlReady(c), connected:!!data && data.status==='connected',
      connection: data ? {
        sellerId:data.seller_id,
        sellerNickname:data.seller_nickname,
        status:data.status,
        authorizedAt:data.connected_at,
        tokenExpiresAt:data.expires_at,
        tokenExpired:new Date(data.expires_at).getTime() <= Date.now(),
      } : null,
      mode:'read_only',
    });
  }
  if (req.method !== 'POST') return methodNotAllowed(req,['GET','POST']);
  if (!mlReady(c)) return json(req,{
    ok:false,configured:false,
    message:'Configure ML_CLIENT_ID e ML_CLIENT_SECRET no Supabase antes de conectar.'
  },409);
  const { data: allowed, error: rlErr } = await ctx.db.rpc('rl_check_and_increment', {
    p_bucket:'ml-oauth:'+admin.id, p_limit:5, p_window_seconds:600,
  });
  if (rlErr || allowed!==true) return json(req,{ok:false,message:'Muitas tentativas; tente novamente mais tarde.'},429);
  const state = randomToken(32);
  const {verifier,challenge} = await makeMlChallenge();
  const {error} = await ctx.db.from('ml_oauth_states').insert({
    state_hash:await oauthHash(state),
    code_verifier:verifier,admin_id:admin.id,
    expires_at:new Date(Date.now()+10*60*1000).toISOString(),
  });
  if (error) throw new Error('mercadolivre_state_write_failed');
  return json(req,{ok:true,authorizeUrl:authorizeMl(c.clientId,state,challenge)},200);
});
