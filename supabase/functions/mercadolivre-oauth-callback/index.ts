
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
  // Redireciona ao painel sem repassar code/state OAuth na URL de destino.
  // Supabase/browser podem exibir HTML cru no retorno do OAuth em webviews.
  const result=success?'connected'
    : /expirada|utilizada/i.test(msg)?'expired'
    : /não concedida/i.test(msg)?'denied'
    :'error';
  const url='https://www.lojaanarosa.com.br/gestao/?meli_oauth='+result+'#/integracao';
  return new Response(null,{status:303,headers:{
    'location':url,'cache-control':'no-store','referrer-policy':'no-referrer'
  }});
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

type SafeChange={title?:string;description?:string;attributes?:Array<{id:string;value_name?:string;value_id?:string}>;addPictureUrls?:string[]};
function auditError(message:string,status=400){return {message,status};}
function publicPictureUrl(input:string):boolean{
  try{
    const u=new URL(input);
    if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)return false;
    const host=u.hostname.toLowerCase();
    if(host==='gpmbkptimjipqsayrvce.supabase.co')
      return u.pathname.startsWith('/storage/v1/object/public/anarosa-product-images/');
    if(host==='www.lojaanarosa.com.br'||host==='lojaanarosa.com.br')
      return u.pathname.startsWith('/assets/') && /\.(jpe?g|png|webp)$/i.test(u.pathname);
    return false;
  }catch{return false;}
}
function normalizeEdits(input:any):SafeChange{
  if(!input||typeof input!=='object'||Array.isArray(input))throw auditError('Informe um objeto changes com campos permitidos.');
  const keys=Object.keys(input);
  if(!keys.length||keys.some(k=>!['title','description','attributes','addPictureUrls'].includes(k)))throw auditError('Campos autorizados: title, description, attributes, addPictureUrls. Preço, estoque, status e variações não são editados por esta ferramenta.');
  const c:SafeChange={};
  if('title' in input){
    if(typeof input.title!=='string'||input.title.trim().length<10||input.title.trim().length>120)
      throw auditError('Título deve ter entre 10 e 120 caracteres.');
    c.title=input.title.trim().replace(/\s+/g,' ');
  }
  if('description' in input){
    if(typeof input.description!=='string'||input.description.trim().length<20||input.description.length>7000)
      throw auditError('Descrição deve conter de 20 a 7000 caracteres e apenas texto simples.');
    if(/<[^>]+>/.test(input.description))throw auditError('Remova tags HTML da descrição.');
    c.description=input.description.trim();
  }
  if('attributes' in input){
    if(!Array.isArray(input.attributes)||input.attributes.length<1||input.attributes.length>12)
      throw auditError('Informe de 1 a 12 atributos comprovados.');
    const used=new Set<string>();
    c.attributes=input.attributes.map((x:any)=>{
      if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).some(k=>!['id','value_name','value_id'].includes(k)))
        throw auditError('Cada atributo aceita somente id, value_name e value_id.');
      const id=String(x.id||'').toUpperCase();
      if(!/^[A-Z0-9_]{2,60}$/.test(id)||used.has(id))throw auditError('ID de atributo inválido ou repetido.');
      used.add(id);
      const out:{id:string;value_name?:string;value_id?:string}={id};
      if(typeof x.value_name==='string'&&x.value_name.trim().length>0&&x.value_name.length<=160)out.value_name=x.value_name.trim();
      if(typeof x.value_id==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(x.value_id))out.value_id=x.value_id;
      if(!out.value_name&&!out.value_id)throw auditError('Informe value_name ou value_id válido para '+id+'.');
      return out;
    });
  }
  if('addPictureUrls' in input){
    if(!Array.isArray(input.addPictureUrls)||input.addPictureUrls.length<1||input.addPictureUrls.length>3
       ||input.addPictureUrls.some((x:any)=>typeof x!=='string'||!publicPictureUrl(x))
       ||new Set(input.addPictureUrls).size!==input.addPictureUrls.length)
      throw auditError('Adicione até 3 URLs HTTPS públicas e distintas de fotos da loja/Storage ANAROSA.');
    c.addPictureUrls=input.addPictureUrls;
  }
  return c;
}
function listingSnapshot(item:any,description:any):string {
  return JSON.stringify({
    id:item.id,seller_id:item.seller_id,title:item.title,sold_quantity:item.sold_quantity,
    status:item.status,last_updated:item.last_updated,
    pictures:(item.pictures||[]).map((p:any)=>p.id),
    attrs:(item.attributes||[]).map((a:any)=>[a.id,a.value_id,a.value_name]),
    variations:(item.variations||[]).map((v:any)=>[v.id,v.available_quantity,v.price]),
    description:description?.plain_text??description?.text??null,
    description_updated:description?.last_updated??null,
  });
}
async function listingState(id:string,sellerId:number,access:string){
  const [it,desc]=await Promise.all([
    readMeli('/items/'+id,access),
    readMeli('/items/'+id+'/description',access),
  ]);
  if(!it.ok||!it.data||Number((it as any).data.seller_id)!==sellerId)
    throw auditError('Anúncio não encontrado ou não pertence a esta conta.',403);
  if(!desc.ok&&desc.status!==404)throw auditError('Descrição atual não pôde ser validada. Não é seguro editar agora.',502);
  return {item:(it as any).data,description:desc.ok?(desc as any).data:null};
}
async function snapshotHash(item:any,description:any):Promise<string>{
  return sha(listingSnapshot(item,description));
}
async function validateEditAgainstItem(c:SafeChange,item:any,access:string){
  if(['closed','inactive'].includes(String(item.status||'')))throw auditError('Anúncios encerrados/inativos não são alterados por esta ferramenta.');
  const hasVariations=Array.isArray(item.variations)&&item.variations.length>0;
  if(c.title&&Number(item.sold_quantity)>0)throw auditError('O Mercado Livre impede alterar o título de anúncio com vendas. É necessário analisar alternativa sem perder histórico.');
  if(hasVariations&&(c.attributes||c.addPictureUrls))
    throw auditError('Este anúncio possui variações; alteração de atributos/fotos exige fluxo específico para preservar tamanho, cor e fotos de cada variação. Apenas título/descrição estão liberados aqui.');
  if(c.addPictureUrls&&((item.pictures||[]).length+c.addPictureUrls.length)>12)
    throw auditError('Limite conservador de 12 imagens: não substituir fotos existentes automaticamente.');
  if(c.attributes){
    const meta=await readMeli('/categories/'+encodeURIComponent(String(item.category_id))+'/attributes',access);
    if(!meta.ok||!Array.isArray((meta as any).data))throw auditError('Não foi possível validar os atributos permitidos pela categoria.',502);
    const allowed=new Map((meta as any).data.map((v:any)=>[v.id,v]));
    for(const a of c.attributes){
      const definition:any=allowed.get(a.id);
      if(!definition||definition.tags?.read_only===true||definition.tags?.hidden===true)
        throw auditError('Atributo '+a.id+' não é editável nesta categoria.');
      if(a.id==='GTIN'&&a.value_name&&!/^\d{8,14}$/.test(a.value_name))
        throw auditError('GTIN deve ser um código real de 8 a 14 dígitos; não invente códigos.');
    }
  }
}
async function writeMeli(path:string,access:string,body:any,method:'PUT'|'POST'='PUT'){
  const r=await fetch(BASE+path,{method,
    headers:{Authorization:'Bearer '+access,'Content-Type':'application/json',Accept:'application/json'},
    body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  const payload=await r.json().catch(()=>({}));
  if(!r.ok)return {ok:false,httpStatus:r.status,error:String(payload?.message||payload?.error||'Rejeitado pela API').slice(0,250),
    causes:Array.isArray(payload?.cause)?payload.cause.slice(0,8).map((v:any)=>({code:v.code,message:String(v.message||'').slice(0,150)})):[]};
  return {ok:true,httpStatus:r.status,warnings:Array.isArray(payload?.warnings)?payload.warnings.slice(0,5):[]};
}
async function editWorkflow(req:Request,adminId:string,body:any){
  const requested=String(body.action||'');
  const {data:allowed,error:rateError}=await db.rpc('rl_check_and_increment',{
    p_bucket:'meli-edit-'+requested+':'+adminId,p_limit:requested==='edit_apply'?6:15,p_window_seconds:3600});
  if(rateError||allowed!==true)return json(req,{ok:false,message:'Limite temporário de edições atingido.'},429);
  const row=await connection();
  if(!row)return json(req,{ok:false,message:'A conta Mercado Livre não está conectada.'},409);
  let access:string;
  try{access=await usableToken(row);}catch{return json(req,{ok:false,message:'Autorização do Mercado Livre indisponível para editar.'},503);}
  if(requested==='edit_preview'){
    const id=String(body.id||'').toUpperCase().trim();
    if(!/^MLB\d{8,16}$/.test(id))return json(req,{ok:false,message:'Código do anúncio MLB inválido.'},400);
    try{
      const changes=normalizeEdits(body.changes);
      const {item,description}=await listingState(id,Number(row.seller_id),access);
      await validateEditAgainstItem(changes,item,access);
      const before:any={},after:any={};
      if(changes.title){before.title=item.title;after.title=changes.title;}
      if(changes.description){before.description=description?.plain_text||description?.text||'';after.description=changes.description;}
      if(changes.attributes){before.attributes=(item.attributes||[]).filter((a:any)=>changes.attributes!.some(v=>v.id===a.id))
          .map((a:any)=>({id:a.id,value_name:a.value_name,value_id:a.value_id}));
        after.attributes=changes.attributes;}
      if(changes.addPictureUrls){before.pictureCount=(item.pictures||[]).length;after.pictureCount=before.pictureCount+changes.addPictureUrls.length;after.addPictureUrls=changes.addPictureUrls;}
      if(Object.entries(after).every(([k,v])=>JSON.stringify(v)===JSON.stringify(before[k])))
        return json(req,{ok:false,message:'Nenhuma alteração em relação ao anúncio atual.'},400);
      const preview={id,title:item.title,soldQuantity:item.sold_quantity,status:item.status,
        changes:{before,after},notChanged:['price','available_quantity','variations','shipping','status'],
        warning:'A revisão é somente uma proposta. A operação final exigirá nova confirmação e nova conferência do anúncio no Mercado Livre.'};
      const digest=await snapshotHash(item,description);
      const {data:inserted,error:insertError}=await db.from('meli_edit_intents').insert({
        seller_id:row.seller_id,item_id:id,admin_user_id:adminId,snapshot_hash:digest,
        changes,preview,expires_at:new Date(Date.now()+15*60*1000).toISOString()
      }).select('id,expires_at').single();
      if(insertError||!inserted)return json(req,{ok:false,message:'Não foi possível registrar prévia segura da alteração.'},503);
      return json(req,{ok:true,applied:false,previewId:inserted.id,expiresAt:inserted.expires_at,preview,
        instructions:'Mostre a prévia completa ao administrador. Só chame mercadolivre_aplicar_correcao depois de aprovação explícita, usando o previewId retornado.'});
    }catch(e){return json(req,{ok:false,message:String((e as any)?.message||'Não foi possível preparar a correção.').slice(0,300)},(e as any)?.status||400);}
  }
  const intentId=String(body.previewId||'');
  if(body.confirmar!==true||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(intentId))
    return json(req,{ok:false,message:'Confirmação do administrador e ID da prévia obrigatórios.'},400);
  const {data:intent,error:foundError}=await db.from('meli_edit_intents').select('*').eq('id',intentId)
    .eq('admin_user_id',adminId).eq('seller_id',row.seller_id).maybeSingle();
  if(foundError||!intent)return json(req,{ok:false,message:'Prévia não encontrada para este administrador.'},404);
  if(intent.consumed_at)return json(req,{ok:false,message:'Prévia já utilizada. Consulte o resultado e não repita a operação automaticamente.',previousOutcome:intent.outcome||null},409);
  if(Date.parse(intent.expires_at)<=Date.now())return json(req,{ok:false,message:'Prévia expirou. Consulte o anúncio e prepare outra correção.'},409);
  let item:any,description:any;
  try{
    ({item,description}=await listingState(intent.item_id,Number(row.seller_id),access));
    const digest=await snapshotHash(item,description);
    if(digest!==intent.snapshot_hash)return json(req,{ok:false,message:'O anúncio mudou após a prévia. Nova revisão obrigatória; nenhuma escrita foi feita.'},409);
    await validateEditAgainstItem(normalizeEdits(intent.changes),item,access);
  }catch(e){return json(req,{ok:false,message:String((e as any)?.message||'Não foi possível conferir anúncio antes de editar.').slice(0,250)},(e as any)?.status||400);}
  const {data:claimed,error:claimError}=await db.from('meli_edit_intents')
    .update({consumed_at:new Date().toISOString()}).eq('id',intentId).eq('admin_user_id',adminId)
    .is('consumed_at',null).gt('expires_at',new Date().toISOString()).select('id').maybeSingle();
  if(claimError||!claimed)return json(req,{ok:false,message:'A revisão já foi aplicada ou está sendo processada. Não repetir automaticamente.'},409);
  const changes=normalizeEdits(intent.changes);
  const updates:any={};
  if(changes.title)updates.title=changes.title;
  if(changes.attributes)updates.attributes=changes.attributes; // Apenas IDs validados; nunca envia estoque nem variações.
  if(changes.addPictureUrls)updates.pictures=[
    ...(item.pictures||[]).map((x:any)=>({id:x.id})),...changes.addPictureUrls.map(url=>({source:url}))
  ];
  const result:any={ok:false,applied:false,previewId:intentId,itemId:intent.item_id,
    acceptedByMercadoLivre:{item:false,description:false},partial:false};
  try{
    if(Object.keys(updates).length){
      const r=await writeMeli('/items/'+intent.item_id,access,updates);
      result.itemResult=r;
      result.acceptedByMercadoLivre.item=r.ok;
      if(!r.ok){result.message='Mercado Livre rejeitou a alteração do anúncio. Nenhuma descrição foi modificada.';}
    }
    if((!Object.keys(updates).length||result.acceptedByMercadoLivre.item)&&changes.description){
      const r=await writeMeli('/items/'+intent.item_id+'/description?api_version=2',access,
        {plain_text:changes.description},description?'PUT':'POST');
      result.descriptionResult=r;
      result.acceptedByMercadoLivre.description=r.ok;
      if(!r.ok)result.message='A API recusou a descrição. Verifique possíveis alterações parciais do anúncio.';
    }
    const successes=Number(result.acceptedByMercadoLivre.item)+Number(result.acceptedByMercadoLivre.description);
    const expected=Number(Object.keys(updates).length>0)+Number(!!changes.description);
    result.ok=expected>0&&successes===expected;
    result.applied=successes>0;
    result.partial=successes>0&&successes<expected;
    result.message=result.ok?'Mercado Livre aceitou todas as atualizações solicitadas.':'Alteração não totalmente concluída. Confira resultado e faça nova prévia para ajustes.';
    if(result.applied){
      try{
        const current=await listingState(intent.item_id,Number(row.seller_id),access);
        result.verifiedTitle=changes.title?current.item.title===changes.title:null;
        result.verifiedDescription=changes.description?
          (current.description?.plain_text||current.description?.text||'').trim()===changes.description:null;
      }catch{result.verificationPending=true;}
    }
  }catch{
    result.partial=true;result.message='Resposta da API interrompida. Confira o anúncio antes de qualquer nova tentativa; não repetir automaticamente.';
  }
  await db.from('meli_edit_intents').update({outcome:result}).eq('id',intentId);
  return json(req,result,result.ok?200:207);
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
  if(action==='edit_preview'||action==='edit_apply')return editWorkflow(req,adminId,body);
  if(!['list','detail','verify'].includes(action))return json(req,{ok:false,message:'Operação desconhecida.'},400);
  const row=await connection();
  if(!row)return json(req,{ok:false,connected:false,message:'Conecte primeiro a conta Mercado Livre na Gestão.'},409);
  let access:string;
  try{access=await usableToken(row);}catch{return json(req,{ok:false,message:'Não foi possível renovar a autorização Mercado Livre. Tente novamente ou reconecte a conta.'},503);}
  if(action==='verify'){
    // Verificação ativa: confirma identidade, autorização e leitura de publicações na API oficial.
    const {data:allowed,error:rateError}=await db.rpc('rl_check_and_increment',{
      p_bucket:'meli-verify:'+adminId,p_limit:12,p_window_seconds:60
    });
    if(rateError||allowed!==true)return json(req,{ok:false,message:'Muitas verificações. Aguarde um minuto e tente novamente.'},429);
    let owner:any;
    try {owner=await readMeli('/users/me',access);}catch {owner={ok:false,status:0};}
    if(!owner.ok || String(owner.data?.id)!==String(row.seller_id))
      return json(req,{ok:false,connected:true,verified:false,
        message:'A conta foi salva, mas não foi possível validar a identidade na API do Mercado Livre.',
        httpStatus:owner.status||null},502);
    const path='/users/'+encodeURIComponent(String(row.seller_id))+'/items/search?limit=1&offset=0';
    let listing:any;
    try {listing=await readMeli(path,access);}catch {listing={ok:false,status:0};}
    if(!listing.ok)return json(req,{ok:false,connected:true,verified:false,
      message:'A conta foi validada, mas o Mercado Livre não permitiu consultar os anúncios.',
      httpStatus:listing.status||null},502);
    const count=Number(listing.data?.paging?.total);
    return json(req,{ok:true,connected:true,verified:true,source:'Mercado Livre API',
      sellerNickname:row.seller_nickname,
      listingsTotal:Number.isFinite(count)&&count>=0?count:null,
      checkedAt:new Date().toISOString()});
  }
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
