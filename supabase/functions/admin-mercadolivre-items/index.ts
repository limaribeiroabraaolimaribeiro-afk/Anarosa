/** Consulta autenticada, somente leitura, dos anúncios reais da conta Mercado Livre. */
import { serve } from '../_shared/context.ts';
import { requireAdminUser } from '../_shared/admin-user-auth.ts';
import { mlCredentials, mlReady } from '../_shared/mercadolivre-oauth.ts';
import { activeMlConnection } from '../_shared/mercadolivre-session.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';

serve(async (req,ctx)=>{
  if(req.method!=='GET')return methodNotAllowed(req,['GET']);
  const admin=await requireAdminUser(req,ctx.db);
  const {data:permitted,error:rlError}=await ctx.db.rpc('rl_check_and_increment',{
    p_bucket:'ml-items:'+admin.id,p_limit:8,p_window_seconds:60,
  });
  if(rlError||permitted!==true) return json(req,{ok:false,message:'Aguarde antes de consultar novamente.'},429);
  const c=mlCredentials();
  if(!mlReady(c))return json(req,{ok:false,message:'O aplicativo do Mercado Livre ainda não foi configurado.'},409);
  const {row,renewing}=await activeMlConnection(ctx.db,c);
  if(!row||row.status!=='connected'||renewing||Date.parse(row.expires_at)<Date.now()){
    return json(req,{ok:false,message:'Autorize ou renove a conexão do Mercado Livre.'},409);
  }
  const url=new URL('https://api.mercadolibre.com/users/'+row.seller_id+'/items/search');
  url.searchParams.set('limit','50');
  let response:Response;
  try {
    response=await fetch(url,{
      headers:{Authorization:'Bearer '+row.access_token,Accept:'application/json'},
      signal:AbortSignal.timeout(15000),
    });
  } catch { return json(req,{ok:false,message:'Falha de rede ao consultar anúncios.'},502); }
  if(!response.ok){
    return json(req,{ok:false,message:'Mercado Livre recusou a consulta (HTTP '+response.status+').'},502);
  }
  const result=await response.json().catch(()=>null) as {paging?:{total?:number};results?:unknown[]}|null;
  if(!result||!Array.isArray(result.results)){
    return json(req,{ok:false,message:'Resposta de anúncios inesperada.'},502);
  }
  const ids=result.results.filter(v=>typeof v==='string' && /^MLB\d{8,16}$/.test(v)).slice(0,50);
  return json(req,{ok:true,sellerId:row.seller_id,total:Number(result.paging?.total)||0,listingIds:ids,
    note:'IDs confirmados diretamente pela API do Mercado Livre. Nenhum anúncio ou estoque foi alterado.'});
});
