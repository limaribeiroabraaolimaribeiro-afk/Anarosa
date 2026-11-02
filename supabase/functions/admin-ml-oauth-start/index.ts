/** Inicia OAuth oficial do Mercado Livre, autorizado pela sessão admin. */
import { requireAdminUser } from '../_shared/admin-user-auth.ts';
import { serve } from '../_shared/context.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';
import { mlConfig,base64Url,sha256,challenge } from '../_shared/mercadolivre.ts';
serve(async(req,ctx)=>{
  if(req.method!=='POST')return methodNotAllowed(req,['POST']);
  const admin=await requireAdminUser(req,ctx.db);
  const cfg=mlConfig();
  const {data:allowed,error:rateErr}=await ctx.db.rpc('rl_check_and_increment',{
    p_bucket:'ml-oauth-start:'+admin.id,p_limit:5,p_window_seconds:600,
  });
  if(rateErr||allowed!==true)throw new Error('Limite de autorizações atingido.');
  const state=base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const verifier=base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const {error}=await ctx.db.from('ml_oauth_states').insert({
    state_hash:await sha256(state),verifier,admin_id:admin.id,
    expires_at:new Date(Date.now()+10*60*1000).toISOString(),
  });
  if(error)throw new Error('Não foi possível iniciar autorização Mercado Livre.');
  const url=new URL('https://auth.mercadolivre.com.br/authorization');
  url.searchParams.set('response_type','code');
  url.searchParams.set('client_id',cfg.clientId);
  url.searchParams.set('redirect_uri',cfg.redirectUri);
  url.searchParams.set('state',state);
  url.searchParams.set('code_challenge',await challenge(verifier));
  url.searchParams.set('code_challenge_method','S256');
  return json(req,{ok:true,authorizeUrl:url.toString()});
});
