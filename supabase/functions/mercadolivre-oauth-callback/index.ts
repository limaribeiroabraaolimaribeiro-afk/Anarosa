/** OAuth callback público Mercado Livre, protegido por state + PKCE de uso único. */
import { serve } from '../_shared/context.ts';
import { mlCredentials, mlReady, ML_CALLBACK_URI, ML_RETURN_URI, mlExchange, mlSeller, oauthHash } from '../_shared/mercadolivre-oauth.ts';
import { methodNotAllowed, redirect } from '../_shared/responses.ts';

function outcome(status:'connected'|'error', reason='') {
  const url = new URL(ML_RETURN_URI);
  url.searchParams.set('ml',status);
  if (reason) url.searchParams.set('reason',reason);
  return redirect(url.toString());
}

serve(async (req, ctx) => {
  if (req.method !== 'GET') return methodNotAllowed(req,['GET']);
  const url = new URL(req.url);
  if (url.searchParams.has('error')) return outcome('error','denied');
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(state) || !code || code.length>1024) return outcome('error','invalid_request');
  const hash = await oauthHash(state);
  // State só pode ser consumido uma vez, dentro da validade.
  const {data: pending,error:stateErr} = await ctx.db.from('ml_oauth_states')
    .update({used_at:new Date().toISOString()})
    .eq('state_hash',hash).is('used_at',null).gt('expires_at',new Date().toISOString())
    .select('code_verifier').maybeSingle();
  if (stateErr || !pending?.code_verifier) return outcome('error','invalid_state');
  const credentials = mlCredentials();
  if (!mlReady(credentials)) return outcome('error','not_configured');
  try {
    const tokens = await mlExchange(credentials,{
      grant_type:'authorization_code',code,redirect_uri:ML_CALLBACK_URI,
      code_verifier:pending.code_verifier,
    });
    const seller = await mlSeller(tokens.access_token);
    if (seller.id!==String(tokens.user_id)) return outcome('error','seller_mismatch');
    if (credentials.expectedSellerId && seller.id!==credentials.expectedSellerId) {
      return outcome('error','wrong_seller');
    }
    // Não substitui silenciosamente uma conta já vinculada por outra.
    const {data:existing,error:lookupError}=await ctx.db.from('ml_oauth_tokens')
      .select('seller_id').eq('connection_key','anarosa').maybeSingle();
    if(lookupError || (existing?.seller_id && existing.seller_id!==seller.id)) {
      return outcome('error','account_change_blocked');
    }
    const {error:saveError} = await ctx.db.from('ml_oauth_tokens').upsert({
      connection_key:'anarosa',seller_id:seller.id,seller_nickname:seller.nickname,
      access_token:tokens.access_token,refresh_token:tokens.refresh_token,scope:tokens.scope,
      expires_at:new Date(Date.now()+tokens.expires_in*1000).toISOString(),
      status:'connected',refresh_lock_until:null,connected_at:new Date().toISOString(),
      updated_at:new Date().toISOString(),
    },{onConflict:'connection_key'});
    if(saveError) throw new Error('mercadolivre_tokens_save_failed');
    // A conta conectada diretamente é independente da conta Mercado Livre no Bling.
    const {error:channelError}=await ctx.db.from('store_marketplace_connections').upsert({
      marketplace:'mercado_livre',status:'connected',
      external_store_id:seller.id,external_store_name:seller.nickname,
      permissions:tokens.scope.split(/\s+/).filter(Boolean),verified_at:new Date().toISOString(),
      updated_at:new Date().toISOString(),
    },{onConflict:'marketplace'});
    if(channelError) {
      // Token foi salvo; não produzir sucesso falso sobre o canal.
      throw new Error('mercadolivre_channel_status_failed');
    }
    return outcome('connected');
  } catch {
    return outcome('error','verification_failed');
  }
});
