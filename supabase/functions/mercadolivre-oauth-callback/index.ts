
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const APP = Deno.env.get('SUPABASE_URL') || '';
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const CLIENT_ID = Deno.env.get('MELI_CLIENT_ID') || '';
const CLIENT_SECRET = Deno.env.get('MELI_CLIENT_SECRET') || '';
const REDIRECT = APP + '/functions/v1/mercadolivre-oauth-callback';
const BASE = 'https://api.mercadolibre.com';
const db = createClient(APP,SERVICE,{auth:{autoRefreshToken:false,persistSession:false}});
const allowedOrigins = new Set(['https://www.lojaanarosa.com.br','https://lojaanarosa.com.br']);

function headers(req:Request):HeadersInit {
  const origin=req.headers.get('origin')||'';
  return {'content-type':'application/json; charset=utf-8','cache-control':'no-store',
    ...(allowedOrigins.has(origin)?{'access-control-allow-origin':origin,'vary':'Origin'}:{})};
}
function json(req:Request,obj:unknown,status=200){return new Response(JSON.stringify(obj),{status,headers:headers(req)});}
function page(msg:string,success=false){
  const h='<html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Integração ANAROSA</title><body style="font-family:system-ui;background:#faf7f2;color:#352514;max-width:640px;margin:60px auto;padding:24px"><h1>Gestão ANAROSA</h1><p>'+msg+'</p><p><a href="https://www.lojaanarosa.com.br/gestao/#/integracao">Voltar às integrações</a></p></body></html>';
  return new Response(h,{status:success?200:400,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; style-src 'unsafe-inline';"}});
}
function hex(bytes:Uint8Array){return Array.from(bytes).map(x=>x.toString(16).padStart(2,'0')).join('');}
async function sha(s:string){return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))));}
function configured(){return !!APP && !!SERVICE && !!CLIENT_ID && !!CLIENT_SECRET;}
async function admin(req:Request){
  const tok=/^Bearer\s+(.+)$/i.exec(req.headers.get('authorization')||'')?.[1];
  if(!tok)return null;
  const user=await db.auth.getUser(tok);
  if(user.error||!user.data?.user?.id)return null;
  const {data}=await db.from('store_admins').select('user_id').eq('user_id',user.data.user.id).eq('active',true).maybeSingle();
  return data?.user_id || null;
}
async function tokenRequest(values:Record<string,string>) {
  const r=await fetch(BASE+'/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','accept':'application/json'},
    body:new URLSearchParams(values),signal:AbortSignal.timeout(15000)});
  const val=await r.json().catch(()=>null);
  if(!r.ok || !val || typeof val.access_token!=='string' || typeof val.refresh_token!=='string' || !Number.isFinite(Number(val.expires_in)))throw Error('token_exchange_failed');
  return val;
}
async function readMeli(path:string,access:string){
  if(!path.startsWith('/')||path.includes('..')||path.includes('//'))throw Error('path_invalid');
  const r=await fetch(BASE+path,{headers:{Authorization:'Bearer '+access,Accept:'application/json'},signal:AbortSignal.timeout(16000)});
  if(!r.ok)return {ok:false,status:r.status};
  return {ok:true,data:await r.json()};
}
async function connection(){
  const {data,error}=await db.from('meli_connections')
    .select('seller_id,seller_nickname,access_token,refresh_token,expires_at,refresh_lock_until,scope,updated_at').order('updated_at',{ascending:false}).limit(1).maybeSingle();
  if(error)throw Error('db_read_failed');
  return data;
}
async function usableToken(row:any):Promise<string>{
  if(Date.parse(row.expires_at)>Date.now()+120000)return row.access_token;
  const until=new Date(Date.now()+30000).toISOString();
  const {data:claimed,error}=await db.from('meli_connections').update({refresh_lock_until:until})
   .eq('seller_id',row.seller_id)
   .or('refresh_lock_until.is.null,refresh_lock_until.lt.'+new Date().toISOString())
   .select('seller_id').maybeSingle();
  if(error)throw Error('refresh_lock_failed');
  if(!claimed) {
    const later=await connection();
    if(later && Date.parse(later.expires_at)>Date.now()+30000)return later.access_token;
    throw Error('refresh_busy');
  }
  try{
    const fresh=await tokenRequest({grant_type:'refresh_token',client_id:CLIENT_ID,client_secret:CLIENT_SECRET,refresh_token:row.refresh_token});
    const {error:saveError}=await db.from('meli_connections').update({
      access_token:fresh.access_token,refresh_token:fresh.refresh_token,
      expires_at:new Date(Date.now()+Number(fresh.expires_in)*1000).toISOString(),
      scope:String(fresh.scope||''),refresh_lock_until:null,updated_at:new Date().toISOString(),
    }).eq('seller_id',row.seller_id);
    if(saveError)throw Error('token_refresh_save_failed');
    return fresh.access_token;
  }catch(e){
    await db.from('meli_connections').update({refresh_lock_until:null}).eq('seller_id',row.seller_id);
    throw e;
  }
}
async function callback(req:Request){
  const u=new URL(req.url),code=u.searchParams.get('code')||'',state=u.searchParams.get('state')||'';
  if(u.searchParams.has('error'))return page('Autorização não concedida. Volte à Gestão e tente novamente.');
  if(!configured())return page('Integração ainda não configurada no servidor.');
  if(!/^[\w-]{10,300}$/.test(code) || !/^[a-f0-9]{64}$/.test(state))return page('Retorno OAuth inválido.');
  const hash=await sha(state);
  const {data:used,error}=await db.from('meli_oauth_states').update({used:true}).eq('state_hash',hash).eq('used',false)
    .gt('expires_at',new Date().toISOString()).select('admin_user_id').maybeSingle();
  if(error||!used)return page('Autorização expirada ou já utilizada. Inicie outra conexão pela Gestão.');
  try{
    const token=await tokenRequest({grant_type:'authorization_code',client_id:CLIENT_ID,client_secret:CLIENT_SECRET,
      code,redirect_uri:REDIRECT});
    const me=await readMeli('/users/me',token.access_token);
    const userId=Number((me as any).data?.id),nick=String((me as any).data?.nickname||'');
    if(!me.ok || !Number.isSafeInteger(userId)||userId<=0||Number(token.user_id)!==userId)throw Error('identity_invalid');
    const {error:dbError}=await db.from('meli_connections').upsert({
      seller_id:userId,seller_nickname:nick.slice(0,100),access_token:token.access_token,refresh_token:token.refresh_token,
      scope:String(token.scope||''),expires_at:new Date(Date.now()+Number(token.expires_in)*1000).toISOString(),
      connected_by:used.admin_user_id,refresh_lock_until:null,updated_at:new Date().toISOString()
    },{onConflict:'seller_id'});
    if(dbError)throw Error('token_storage_failed');
    await db.from('store_marketplace_connections').update({
      status:'connected',external_store_id:String(userId),external_store_name:nick.slice(0,100),
      verified_at:new Date().toISOString(),updated_at:new Date().toISOString()
    }).eq('marketplace','mercado_livre');
    return page('A conta Mercado Livre foi autorizada e vinculada à Gestão ANAROSA. Você pode retornar ao painel para consultar os anúncios.',true);
  }catch{
    return page('Não foi possível concluir a autorização. Verifique as credenciais e tente novamente pela Gestão.');
  }
}
Deno.serve(async(req:Request)=>{
  if(req.method==='OPTIONS'){
    const hh=headers(req);
    return new Response(null,{status:204,headers:{...hh,'access-control-allow-headers':'authorization,apikey,content-type','access-control-allow-methods':'POST,GET,OPTIONS'}});
  }
  if(req.method==='GET')return callback(req);
  if(req.method!=='POST')return json(req,{ok:false,message:'Método não permitido.'},405);
  const adminId=await admin(req).catch(()=>null);
  if(!adminId)return json(req,{ok:false,message:'Sessão administrativa não autorizada.'},401);
  if(!configured())return json(req,{ok:false,message:'Credenciais Mercado Livre ainda não configuradas no Supabase.',configured:false},503);
  let body:any;
  try{body=await req.json();}catch{return json(req,{ok:false,message:'JSON inválido.'},400);}
  const action=String(body?.action||'');
  if(action==='status'){
    const row=await connection();
    return json(req,{ok:true,configured:true,connected:!!row,
      sellerNickname:row?.seller_nickname||null,
      lastCheckedAt:row?.updated_at||null,
      expiresAt:row?.expires_at||null});
  }
  if(action==='start'){
    const {data:limit,error:rateErr}=await db.rpc('rl_check_and_increment',{
      p_bucket:'meli-oauth:'+adminId,p_limit:5,p_window_seconds:3600});
    if(rateErr||limit!==true)return json(req,{ok:false,message:'Limite de autorizações atingido. Tente novamente mais tarde.'},429);
    const raw=hex(crypto.getRandomValues(new Uint8Array(32)));
    const {error}=await db.from('meli_oauth_states').insert({
      state_hash:await sha(raw),admin_user_id:adminId,expires_at:new Date(Date.now()+10*60*1000).toISOString()
    });
    if(error)return json(req,{ok:false,message:'Falha ao iniciar autorização.'},503);
    const u=new URL('https://auth.mercadolivre.com.br/authorization');
    u.search=new URLSearchParams({response_type:'code',client_id:CLIENT_ID,redirect_uri:REDIRECT,state:raw}).toString();
    return json(req,{ok:true,authorizationUrl:u.toString(),expiresInMinutes:10});
  }
  if(!['list','detail'].includes(action))return json(req,{ok:false,message:'Operação desconhecida.'},400);
  const row=await connection();
  if(!row)return json(req,{ok:false,connected:false,message:'Conecte primeiro a conta Mercado Livre na Gestão.'},409);
  let access:string;
  try{access=await usableToken(row);}catch{return json(req,{ok:false,message:'Não foi possível renovar a autorização Mercado Livre. Tente novamente ou reconecte a conta.'},503);}
  if(action==='list'){
    const offset=Math.max(0,Math.min(1000,Number(body.offset)||0));
    const limit=Math.max(1,Math.min(30,Number(body.limit)||15));
    const p='/users/'+encodeURIComponent(String(row.seller_id))+'/items/search?limit='+limit+'&offset='+offset;
    const r=await readMeli(p,access);
    if(!r.ok)return json(req,{ok:false,message:'Mercado Livre não retornou a lista de anúncios.',httpStatus:(r as any).status},502);
    const out=(r as any).data;
    return json(req,{ok:true,source:'Mercado Livre API',seller:row.seller_nickname,
      total:out.paging?.total??null,offset,ids:Array.isArray(out.results)?out.results.slice(0,limit):[]});
  }
  const id=String(body.id||'').toUpperCase().trim();
  if(!/^MLB\d{8,16}$/.test(id))return json(req,{ok:false,message:'ID do anúncio MLB inválido.'},400);
  const item=await readMeli('/items/'+id,access);
  if(!item.ok)return json(req,{ok:false,message:'Não foi possível consultar esse anúncio na conta conectada.',httpStatus:(item as any).status},502);
  const d=(item as any).data;
  if(Number(d.seller_id)!==Number(row.seller_id))return json(req,{ok:false,message:'Este anúncio não pertence à conta Mercado Livre vinculada.'},403);
  const [performance,description]=await Promise.all([
    readMeli('/item/'+id+'/performance',access),
    readMeli('/items/'+id+'/description',access)
  ]);
  const p=performance.ok?(performance as any).data:null;
  return json(req,{ok:true,source:'Mercado Livre API',item:{
      id:d.id,title:d.title,price:d.price,currency_id:d.currency_id,original_price:d.original_price,
      status:d.status,sub_status:d.sub_status,available_quantity:d.available_quantity,
      sold_quantity:d.sold_quantity,category_id:d.category_id,listing_type_id:d.listing_type_id,
      permalink:d.permalink,condition:d.condition,warranty:d.warranty,
      pictures:(d.pictures||[]).slice(0,15).map((x:any)=>({id:x.id,url:x.secure_url})),
      attributes:(d.attributes||[]).slice(0,80).map((x:any)=>({id:x.id,name:x.name,value_name:x.value_name,value_id:x.value_id})),
      variations:(d.variations||[]).slice(0,40).map((x:any)=>({id:x.id,available_quantity:x.available_quantity,
        price:x.price,attribute_combinations:x.attribute_combinations,attributes:x.attributes})),
      tags:(d.tags||[]).slice(0,30),shipping:d.shipping?{mode:d.shipping.mode,free_shipping:d.shipping.free_shipping}:null
    },
    description:description.ok?String((description as any).data?.plain_text||(description as any).data?.text||'').slice(0,7000):null,
    performance:p?{score:p.score,level:p.level,level_wording:p.level_wording,calculated_at:p.calculated_at,
      buckets:Array.isArray(p.buckets)?p.buckets.slice(0,30):[]}:null,
    performanceUnavailable:!performance.ok
  });
});
