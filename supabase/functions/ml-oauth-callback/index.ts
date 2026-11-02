/** Callback OAuth Mercado Livre; sem JWT pois recebe redirect externo, protegido por state único. */
import { serve } from '../_shared/context.ts';
import { mlConfig,mlTokenExchange,saveMlTokens,sha256 } from '../_shared/mercadolivre.ts';
import { mlApi } from '../_shared/mercadolivre.ts';
import { methodNotAllowed } from '../_shared/responses.ts';
const home='https://www.lojaanarosa.com.br/gestao/';
function back(success:boolean){const url=new URL(home);
  url.searchParams.set('mercadolivre',success?'connected':'error');
  url.hash='/integracao';
  return new Response(null,{status:302,headers:{Location:url.toString(),'Cache-Control':'no-store'}});
}
serve(async(req,ctx)=>{
 if(req.method!=='GET')return methodNotAllowed(req,['GET']);
 const url=new URL(req.url),code=url.searchParams.get('code'),state=url.searchParams.get('state');
 if(url.searchParams.has('error')||!state||!/^[A-Za-z0-9_-]{30,128}$/.test(state)||!code) return back(false);
 const {data,error}=await ctx.db.from('ml_oauth_states')
  .update({used_at:new Date().toISOString()}).eq('state_hash',await sha256(state))
  .is('used_at',null).gt('expires_at',new Date().toISOString())
  .select('verifier').maybeSingle();
 if(error||!data)return back(false);
 try{
   const cfg=mlConfig();
   const tokens=await mlTokenExchange({grant_type:'authorization_code',
     code,redirect_uri:cfg.redirectUri,code_verifier:String(data.verifier)});
   const seller=await mlApi(String(tokens.access_token),'/users/me');
   if(!Number.isSafeInteger(Number(tokens.user_id))||Number(seller.id)!==Number(tokens.user_id)){
     throw new Error('Conta autorizada não corresponde ao vendedor.');
   }
   await saveMlTokens(ctx.db,tokens,String(seller.nickname||''));
   const {error:updateErr}=await ctx.db.from('store_marketplace_connections').upsert({
     marketplace:'mercado_livre',status:'connected',
     external_store_id:String(tokens.user_id),
     external_store_name:String(seller.nickname||'').slice(0,120),
     permissions:{read:true,write:true,origin:'mercadolivre_oauth'},
     verified_at:new Date().toISOString(),updated_at:new Date().toISOString(),
   },{onConflict:'marketplace'});
   if(updateErr)ctx.logger.warn('ml.oauth','Conectado, mas cache de status não atualizado');
   return back(true);
 }catch(err){
   ctx.logger.error('ml.oauth.callback','Não foi possível concluir autorização do Mercado Livre');
   return back(false);
 }
});
