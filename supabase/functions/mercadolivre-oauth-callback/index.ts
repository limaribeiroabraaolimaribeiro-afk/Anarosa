
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

type SafeChange={title?:string;description?:string;attributes?:Array<{id:string;value_name?:string;value_id?:string}>;addPictureUrls?:string[];condition?:'new'};
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
  if(!keys.length||keys.some(k=>!['title','description','attributes','addPictureUrls','condition'].includes(k)))throw auditError('Campos autorizados: title, description, attributes, addPictureUrls, condition (somente Novo e anúncio DUZIZO). Preço, estoque, status e variações não são editados por esta ferramenta.');
  const c:SafeChange={};
  if('condition' in input){
    if(input.condition!=='new')throw auditError('A condição autorizada é exclusivamente Novo.');
    c.condition='new';
  }
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
  if(c.condition){
    if(item.id!=='MLB5529252361'||item.category_id!=='MLB28130'||item.status!=='active'||Number(item.sold_quantity)!==0)
      throw auditError('Condição Novo permitida apenas para o body DUZIZO, ativo e sem vendas.');
    if(!['not_specified','new'].includes(String(item.condition||'')))
      throw auditError('Condição atual inesperada; não alterar.');
  }
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
    causes:Array.isArray(payload?.cause)?payload.cause.slice(0,8).map((v:any)=>({code:v.code,type:v.type,cause_id:v.cause_id,references:v.references,message:String(v.message||'').slice(0,150)})):[]};
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
       if(changes.condition){before.condition=item.condition;after.condition=changes.condition;}
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
   if(changes.condition)updates.condition=changes.condition;
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
         if(changes.condition){
           result.verifiedCondition=current.item.condition===changes.condition;
           if(!result.verifiedCondition){
             result.ok=false;result.partial=true;
             result.message='A condição Novo não foi confirmada após a atualização.';
           }
         }
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



async function correctNewCondition(req:Request,adminId:string,body:any){
  // Somente alteração explícita da condição do body ANAROSA no anúncio existente.
  const id=String(body.id||'').trim().toUpperCase();
  if(body.confirmar!==true||id!=='MLB5529252361')return json(req,{ok:false,message:'Confirme o anúncio body da ANAROSA para corrigir a condição.'},400);
  const {data:permit,error:limitErr}=await db.rpc('rl_check_and_increment',{
    p_bucket:'meli-condition:'+adminId,p_limit:2,p_window_seconds:3600
  });
  if(limitErr||permit!==true)return json(req,{ok:false,message:'Limite de alterações de condição atingido.'},429);
  const {data:link,error:linkErr}=await db.from('store_marketplace_listings')
    .select('id,bling_product_id,status,external_listing_id').eq('external_listing_id',id)
    .eq('marketplace','mercado_livre').maybeSingle();
  if(linkErr||!link||link.status!=='published'||link.bling_product_id!=='16725286274')
    return json(req,{ok:false,message:'Vínculo do anúncio com o body no Bling não está confirmado.'},409);
  const row=await connection();
  if(!row)return json(req,{ok:false,message:'Conta do Mercado Livre não está conectada.'},409);
  let token:string;
  try{token=await usableToken(row);}
  catch{return json(req,{ok:false,message:'Token Mercado Livre indisponível.'},503);}
  let current:any;
  try{current=(await listingState(id,Number(row.seller_id),token)).item;}
  catch{return json(req,{ok:false,message:'Não foi possível validar o anúncio existente.'},502);}
  if(String(current.status)!=='active'||Number(current.sold_quantity)!==0||String(current.category_id)!=='MLB28130')
    return json(req,{ok:false,message:'A alteração exige anúncio ativo, sem vendas e na categoria confirmada.'},409);
  if(current.condition==='new')return json(req,{ok:true,applied:false,alreadyNew:true,verified:true,condition:'new',id});
  if(current.condition!=='not_specified')return json(req,{ok:false,message:'A condição atual é diferente de não especificada; atualização suspensa.'},409);
  const old={title:current.title,price:current.price,available_quantity:current.available_quantity,
    shipping:current.shipping?.mode,pictures:(current.pictures||[]).map((x:any)=>x.id)};
  // O campo condition permanece disponível para compatibilidade, conforme documentação oficial.
  // Não altera título, descrição, preço, estoque, fotos ou frete.
  let response:any;
  try{response=await writeMeli('/items/'+id,token,{condition:'new'});}
  catch{return json(req,{ok:false,uncertain:true,message:'A resposta do Mercado Livre foi interrompida. Verifique a condição antes de qualquer nova tentativa.'},502);}
  if(!response.ok)return json(req,{ok:false,applied:false,message:'Mercado Livre recusou a atualização da condição.',result:response},422);
  const checked=await readMeli('/items/'+id,token);
  if(!checked.ok)return json(req,{ok:false,uncertain:true,message:'Atualização enviada, mas ainda não foi possível verificar a condição.',result:response},502);
  const after=checked.data;
  const unchanged=String(after.title)===String(old.title)&&Number(after.price)===Number(old.price)&&
    Number(after.available_quantity)===Number(old.available_quantity)&&String(after.shipping?.mode)===String(old.shipping)&&
    JSON.stringify((after.pictures||[]).map((x:any)=>x.id))===JSON.stringify(old.pictures);
  return json(req,{
    ok:after.condition==='new'&&unchanged,applied:true,verified:after.condition==='new',unchanged,
    id,condition:after.condition,status:after.status,price:after.price,quantity:after.available_quantity,
    message:after.condition==='new'&&unchanged
      ?'Condição Novo confirmada pela API oficial; título, estoque, preço, fotos e frete preservados.'
      :'Mudança parcialmente verificada. Revise o anúncio antes de outras alterações.'
  },after.condition==='new'&&unchanged?200:207);
}


/** Adicionar variação Verde/P à família DUZIZO via User Products (nunca via array variations). */

async function mergeDuzizoFamily(req:Request,adminId:string,body:any){
 const RED='MLB5529252361',GREEN='MLB7960343796',
 RU='MLBU5797635001',GU='MLBU5850814980',
 RF='3457429658838545',GF='82386193060690';
 if(body.confirmar!==true||body.redItemId!==RED||body.greenItemId!==GREEN)
  return json(req,{ok:false,message:'Confirme os dois anúncios e a operação de vínculo.'},400);
 const {data:limit,error:lerr}=await db.rpc('rl_check_and_increment',{
  p_bucket:'meli-family-merge:'+adminId,p_limit:2,p_window_seconds:3600
 });
 if(lerr||limit!==true)return json(req,{ok:false,message:'Limite de ajustes de família atingido.'},429);
 const row=await connection();
 if(!row)return json(req,{ok:false,message:'Mercado Livre desconectado.'},409);
 let access:string;
 try{access=await usableToken(row);}catch{return json(req,{ok:false,message:'Autorização indisponível.'},503);}
 const [red,green,redUP,greenUP,redF,greenF,local]=await Promise.all([
  readMeli('/items/'+RED,access),readMeli('/items/'+GREEN,access),
  readMeli('/user-products/'+RU,access),readMeli('/user-products/'+GU,access),
  readMeli('/user-products-families/'+RF,access),readMeli('/user-products-families/'+GF,access),
  db.from('store_marketplace_listings').select('id,status,external_listing_id,variation_mapping')
    .eq('external_listing_id',GREEN).eq('marketplace','mercado_livre').maybeSingle()
 ]);
 if(!red.ok||!green.ok||!redUP.ok||!greenUP.ok||!redF.ok||!local.data)
  return json(req,{ok:false,message:'Não foi possível validar os anúncios e as famílias.'},502);
 const redItem=red.data,greenItem=green.data;
 if(Number(redItem.seller_id)!==Number(row.seller_id)||Number(greenItem.seller_id)!==Number(row.seller_id)||
    redItem.status!=='active'||!['paused','active'].includes(greenItem.status)||
    Number(redItem.sold_quantity)!==0||Number(greenItem.sold_quantity)!==0||
    redItem.condition!=='new'||greenItem.condition!=='new'||
    redItem.category_id!=='MLB28130'||greenItem.category_id!=='MLB28130'||
    String(redItem.user_product_id)!==RU||String(greenItem.user_product_id)!==GU||
    greenItem.family_name!==redItem.family_name||
    Number(redItem.price)!==77.9||Number(greenItem.price)!==77.9||
    Number(redItem.available_quantity)!==3||Number(greenItem.available_quantity)!==3)
  return json(req,{ok:false,message:'Um anúncio mudou; nenhuma atualização de família será feita.'},409);
 const sku=(item:any)=>String((item.attributes||[]).find((a:any)=>a.id==='SELLER_SKU')?.value_name||'');
 if(sku(redItem)!=='0001'||sku(greenItem)!=='0002')
  return json(req,{ok:false,message:'Variações do Bling não conferem com os anúncios.'},409);
 const redFamily=String(redUP.data.family_id),greenFamily=String(greenUP.data.family_id);
 if(redFamily===greenFamily){
  const result=await resumeGreenAfterFamilyMerge(access,row,local.data.id,RF,GU,RED,GREEN);
  return json(req,{...result,alreadyGrouped:true},result.ok?200:202);
 }
 if(redFamily!==RF||greenFamily!==GF)
  return json(req,{ok:false,message:'A família mudou desde a revisão anterior.'},409);
 const redAttrs=redF.data?.attributes||[],greenAttrs=greenF.data?.attributes||[];
 const matchName=redF.data?.family_name===greenF.data?.family_name;
 const parent=(attrs:any[])=>attrs.filter((a:any)=>a.hierarchy==='PARENT_PK')
   .map((a:any)=>[a.id,a.values?.[0]?.name]).sort((a:any,b:any)=>String(a[0]).localeCompare(String(b[0])));
 const oldCond=redAttrs.find((a:any)=>a.id==='ITEM_CONDITION');
 const greenCond=greenAttrs.find((a:any)=>a.id==='ITEM_CONDITION');
 if(!matchName||JSON.stringify(parent(redAttrs))!==JSON.stringify(parent(greenAttrs))||
    oldCond||greenCond?.values?.[0]?.id!=='2230284')
  return json(req,{ok:false,message:'Diferenças entre famílias exigem revisão; alteração suspensa.'},409);
 let raw:Response,answer:any;
 try{
  raw=await fetch(BASE+'/user-products-families/'+RF,{
   method:'PUT',
   headers:{Authorization:'Bearer '+access,'Content-Type':'application/json',Accept:'application/json'},
   body:JSON.stringify({attributes:[{id:'ITEM_CONDITION',values:[{id:'2230284'}]}]}),
   signal:AbortSignal.timeout(22000)
  });
  answer=await raw.json().catch(()=>({}));
 }catch{return json(req,{ok:false,uncertain:true,
   message:'Resposta da atualização de família incerta. Verifique a família antes de repetir.'},502);}
 if(!raw.ok)return json(req,{ok:false,stage:'family_update',httpStatus:raw.status,
  message:String(answer?.message||answer?.error||'Atualização recusada'),
  causes:Array.isArray(answer?.cause)?answer.cause.slice(0,8).map((a:any)=>({code:a.code,message:a.message})):[]},422);
 let newRF:any,newGF:any;
 for(let i=0;i<3;i++){
  [newRF,newGF]=await Promise.all([
    readMeli('/user-products/'+RU,access),readMeli('/user-products/'+GU,access)
  ]);
  if(newRF.ok&&newGF.ok&&String(newRF.data?.family_id)===String(newGF.data?.family_id))break;
  if(i<2)await new Promise(resolve=>setTimeout(resolve,500));
 }
 if(!newRF.ok||!newGF.ok||String(newRF.data?.family_id)!==String(newGF.data?.family_id))
  return json(req,{ok:false,acceptedByMarketplace:true,linked:false,
   redFamilyId:newRF.ok?newRF.data?.family_id:null,greenFamilyId:newGF.ok?newGF.data?.family_id:null,
   message:'Alteração de família aceita, mas o agrupamento ainda não foi confirmado pela API.'},202);
 const mergedId=String(newRF.data.family_id);
 const resumed=await resumeGreenAfterFamilyMerge(access,row,local.data.id,mergedId,GU,RED,GREEN);
 return json(req,{...resumed,mergedFamilyId:mergedId},resumed.ok?200:202);
}
async function resumeGreenAfterFamilyMerge(access:string,row:any,localId:string,familyId:string,greenUpId:string,redId:string,greenId:string){
 const check=await readMeli('/user-products-families/'+familyId+'/user-products',access);
 if(!check.ok||!check.data?.user_products_ids?.includes(greenUpId)||!check.data?.user_products_ids?.includes('MLBU5797635001'))
  return {ok:false,linked:false,message:'Membros da família não foram validados; anúncio verde permanece pausado.'};
 let green=await readMeli('/items/'+greenId,access);
 if(!green.ok)return {ok:false,linked:true,message:'Família confirmada; anúncio verde não pôde ser consultado.'};
 let activation:any={ok:true};
 if(green.data?.status==='paused'){
  try{activation=await writeMeli('/items/'+greenId,access,{status:'active'});}
  catch{activation={ok:false,error:'Ativação não confirmada'};}
  green=await readMeli('/items/'+greenId,access);
 }
 const active=green.ok&&green.data?.status==='active';
 await db.from('store_marketplace_listings').update({
  status:'published',
  last_error:active?null:'Família vinculada, verde ainda pausado: '+String(activation.error||'verificar pendências'),
  published_at:new Date().toISOString()
 }).eq('id',localId);
 return {ok:true,linked:true,active,redItemId:redId,greenItemId:greenId,
  familyId,remoteStatus:green.ok?green.data.status:null,stock:green.ok?green.data.available_quantity:null,
  price:green.ok?green.data.price:null,activation,
  message:active?'Vermelho RN e Verde P vinculados e ativos na mesma família.':
    'Família vinculada; verde ainda não está ativo na plataforma.'};
}

async function linkDuzizoGreenVariant(req:Request,adminId:string,body:any){
 const RED='MLB5529252361', ROOT='16725286274', GREEN='16725286276', SKU='0002',
 FAMILY='3457429658838545', BASEUP='MLBU5797635001';
 if(body.confirmar!==true||body.redItemId!==RED)
  return json(req,{ok:false,message:'Confirmação da família e do anúncio original obrigatória.'},400);
 const row=await connection();
 if(!row)return json(req,{ok:false,message:'Mercado Livre desconectado.'},409);
 let access:string;
 try{access=await usableToken(row);}
 catch{return json(req,{ok:false,message:'OAuth Mercado Livre indisponível.'},503);}
 const [original,owner,prod,variant,stock,local,member]=await Promise.all([
  readMeli('/items/'+RED,access),
  readMeli('/users/me',access),
  db.from('store_products').select('id,bling_id,active,price,images').eq('bling_id',ROOT).maybeSingle(),
  db.from('store_product_variants').select('id,bling_id,product_id,sku,color,size,active,price').eq('bling_id',GREEN).maybeSingle(),
  db.from('store_inventory').select('available_stock,synced_at').eq('bling_product_id',GREEN).eq('deposit_id','__total__').maybeSingle(),
  db.from('store_marketplace_listings').select('id,status,external_listing_id,attributes,last_error,variation_mapping').eq('bling_product_id',ROOT).eq('marketplace','mercado_livre'),
  readMeli('/user-products-families/'+FAMILY+'/user-products',access)
 ]);
 const x=original.ok?original.data:null;
 if(!x||Number(x.seller_id)!==Number(row.seller_id)||x.status!=='active'||x.condition!=='new'||x.category_id!=='MLB28130'||x.user_product_id!==BASEUP)
   return json(req,{ok:false,message:'Anúncio original mudou; vínculo suspenso para preservar a família.'},409);
 if(!owner.ok||Number(owner.data?.id)!==Number(row.seller_id)||owner.data?.site_id!=='MLB'||!owner.data?.tags?.includes('user_product_seller'))
   return json(req,{ok:false,message:'Conta vendedora não validada para User Products.'},409);
 const up=await readMeli('/user-products/'+BASEUP,access);
 if(!up.ok||String(up.data?.family_id)!==FAMILY||x.family_name!=='Conjunto Bebê Duzizo Body Shorts Faixa Canelado')
  return json(req,{ok:false,message:'Família original mudou; nenhum envio realizado.'},409);
 if(!prod.data?.active||!variant.data?.active||variant.data?.product_id!==prod.data?.id||
    variant.data?.sku!==SKU||variant.data?.color!=='Verde'||variant.data?.size!=='P')
  return json(req,{ok:false,message:'SKU verde P não está ativo ou difere do produto no Bling.'},409);
 const quantity=Number(stock.data?.available_stock);
 if(quantity!==3||!stock.data?.synced_at||Date.now()-Date.parse(stock.data.synced_at)>3*86400000)
  return json(req,{ok:false,message:'Saldo verde deve estar sincronizado com 3 unidades no Bling.'},409);
 const price=Number(variant.data?.price||prod.data?.price);
 if(price!==77.9||Number(x.price)!==77.9)
  return json(req,{ok:false,message:'Preço verde difere da proposta aprovada.'},409);
 // Fotos: terceira imagem da galeria cadastrada (verde na visualização do produto).
 const greenImage=(Array.isArray(prod.data?.images)?prod.data.images:[])[2];
 const greenUrl=String(greenImage?.url||greenImage||'');
 const imageId=String(x.pictures?.[2]?.id||'');
 if(!publicPictureUrl(greenUrl)||!/^[-A-Z0-9_]+$/i.test(imageId))
  return json(req,{ok:false,message:'Foto da variação verde ainda não validada na galeria.'},422);
 if(!member.ok||!Array.isArray(member.data?.user_products_ids)||!member.data.user_products_ids.includes(BASEUP))
  return json(req,{ok:false,message:'Lista de membros da família não foi confirmada.'},502);
 const same=(local.data||[]).find((z:any)=>(z.variation_mapping||[]).some((v:any)=>v.blingId===GREEN||v.sku===SKU));
 if(same?.external_listing_id)
  return json(req,{ok:false,alreadyCreated:true,linked:false,status:same.status,externalListingId:same.external_listing_id,localId:same.id,message:'Já existe anúncio verde, mas está em outra família. Não publicar novamente.'},409);
 // Evitar duplicidade no marketplace, inclusive variações da família sem publicação.
 const all=await readMeli('/users/'+row.seller_id+'/items/search?limit=100&offset=0',access);
 if(!all.ok||!Array.isArray(all.data?.results)||Number(all.data?.paging?.total)>100)
  return json(req,{ok:false,message:'Não foi possível excluir duplicidade no Mercado Livre.'},502);
 for(const existing of all.data.results){
  const q=await readMeli('/items/'+encodeURIComponent(String(existing)),access);
  if(!q.ok)return json(req,{ok:false,message:'Consulta de duplicidade incompleta.'},502);
  if(String((q.data?.attributes||[]).find((a:any)=>a.id==='SELLER_SKU')?.value_name||'')===SKU
    &&q.data?.category_id==='MLB28130')
   return json(req,{ok:false,alreadyExists:true,id:q.data?.id,message:'SKU verde já anunciado no marketplace. Vincular manualmente após conferir família.'},409);
 }
 const otherUpIds=member.data.user_products_ids.filter((id:string)=>id!==BASEUP);
 for(const upId of otherUpIds){
  const each=await readMeli('/user-products/'+encodeURIComponent(upId),access);
  if(!each.ok)return json(req,{ok:false,message:'Família não pôde ser conferida por completo.'},502);
  const at=each.data?.attributes||[];
  if(at.some((a:any)=>a.id==='COLOR'&&(a.value_name==='Verde'||a.values?.some((v:any)=>v.name==='Verde')))&&
     at.some((a:any)=>a.id==='SIZE'&&(a.value_name==='P'||a.values?.some((v:any)=>v.name==='P'))))
    return json(req,{ok:false,existingUserProductId:upId,message:'Uma variação verde P já pertence à família. Verifique sua publicação antes de duplicar.'},409);
 }
 if(same&&!(same.status==='error'&&String(same.last_error||'').startsWith('UP_CREATE_ERROR 400')&&!same.attributes?.user_product_id)){
   return json(req,{ok:false,message:'Existe tentativa anterior do verde; confira a família antes de repetir POST.',status:same.status,lastError:same.last_error,localId:same.id},409);
 }
 const fees=await readMeli('/sites/MLB/listing_prices?'+new URLSearchParams({
  price:String(price),category_id:'MLB28130',listing_type_id:'gold_special',
  currency_id:'BRL',shipping_mode:'me2'
 }).toString(),access);
 if(!fees.ok)return json(req,{ok:false,message:'Modalidade Clássico indisponível para o verde.',httpStatus:fees.status},422);
 const description='Conjunto bebê DUZIZO com body, shorts e faixa de cabelo, em ribana canelada estampada. Cor verde, tamanho P. Conteúdo: 1 body, 1 shorts e 1 faixa. Consulte a etiqueta de lavagem.';
 const greenRecord={
  bling_product_id:ROOT,marketplace:'mercado_livre',
  title:'Conjunto Bebê Duzizo Body Shorts Faixa Canelado Verde P',
  description,category_external_id:'MLB28130',listing_type:'marketplace',shipping_mode:'me2',
  price,images:[greenUrl],
  variation_mapping:[{blingId:GREEN,sku:SKU,color:'Verde',size:'P',enabled:true,image:greenUrl}],
  attributes:{BRAND:'DUZIZO',MODEL:'Conjunto Body e Shorts com Faixa',COLOR:'Verde',SIZE:'P',
    GENDER:'Bebês',SELLER_SKU:SKU,ITEM_CONDITION:'Novo',
    family_id:FAMILY,parent_user_product_id:BASEUP},
  status:'blocked',last_error:'green_family_up_create_pending',
  created_by:adminId,updated_by:adminId
 };
 const {data:claim,error:claimError}=same
  ? await db.from('store_marketplace_listings').update({status:'blocked',last_error:'green_family_up_retry_after_400',
      updated_at:new Date().toISOString()}).eq('id',same.id).eq('status','error').select('id').single()
  : await db.from('store_marketplace_listings').insert(greenRecord).select('id').single();
 if(claimError||!claim)return json(req,{ok:false,message:'Falha ao reservar operação da variante verde; nenhum envio externo foi feito.'},503);
 const localId=claim.id;
 const mark=async(attrs:any,last_error:string,extId?:string)=>{
  await db.from('store_marketplace_listings').update({
   attributes:attrs,last_error,...(extId?{external_listing_id:extId}:{})
  }).eq('id',localId);
 };
 // Rota alternativa oficial: POST /items com mesmo family_name e PARENT_PKs.
 // O Mercado Livre atribui o UP e agrupa por family_id. Verificamos esse ID antes de concluir.
 let created:any;
 try{
  const response=await fetch(BASE+'/items',{
   method:'POST',headers:{Authorization:'Bearer '+access,'Content-Type':'application/json',Accept:'application/json'},
   body:JSON.stringify({
    family_name:String(x.family_name),
    category_id:'MLB28130',price,currency_id:'BRL',available_quantity:quantity,
    buying_mode:'buy_it_now',listing_type_id:'gold_special',condition:'new',
    pictures:[{source:greenUrl}],
    shipping:{mode:'me2',free_shipping:false,local_pick_up:false},
    attributes:[
      {id:'BRAND',value_name:'DUZIZO'},
      {id:'MODEL',value_name:'Conjunto Body e Shorts com Faixa'},
      {id:'GENDER',value_id:'371795'},
      {id:'COLOR',value_name:'Verde'},
      {id:'SIZE',value_name:'P'},
      {id:'SELLER_SKU',value_name:'0002'}
    ]
   }),
   signal:AbortSignal.timeout(25000)
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok){
   const detail=String(data?.message||data?.error||'Anúncio recusado').slice(0,220);
   const causes=Array.isArray(data?.cause)?data.cause.slice(0,8).map((v:any)=>({code:v.code,message:v.message})):[];
   await db.from('store_marketplace_listings').update({status:'error',
     last_error:'ITEM_DIRECT_ERROR '+response.status+' '+detail+' '+JSON.stringify(causes).slice(0,1000)}).eq('id',localId);
   return json(req,{ok:false,created:false,stage:'direct_publish',httpStatus:response.status,
     message:detail,causes,localId},422);
  }
  created=data;
 }catch{
  await db.from('store_marketplace_listings').update({last_error:'Criacao direta com resposta incerta; nao repetir POST.'}).eq('id',localId);
  return json(req,{ok:false,uncertain:true,stage:'direct_publish',
   message:'Resposta interrompida após envio. Não repetir automaticamente.',localId},502);
 }
 const newId=String(created?.id||'');
 if(!/^MLB\d{8,16}$/.test(newId))
  return json(req,{ok:false,uncertain:true,message:'Publicação sem código MLB verificável; nenhuma repetição autorizada.',localId},502);
 await db.from('store_marketplace_listings').update({
  external_listing_id:newId,last_error:'Criado; verificando pertencimento à família.'
 }).eq('id',localId);
 const live=await readMeli('/items/'+newId,access);
 const newUp=String(live.ok?live.data?.user_product_id||'':'');
 const greenUP=newUp?await readMeli('/user-products/'+encodeURIComponent(newUp),access):{ok:false,status:0};
 const familyCheck=await readMeli('/user-products-families/'+FAMILY+'/user-products',access);
 const isFamily=greenUP.ok&&String(greenUP.data?.family_id)===FAMILY
   &&familyCheck.ok&&familyCheck.data?.user_products_ids?.includes(newUp);
 if(!isFamily){
  let paused=false;
  if(live.ok){
   try{const pause=await writeMeli('/items/'+newId,access,{status:'paused'});paused=pause.ok;}catch{}
  }
  await db.from('store_marketplace_listings').update({status:'blocked',
    attributes:{...greenRecord.attributes,user_product_id:newUp||null},
    last_error:'Anúncio criado mas família divergente/não verificada;'+(paused?' pausado':' não foi possível pausar')+
      '. Conferir manualmente, sem repetir.'}).eq('id',localId);
  return json(req,{ok:false,created:true,linked:false,externalListingId:newId,
    userProductId:newUp,expectedFamilyId:FAMILY,
    actualFamilyId:greenUP.ok?greenUP.data?.family_id:null,paused,
    message:'Mercado Livre criou item, mas vínculo à família não foi confirmado; não repetir.'},202);
 }
 // Conferir situação comercial e quantidade do verde; preservamos o estoque do vermelho.
 let newItem=live;
 if(live.ok&&Number(live.data?.available_quantity)!==quantity){
  try{await writeMeli('/items/'+newId,access,{available_quantity:quantity});}catch{}
  newItem=await readMeli('/items/'+newId,access);
 }
 const q=newItem.ok?Number(newItem.data?.available_quantity):null;
 let descriptionApplied=false;
 try{
  const d=await writeMeli('/items/'+newId+'/description',access,{plain_text:description},'POST');
  descriptionApplied=d.ok;
 }catch{}
 const verified=newItem.ok&&String(newItem.data?.user_product_id)===newUp
   &&Number(newItem.data?.price)===price&&q===quantity
   &&newItem.data?.category_id==='MLB28130';
 const url=newItem.ok?String(newItem.data?.permalink||''):'';
 const {error:writeErr}=await db.from('store_marketplace_listings').update({
  external_listing_id:newId,external_url:url||null,
  attributes:{...greenRecord.attributes,user_product_id:newUp},
  status:verified?'published':'blocked',
  published_at:verified?new Date().toISOString():null,
  last_error:verified&&newItem.data?.status==='active'?null:
   'Vínculo confirmado; publicação/estoque ainda exige conferência.'
 }).eq('id',localId);
 if(writeErr)return json(req,{ok:false,created:true,linked:true,externalListingId:newId,
   message:'Anúncio vinculado remotamente, mas gestão não salvou o resultado. Não repetir.'},502);
 return json(req,{ok:verified,created:true,linked:true,published:verified,
  active:verified&&newItem.data?.status==='active',externalListingId:newId,
  externalUrl:url,userProductId:newUp,familyId:FAMILY,otherItemId:RED,
  price:newItem.data?.price,stock:q,remoteStatus:newItem.data?.status,
  descriptionApplied,localId,
  message:verified?'Verde P criado dentro da mesma família do Vermelho RN.':
    'Família vinculada, mas estoque ou publicação ainda pendem de verificação.'},verified?200:202);

}



/** Substituição da galeria DUZIZO Vermelho RN pelas QUATRO fotos autorizadas neste chat. */

async function diagnoseRedGalleryImage(req:Request,adminId:string,body:any){
 if(body.confirmar!==true||body.itemId!=='MLB5529252361')
  return json(req,{ok:false,message:'Ação restrita à foto autorizada do conjunto vermelho.'},400);
 const samples=[
  'https://videocdn.pollo.ai/web-cdn/pollo/production/cmp0kq6ey09a745o9i18wq0h2/image/1794162735533-29dd84a7-015a-4ff7-93da-fe79ce8fa56f.png',
  'https://videocdn.pollo.ai/web-cdn/pollo/production/cmp0kq6ey09a745o9i18wq0h2/image/1794162738415-b146dbca-3be4-487c-af02-20dec0d2044a.png'
 ];
 const results=[];
 for(const u of samples){
  try{
   const r=await fetch(u,{headers:{Accept:'image/png'},signal:AbortSignal.timeout(10000)});
   const data=new Uint8Array(await r.arrayBuffer());
   const digest=hex(new Uint8Array(await crypto.subtle.digest('SHA-256',data)));
   results.push({ok:r.ok,status:r.status,mime:r.headers.get('content-type'),length:data.length,
    head:Array.from(data.slice(0,12)),sha256:digest,finalUrl:new URL(r.url).hostname});
  }catch(e){results.push({ok:false,error:String(e).slice(0,130)});}
 }
 return json(req,{ok:true,results});
}


async function diagnoseDuzizoGreenImageFiles(req:Request,adminId:string,body:any){
 if(body.confirmar!==true||body.itemId!=='MLB7960343796')
  return json(req,{ok:false,message:'Operação restrita ao anúncio verde autorizado.'},400);
 const urls=["https://videocdn.pollo.ai/web-cdn/pollo/production/cmp0kq6ey09a745o9i18wq0h2/image/1794163933310-53bada87-2105-47fd-89df-b762d14ccedb.png","https://videocdn.pollo.ai/web-cdn/pollo/production/cmp0kq6ey09a745o9i18wq0h2/image/1794163936304-59a97b38-0f53-4839-bca6-42bcfae2b460.png","https://videocdn.pollo.ai/web-cdn/pollo/production/cmp0kq6ey09a745o9i18wq0h2/image/1794163941476-f26e1cdc-3eed-465f-96d4-4364d7b60e0d.png","https://videocdn.pollo.ai/web-cdn/pollo/production/cmp0kq6ey09a745o9i18wq0h2/image/1794163944602-9875f21c-6bec-468d-aa6d-88ea12426e48.png"];
 const results=[];
 for(let i=0;i<urls.length;i++){
  try{
   const u=new URL(urls[i]);
   if(u.protocol!=='https:'||u.hostname!=='videocdn.pollo.ai')throw Error('Host de arquivo inesperado');
   const resp=await fetch(urls[i],{signal:AbortSignal.timeout(19000)});
   if(!resp.ok)throw Error('HTTP '+resp.status);
   const bytes=new Uint8Array(await resp.arrayBuffer());
   results.push({i:i+1,ok:true,status:resp.status,mime:resp.headers.get('content-type'),
    length:bytes.length,head:Array.from(bytes.slice(0,12)),
    sha256:hex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)))});
  }catch(e){results.push({i:i+1,ok:false,error:String(e).slice(0,170)});}
 }
 return json(req,{ok:results.every(x=>x.ok),results});
}





async function publishRealOgochiGallery(req:Request,adminId:string,body:any){
 if(body.confirmar!==true)return json(req,{ok:false,message:'Autorização explícita obrigatória.'},403);
 const manifest=[
  {id:'MLB5409091633',sku:'004561001-P',original:['874489-MLB119616918783_102026','609036-MLB119616918785_102026','773506-MLB119616918787_102026','952535-MLB119616918789_102026']},
  {id:'MLB7829882028',sku:'004561001-M',original:['774104-MLB117986960436_102026','812800-MLB117986960438_102026','925141-MLB117986960440_102026','722325-MLB117986960442_102026']},
  {id:'MLB5409091635',sku:'004561001-G',original:['753676-MLB119616918791_102026','842274-MLB119616918793_102026','654282-MLB119616918795_102026','814009-MLB119616918797_102026']},
  {id:'MLB5409129769',sku:'004561001-GG',original:['807583-MLB119616918807_102026','995796-MLB119616918809_102026','653568-MLB119616918811_102026','746553-MLB119616918813_102026']},
  {id:'MLB5409091637',sku:'004561001-XG',original:['734267-MLB119616918799_102026','857072-MLB119616918801_102026','799178-MLB119616918803_102026','881652-MLB119616918805_102026']}
 ];
 const names=['01_capa_produto','02_modelo_caimento','03_frente_detalhada','04_costas_modelo',
  '05_cintura_elastica','06_bolso_lateral','07_tecido_e_bainha'];
 const prefix=APP+'/storage/v1/object/public/anarosa-product-images/mercado-livre/ogochi-004561001/galeria-real-20261108-v1/';
 const urls=names.map((n,i)=>prefix+String(i+1).padStart(2,'0')+'-'+n+'.jpg');
 const seller=await connection();
 if(!seller)return json(req,{ok:false,message:'Mercado Livre não está conectado.'},409);
 const token=await usableToken(seller);
 const category=await readMeli('/categories/MLB188064',token);
 if(!category.ok||category.data?.settings?.listing_allowed!==true)
  return json(req,{ok:false,message:'Categoria do anúncio indisponível.'},422);
 const maxPictures=Number(category.data?.settings?.max_pictures_per_item||12);
 if(maxPictures<7)return json(req,{ok:false,message:'A categoria permite menos de sete imagens.',maxPictures},422);
 const assets=[];
 for(let i=0;i<urls.length;i++){
  const res=await fetch(urls[i],{signal:AbortSignal.timeout(15000)});
  if(!res.ok||!String(res.headers.get('content-type')||'').includes('image/jpeg')){
   return json(req,{ok:false,message:'Nova foto não disponível para o marketplace',number:i+1,status:res.status},422);
  }
  const bytes=new Uint8Array(await res.arrayBuffer());
  if(bytes.length<25000||bytes.length>3000000||bytes[0]!==255||bytes[1]!==216)
   return json(req,{ok:false,message:'Foto fora do padrão de formato e tamanho.',number:i+1},422);
  assets.push({number:i+1,bytes:bytes.length});
 }
 const targets:any[]=[];
 for(const entry of manifest){
  const data=await readMeli('/items/'+entry.id,token);
  if(!data.ok)return json(req,{ok:false,message:'Não foi possível confirmar um dos anúncios.',id:entry.id},502);
  const item=data.data;
  const sku=String((item.attributes||[]).find((x:any)=>x.id==='SELLER_SKU')?.value_name||'');
  const current=(item.pictures||[]).map((x:any)=>String(x.id||''));
  if(Number(item.seller_id)!==Number(seller.seller_id)||item.category_id!=='MLB188064'||
     sku!==entry.sku||Number(item.price)!==81.9||Number(item.available_quantity)!==2)
   return json(req,{ok:false,message:'Produto, vendedor, preço ou estoque divergentes; nenhuma publicação iniciada.',id:entry.id,
    sku,price:item.price,stock:item.available_quantity,category:item.category_id},409);
  const isOriginal=current.length===4&&current.every((v:string,i:number)=>v===entry.original[i]);
  const isAlreadyUpdated=current.length===7&&current.every((v:string)=>!entry.original.includes(v));
  if(!isOriginal&&!isAlreadyUpdated)
   return json(req,{ok:false,message:'Uma galeria foi alterada por outro processo; nenhuma nova operação iniciada.',id:entry.id,current},409);
  if(!['active','paused'].includes(String(item.status)))
   return json(req,{ok:false,message:'Anúncio não está em estado seguro para imagens.',id:entry.id,status:item.status},409);
  targets.push({id:entry.id,sku:entry.sku,original:entry.original,status:item.status,
    price:item.price,stock:item.available_quantity,alreadyUpdated:isAlreadyUpdated});
 }
 if(body.dryRun===true){
  return json(req,{ok:true,dryRun:true,categoryMax:maxPictures,validatedPhotos:assets,
   targets:targets.map(({id,sku,status,alreadyUpdated})=>({id,sku,status,alreadyUpdated})),
   message:'Pré-validação concluída. Nenhuma foto publicada.'});
 }
 const {data:limit,error:rateError}=await db.rpc('rl_check_and_increment',{
  p_bucket:'meli-ogochi-replace-photos:'+adminId,p_limit:2,p_window_seconds:3600});
 if(rateError||limit!==true)return json(req,{ok:false,message:'Limite de segurança para alterações atingido.'},429);
 const result:any[]=[];
 for(const t of targets){
  if(t.alreadyUpdated){
   result.push({id:t.id,sku:t.sku,success:true,alreadyUpdated:true,photos:7});
   continue;
  }
  let response:Response,value:any;
  try{
   response=await fetch(BASE+'/items/'+t.id,{
     method:'PUT',
     headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json'},
     body:JSON.stringify({pictures:urls.map(url=>({source:url}))}),
     signal:AbortSignal.timeout(25000)
   });
   value=await response.json().catch(()=>({}));
  }catch{
   result.push({id:t.id,success:false,uncertain:true,message:'Resposta interrompida após envio; não repetir POST/PUT sem reconciliar.'});
   break;
  }
  if(!response.ok){
   result.push({id:t.id,success:false,httpStatus:response.status,
     message:String(value?.message||value?.error||'Atualização rejeitada').slice(0,300),
     causes:Array.isArray(value.cause)?value.cause.slice(0,8).map((v:any)=>({code:v.code,message:v.message})):[]});
   break;
  }
  let verified:any;
  try{verified=await readMeli('/items/'+t.id,token);}
  catch{verified={ok:false};}
  const picIDs=verified.ok?(verified.data?.pictures||[]).map((v:any)=>String(v.id||'')):[];
  const oldRemoved=picIDs.length===7&&picIDs.every((id:string)=>!t.original.includes(id));
  const stable=verified.ok&&Number(verified.data?.price)===Number(t.price)
    &&Number(verified.data?.available_quantity)===Number(t.stock);
  const ok=oldRemoved&&stable;
  result.push({id:t.id,sku:t.sku,success:ok,accepted:true,status:verified.ok?verified.data?.status:null,
    oldRemoved,price:verified.ok?verified.data?.price:null,stock:verified.ok?verified.data?.available_quantity:null,
    pictures:picIDs,verificationPending:!ok});
  if(!ok)break;
 }
 const complete=result.length===5&&result.every((x:any)=>x.success);
 return json(req,{ok:complete,allUpdated:complete,results:result,validatedPhotos:assets,
  message:complete?'Sete fotos novas cadastradas e imagens antigas removidas dos cinco anúncios.':
   'Atualização parcial ou recusada: conferir resultado antes de qualquer nova tentativa.'},200);
}

async function prepareRealOgochiGallery(req:Request,adminId:string,body:any){
 if(body.confirmar!==true)return json(req,{ok:false,message:'Confirmação exigida.'},403);
 const seller=await connection();
 if(!seller)return json(req,{ok:false,message:'Mercado Livre desconectado.'},409);
 const token=await usableToken(seller);
 const item=await readMeli('/items/MLB5409091633',token);
 if(!item.ok||Number(item.data?.seller_id)!==Number(seller.seller_id)||
  item.data?.status!=='active'||item.data?.category_id!=='MLB188064')
  return json(req,{ok:false,message:'Produto e anúncio real não foram validados.'},409);
 const expected=['874489-MLB119616918783_102026','609036-MLB119616918785_102026',
   '773506-MLB119616918787_102026','952535-MLB119616918789_102026'];
 const pics=item.data?.pictures||[];
 if(pics.length!==4||!pics.every((v:any,i:number)=>v.id===expected[i]))
  return json(req,{ok:false,message:'Galeria original mudou. Revisão obrigatória antes de gerar.'},409);
 const {Image}=await import('https://deno.land/x/imagescript@1.3.0/mod.ts');
 const decoded:any[]=[];
 for(let i=0;i<4;i++){
  const pic=pics[i];
  const url=String(pic.secure_url||pic.url||'').replace(/^http:\/\//,'https://').replace(/-O\.(jpg|webp)$/i,'-F.$1');
  if(!url.startsWith('https://http2.mlstatic.com/'))return json(req,{ok:false,message:'Origem de foto insegura.'},422);
  const res=await fetch(url,{signal:AbortSignal.timeout(16000)});
  if(!res.ok)return json(req,{ok:false,message:'Não foi possível recuperar foto original '+(i+1),status:res.status},502);
  const buf=new Uint8Array(await res.arrayBuffer());
  if(buf.length<15000||buf.length>3*1024*1024||buf[0]!==255||buf[1]!==216)
   return json(req,{ok:false,message:'Arquivo original não parece JPG válido.'},422);
  decoded.push(await Image.decode(buf));
 }
 const compositions=[
  {key:'01_capa_produto',origin:2,mode:'contain',box:[0,0,0,0]},
  {key:'02_modelo_caimento',origin:3,mode:'crop',box:[15,370,565,565]},
  {key:'03_frente_detalhada',origin:2,mode:'crop',box:[85,0,1000,1000]},
  {key:'04_costas_modelo',origin:0,mode:'crop',box:[10,115,580,580]},
  {key:'05_cintura_elastica',origin:2,mode:'crop',box:[245,0,700,700]},
  {key:'06_bolso_lateral',origin:2,mode:'crop',box:[45,75,710,710]},
  {key:'07_tecido_e_bainha',origin:2,mode:'crop',box:[520,345,660,660]}
 ];
 const storage=db.storage.from('anarosa-product-images');
 const prefix='mercado-livre/ogochi-004561001/galeria-real-20261108-v1/';
 const out:any[]=[];
 for(let i=0;i<compositions.length;i++){
  const spec=compositions[i];
  const source=decoded[spec.origin].clone();
  let photo:any;
  if(spec.mode==='contain'){
   source.contain(1140,1140);
   const canvas=new Image(1200,1200).fill(0xffffffff);
   canvas.composite(source,Math.floor((1200-source.width)/2),Math.floor((1200-source.height)/2));
   photo=canvas;
  }else{
   const [cx,cy,cw,ch]=spec.box;
   const side=Math.min(cw,ch,source.width,source.height);
   if(side<300)return json(req,{ok:false,message:'Fonte insuficiente para detalhe de qualidade',i:i+1,original:[source.width,source.height]},422);
   const left=Math.max(0,Math.min(cx,source.width-side));
   const top=Math.max(0,Math.min(cy,source.height-side));
   photo=source.crop(left,top,side,side).resize(1200,1200);
  }
  const encoded=await photo.encodeJPEG(92);
  if(encoded.length>3*1024*1024||encoded.length<25000)
   return json(req,{ok:false,message:'Tamanho inadequado para foto '+(i+1),size:encoded.length},422);
  const path=prefix+String(i+1).padStart(2,'0')+'-'+spec.key+'.jpg';
  const {error:uploadErr}=await storage.upload(path,encoded,{contentType:'image/jpeg',cacheControl:'31536000',upsert:false});
  if(uploadErr&&!/already exists|duplicate|resource already exists/i.test(String(uploadErr.message||'')))
   return json(req,{ok:false,message:'Falha ao salvar foto '+(i+1),error:String(uploadErr.message||'').slice(0,200),uploaded:out},502);
  const uri=APP+'/storage/v1/object/public/anarosa-product-images/'+path;
  const test=await fetch(uri,{signal:AbortSignal.timeout(16000)});
  if(!test.ok||!String(test.headers.get('content-type')||'').includes('image/'))
   return json(req,{ok:false,message:'Imagem não acessível ao marketplace.',photo:i+1,url:uri,httpStatus:test.status},502);
  out.push({sequence:i+1,name:spec.key,url:uri,bytes:encoded.length,originPhotoIndex:spec.origin+1,created:!uploadErr});
 }
 return json(req,{ok:true,ready:true,photos:out,source:'four authentic Ogochi listing photos',
   note:'Sem desenho artificial de cordão ou bolso traseiro: imagens derivadas exclusivamente de fotografias reais.'});
}

async function probeOgochiTransform(req:Request,adminId:string,body:any){
 if(body.confirmar!==true)return json(req,{ok:false,message:'Acesso negado'},403);
 const row=await connection();
 if(!row)return json(req,{ok:false,message:'Sem conexão'},409);
 const token=await usableToken(row);
 const current=await readMeli('/items/MLB5409091633',token);
 if(!current.ok||Number(current.data?.seller_id)!==Number(row.seller_id))
  return json(req,{ok:false,message:'Sem anúncio autorizado'},409);
 const picture=current.data?.pictures?.[2];
 if(!picture)return json(req,{ok:false,message:'Foto real não encontrada'},404);
 const url=String(picture.secure_url||picture.url||'').replace(/^http:\/\//,'https://').replace(/-O\.(jpg|webp)$/i,'-F.$1');
 if(!url.startsWith('https://http2.mlstatic.com/'))return json(req,{ok:false,message:'Host de origem inválido'},422);
 const remote=await fetch(url,{signal:AbortSignal.timeout(15000)});
 if(!remote.ok)return json(req,{ok:false,message:'Foto não acessível',status:remote.status},502);
 let image:any;
 try{
  const {Image}=await import('https://deno.land/x/imagescript@1.3.0/mod.ts');
  image=await Image.decode(new Uint8Array(await remote.arrayBuffer()));
  const original={width:image.width,height:image.height};
  const w=Math.min(700,image.width),h=Math.min(700,image.height);
  const cut=image.crop(Math.floor((image.width-w)/2),0,w,h);
  cut.resize(1000,1000);
  const jpeg=await cut.encodeJPEG(85);
  const white=new Image(1200,1200).fill(0xffffffff);
  image.resize(1140,Image.RESIZE_AUTO);
  white.composite(image,Math.floor((1200-image.width)/2),Math.floor((1200-image.height)/2));
  const enc=await white.encodeJPEG(90);
  return json(req,{ok:true,original,processed:{width:cut.width,height:cut.height,bytes:jpeg.length,first:hex(jpeg.slice(0,8))},canvas:{width:white.width,height:white.height,bytes:enc.length,head:hex(enc.slice(0,8))}});
 }catch(e){return json(req,{ok:false,message:'Image processor failed',error:String(e).slice(0,400)},200);}
}


async function diagnoseOgochiUserProducts(req:Request,adminId:string,body:any){
 if(body.confirmar!==true)return json(req,{ok:false,message:'Confirmação obrigatória.'},403);
 const account=await connection();
 if(!account)return json(req,{ok:false,message:'Mercado Livre desconectado.'},409);
 const access=await usableToken(account);
 const ids=['MLB5409091633','MLB7829882028','MLB5409091635','MLB5409129769','MLB5409091637'];
 const data=await Promise.all(ids.map(id=>readMeli('/items/'+id,access)));
 if(data.some(x=>!x.ok))return json(req,{ok:false,message:'Não foi possível ler todos os anúncios.',statuses:data.map(x=>x.ok?200:x.status)},502);
 const items=data.map((x,i)=>{
  const a=x.data;
  return {itemId:ids[i],status:a.status,sellerId:a.seller_id,userProductId:a.user_product_id,
   familyName:a.family_name,thumbnail:a.thumbnail,pictureCount:a.pictures?.length,
   pictures:(a.pictures||[]).map((p:any)=>({id:p.id,url:p.secure_url||p.url})),
   variations:a.variations,attributes:(a.attributes||[]).filter((y:any)=>['SIZE','COLOR','BRAND','MODEL','SELLER_SKU'].includes(y.id))
    .map((y:any)=>({id:y.id,value_name:y.value_name,value_id:y.value_id}))}
 });
 if(items.some(x=>Number(x.sellerId)!==Number(account.seller_id)))
   return json(req,{ok:false,message:'Anúncios não pertencem à mesma conta.'},403);
 const ups:any[]=[];
 for(const id of [...new Set(items.map(x=>x.userProductId))]){
  const x=await readMeli('/user-products/'+encodeURIComponent(String(id)),access);
  ups.push({upId:id,status:x.ok?200:x.status,...(x.ok?{
   familyId:x.data.family_id,images:x.data.pictures||x.data.images,
   thumbnail:x.data.thumbnail,
   attrs:x.data.attributes,
   name:x.data.name,family_name:x.data.family_name,
   variations:x.data.variations
  }:{})});
 }
 const families:any[]=[];
 for(const familyId of [...new Set(ups.map(x=>x.familyId).filter(Boolean))]){
  const [f,m]=await Promise.all([
   readMeli('/user-products-families/'+encodeURIComponent(String(familyId)),access),
   readMeli('/user-products-families/'+encodeURIComponent(String(familyId))+'/user-products',access)
  ]);
  families.push({familyId,structureStatus:f.ok?200:f.status,membersStatus:m.ok?200:m.status,
   structure:f.ok?{family_name:f.data.family_name,domain_id:f.data.domain_id,
    attributes:f.data.attributes,child_attributes_ids:f.data.child_attributes_ids,
    pictures:f.data.pictures||f.data.images,thumbnail:f.data.thumbnail}:null,
   user_product_ids:m.ok?m.data?.user_products_ids:null
  });
 }
 return json(req,{ok:true,items,ups,families});
}


async function auditAnarosaSalesGrowth(req:Request,adminId:string,body:any){
 if(body.confirmar!==true)return json(req,{ok:false,message:'Autorização administrativa obrigatória.'},403);
 const seller=await connection();
 if(!seller)return json(req,{ok:false,message:'Mercado Livre desconectado.'},409);
 const access=await usableToken(seller);
 const ids=['MLB5529252361','MLB7960343796','MLB5409091633','MLB7829882028','MLB5409091635','MLB5409129769','MLB5409091637'];
 const today=new Date().toISOString().slice(0,10);
 const from=new Date(Date.now()-7*86400000).toISOString().slice(0,10);
 const from30=new Date(Date.now()-30*86400000).toISOString().slice(0,10);
 const safe=async(path:string)=>{
  try{const r=await readMeli(path,access);return {status:r.ok?200:r.status,data:r.ok?r.data:undefined};}
  catch(e){return {status:0,error:String(e).slice(0,180)};}
 };
 const [account,ads,allTime,visits7,visits30,listingRows,promoRows]=await Promise.all([
  safe('/users/'+seller.seller_id),
  (async()=>{
   try{const response=await fetch(BASE+'/advertising/advertisers?product_id=PADS',{
     headers:{Authorization:'Bearer '+access,Accept:'application/json','Api-Version':'1'},
     signal:AbortSignal.timeout(16000)});
     const data=await response.json().catch(()=>({}));
     return {status:response.status,advertisers:Array.isArray(data.advertisers)?
      data.advertisers.map((a:any)=>({id:a.advertiser_id,site:a.site_id,name:a.advertiser_name})):undefined,
      code:data.error||data.message||undefined};
   }catch(e){return {status:0,error:String(e).slice(0,160)};}
  })(),
  Promise.all(ids.map(id=>safe('/visits/items?ids='+id))),
  Promise.all(ids.map(id=>safe('/items/visits?ids='+id+'&date_from='+from+'&date_to='+today))),
  Promise.all(ids.map(id=>safe('/items/visits?ids='+id+'&date_from='+from30+'&date_to='+today))),
  Promise.all(ids.map(id=>safe('/items/'+id))),
  Promise.all(ids.map(id=>safe('/seller-promotions/items/'+id+'?app_version=v2')))
 ]);
 const result=ids.map((id,i)=>{
   const one=listingRows[i];
   const obj:any={id};
   if(one.status===200){
      const x=one.data;
      if(Number(x.seller_id)!==Number(seller.seller_id)){obj.error='seller_mismatch';return obj;}
      obj.status=x.status;obj.createdAt=x.date_created;obj.price=x.price;obj.stock=x.available_quantity;
      obj.soldQuantity=x.sold_quantity;obj.listingType=x.listing_type_id;obj.shippingFree=x.shipping?.free_shipping;
      obj.pictures=(x.pictures||[]).length;
   }else obj.listingStatus=one.status;
   const v7=visits7[i],v30=visits30[i];
   const data7=Array.isArray(v7.data)?v7.data[0]:v7.data;
   const data30=Array.isArray(v30.data)?v30.data[0]:v30.data;
   obj.visits7=v7.status===200&&data7?.total_visits!==undefined?Number(data7.total_visits):null;
   obj.visits30=v30.status===200&&data30?.total_visits!==undefined?Number(data30.total_visits):null;
   if(i<2){obj.visits7Structure=JSON.stringify(v7.data).slice(0,1700);}
   obj.visits7Status=v7.status;obj.visits30Status=v30.status;
   const d=allTime[i]?.status===200?allTime[i]?.data:null;
   obj.visitsAllTime=d&&d[id]!==undefined?Number(d[id]):null;
   obj.visitsAllStatus=allTime[i]?.status;
   const promo=promoRows[i];
   obj.promoStatus=promo.status;
   obj.promos=promo.status===200?(Array.isArray(promo.data)?promo.data.slice(0,15).map((x:any)=>({
      type:x.type,status:x.status,originalPrice:x.original_price,
      price:x.price,minPrice:x.min_discounted_price,
      maxPrice:x.max_discounted_price,suggestedPrice:x.suggested_discounted_price,
      meliPercentage:x.meli_percentage,sellerPercentage:x.seller_percentage,
      promoName:x.name,code:x.id
   })):[]):[];
   return obj;
 });
 const rep=account.status===200?account.data?.seller_reputation:null;
 const sellerInfo={userStatus:account.status,
   registrationDate:account.status===200?account.data.registration_date:null,
   status:account.status===200?account.data.status?.site_status:null,
   sellerReputation:rep?{levelId:rep.level_id,transactions:rep.transactions?.total,
       completed:rep.transactions?.completed,rating:rep.transactions?.ratings,
       powerSellerStatus:rep.power_seller_status}:null,
   sales:account.status===200?account.data?.seller_experience:null
 };
 return json(req,{ok:true,checkedAt:new Date().toISOString(),from,from30,to:today,
   sellerNickname:seller.seller_nickname,
   seller:sellerInfo,productAds:ads,visitsTotalStatus:allTime.map(x=>x.status),items:result});
}

async function probeOgochiGallery(req:Request,adminId:string,body:any){
 if(body.confirmar!==true)return json(req,{ok:false,message:'Autorização de verificação obrigatória.'},403);
 if(body.previewProcessed===true){
  const names=['01_capa_produto','02_modelo_caimento','03_frente_detalhada','04_costas_modelo',
    '05_cintura_elastica','06_bolso_lateral','07_tecido_e_bainha'];
  const index=Number(body.imageIndex||0);
  if(!Number.isInteger(index)||index<1||index>7)return json(req,{ok:false,message:'Índice de foto inválido.'},422);
  const path='mercado-livre/ogochi-004561001/galeria-real-20261108-v1/'+String(index).padStart(2,'0')+'-'+names[index-1]+'.jpg';
  const {data,error}=await db.storage.from('anarosa-product-images').download(path);
  if(error||!data)return json(req,{ok:false,message:'Foto preparada não encontrada.'},404);
  const bytes=new Uint8Array(await data.arrayBuffer());
  let b='';
  for(let i=0;i<bytes.length;i+=8192)b+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return json(req,{ok:true,previewProcessed:true,index,name:names[index-1],bytes:bytes.length,
    base64:btoa(b)});
 }

 const seller=await connection();
 if(!seller)return json(req,{ok:false,message:'Mercado Livre desconectado.'},409);
 const access=await usableToken(seller);
 const safeItems=['MLB5409091633','MLB7829882028','MLB5409091635','MLB5409129769','MLB5409091637'];
 const itemId=String(body.itemId||'MLB5409091633');
 if(!safeItems.includes(itemId))return json(req,{ok:false,message:'Anúncio fora da família Ogochi.'},400);
 const item=await readMeli('/items/'+itemId,access);
 if(!item.ok||Number(item.data?.seller_id)!==Number(seller.seller_id)||item.data?.status!=='active')
  return json(req,{ok:false,message:'Anúncio Ogochi não confirmado na conta.'},409);
 const pictures=item.data?.pictures||[];
 const data=[];
 for(let i=0;i<pictures.length;i++){
  if(Number(body.imageIndex||0)>0&&i!==Number(body.imageIndex)-1)continue;
  const pic=pictures[i];
  const u=String(pic.secure_url||pic.url||'').replace(/^http:\/\//,'https://');
  if(!u.startsWith('https://http2.mlstatic.com/')){
    data.push({order:i+1,id:pic.id,error:'Original picture URL not on expected host.'});
    continue;
  }
  const full=u.replace(/-O\.(jpg|webp)$/i,'-F.$1');
  let result:any;
  try{
   const resp=await fetch(full,{signal:AbortSignal.timeout(16000)});
   const bytes=resp.ok?new Uint8Array(await resp.arrayBuffer()):new Uint8Array();
   result={source:'F',status:resp.status,mime:resp.headers.get('content-type'),
     byteLength:bytes.byteLength,first:hex(bytes.slice(0,12))};
   if(body.checkThumbnail===true){
    const tests:any[]=[];
    for(const suffix of ['I','V','N']){
      const uri=u.replace(/-O\.(jpg|webp)$/i,'-'+suffix+'.$1');
      try{
        const rr=await fetch(uri,{signal:AbortSignal.timeout(16000)});
        const bs=rr.ok?new Uint8Array(await rr.arrayBuffer()):new Uint8Array();
        tests.push({variant:suffix,status:rr.status,mime:rr.headers.get('content-type'),
         length:bs.length,magic:hex(bs.slice(0,8)),cacheControl:rr.headers.get('cache-control')});
      }catch(e){tests.push({variant:suffix,error:String(e).slice(0,130)});}
    }
    result.thumbnails=tests;
   }
   if(body.checkOriginal===true){
    try{
     const ro=await fetch(u,{headers:{'accept':'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'},signal:AbortSignal.timeout(16000)});
     const ob=ro.ok?new Uint8Array(await ro.arrayBuffer()):new Uint8Array();
     result.original={status:ro.status,contentType:ro.headers.get('content-type'),
       byteLength:ob.length,first:hex(ob.slice(0,12))};
    }catch(e){result.original={error:String(e).slice(0,150)};}
   }
   if(!resp.ok){
    const rr=await fetch(u,{signal:AbortSignal.timeout(16000)});
    const b=rr.ok?new Uint8Array(await rr.arrayBuffer()):new Uint8Array();
    result={source:'O',status:rr.status,mime:rr.headers.get('content-type'),
       byteLength:b.byteLength,first:hex(b.slice(0,12))};
   }
  }catch(e){result={error:String(e).slice(0,120)};}
  if(body.includeImage===true){
   try{
    const allowedVariant=['F','I','O','V','N'].includes(String(body.imageVariant||'F'))?String(body.imageVariant||'F'):'F';
    const rr=await fetch(String(pic.secure_url||pic.url||'').replace(/^http:\/\//,'https://').replace(/-O\.(jpg|webp)$/i,'-'+allowedVariant+'.$1'),{signal:AbortSignal.timeout(16000)});
    if(rr.ok){const b=new Uint8Array(await rr.arrayBuffer());let binary='';
      for(let i=0;i<b.length;i+=8192)binary+=String.fromCharCode(...b.subarray(i,i+8192));
      result.base64=btoa(binary);
    }
   }catch{}
  }
  data.push({order:i+1,id:pic.id,...result});
 }
 return json(req,{ok:true,id:item.data.id,images:data});
}

async function replaceDuzizoGreenGallery(req:Request,adminId:string,body:any){
 const ITEM='MLB7960343796',PRODUCT='16725286274',SKU='0002',
 OLD='892902-MLB121074284583_112026';
 if(body.confirmar!==true||body.itemId!==ITEM){
   return json(req,{ok:false,message:'Confirme o anúncio verde DUZIZO e o pedido de substituição das quatro fotos.'},400);
 }
 const {data:allowed,error:rlErr}=await db.rpc('rl_check_and_increment',{
   p_bucket:'meli-replace-duzizo-green-20261108:'+adminId,p_limit:3,p_window_seconds:3600});
 if(rlErr||allowed!==true)return json(req,{ok:false,message:'Limite de segurança atingido.'},429);
 const [local,connected]=await Promise.all([
   db.from('store_marketplace_listings').select('id,status,bling_product_id,images,external_listing_id,price,last_error')
      .eq('external_listing_id',ITEM).eq('marketplace','mercado_livre').maybeSingle(),
   connection()
 ]);
 if(local.error||!local.data||local.data.bling_product_id!==PRODUCT||local.data.status!=='published')
   return json(req,{ok:false,message:'Vínculo do anúncio verde com o Bling não confirmado.'},409);
 if(!connected)return json(req,{ok:false,message:'Conexão Mercado Livre indisponível.'},503);
 let access:string;
 try{access=await usableToken(connected);}catch{return json(req,{ok:false,message:'Sessão do Mercado Livre precisa ser renovada.'},503);}
 const current=await readMeli('/items/'+ITEM,access);
 if(!current.ok)return json(req,{ok:false,message:'Não foi possível consultar o anúncio antes da edição.'},502);
 const it=current.data;
 const sku=String((it.attributes||[]).find((a:any)=>a.id==='SELLER_SKU')?.value_name||'');
 const cor=String((it.attributes||[]).find((a:any)=>a.id==='COLOR')?.value_name||'');
 if(it.status!=='active'||Number(it.seller_id)!==Number(connected.seller_id)||
    sku!==SKU||cor!=='Verde'||it.condition!=='new'||it.category_id!=='MLB28130'||
    Number(it.price)!==77.9||Number(it.available_quantity)!==3||it.shipping?.mode!=='me2')
   return json(req,{ok:false,message:'O anúncio alterou estado, cor, estoque, preço ou vendedor. Alteração cancelada.'},409);
 const originals=Array.isArray(it.pictures)?it.pictures.map((v:any)=>String(v.id||'')):[];
 if(originals.length!==1||originals[0]!==OLD)
   return json(req,{ok:false,message:'A galeria atual já mudou. Não substituir fotos desconhecidas.',pictures:originals},409);
 const files=[
  {
    "name": "1000207952.png",
    "role": "capa",
    "url": "https://videocdn.pollo.ai/web-cdn/pollo/production/cmp0kq6ey09a745o9i18wq0h2/image/1794163933310-53bada87-2105-47fd-89df-b762d14ccedb.png",
    "sha": "15c2bb5cc07ae5e3e2a7de5eb7ae34be001867e7b7c7e4022c6292d0e2744787"
  },
  {
    "name": "1000207953.png",
    "role": "bebe",
    "url": "https://videocdn.pollo.ai/web-cdn/pollo/production/cmp0kq6ey09a745o9i18wq0h2/image/1794163936304-59a97b38-0f53-4839-bca6-42bcfae2b460.png",
    "sha": "94dd943bd109e2f8165d5c3fadc864b9974c721c21a7ca2d14c937bcdfd0fdfc"
  },
  {
    "name": "1000207955.png",
    "role": "detalhes",
    "url": "https://videocdn.pollo.ai/web-cdn/pollo/production/cmp0kq6ey09a745o9i18wq0h2/image/1794163941476-f26e1cdc-3eed-465f-96d4-4364d7b60e0d.png",
    "sha": "4483a1b6e806beda777d58d84061d0c2986daf0176f588cac605d8c3e0c767e2"
  },
  {
    "name": "1000207954.png",
    "role": "ambientada",
    "url": "https://videocdn.pollo.ai/web-cdn/pollo/production/cmp0kq6ey09a745o9i18wq0h2/image/1794163944602-9875f21c-6bec-468d-aa6d-88ea12426e48.png",
    "sha": "9c9c5c76ad43242d5a3d4c24e084f773872bf40a5cdc2b1ba05254778f78ea9d"
  }
];
 const bucket='anarosa-product-images';
 const parent='c118f1e5-21c8-48ca-9ab6-cbd50539d0ec';
 const publicUrls:string[]=[];
 // Cada arquivo é conferido byte a byte contra a foto que o administrador enviou.
 for(const f of files){
   let buf:Uint8Array;
   try{
     const u=new URL(f.url);
     if(u.protocol!=='https:'||u.hostname!=='videocdn.pollo.ai')
       return json(req,{ok:false,message:'Origem de foto inesperada.'},422);
     const fetched=await fetch(f.url,{signal:AbortSignal.timeout(20000)});
     if(!fetched.ok)return json(req,{ok:false,message:'Não foi possível obter a foto '+f.name,httpStatus:fetched.status},502);
     buf=new Uint8Array(await fetched.arrayBuffer());
   }catch{return json(req,{ok:false,message:'Falha ao baixar uma foto. Não houve edição do anúncio.',filename:f.name},502);}
   if(buf.byteLength<30000||buf.byteLength>3000000||
      buf[0]!==255||buf[1]!==216||buf[2]!==255)
     return json(req,{ok:false,message:'Arquivo inválido ou acima do limite.',filename:f.name},422);
   const digest=hex(new Uint8Array(await crypto.subtle.digest('SHA-256',buf)));
   if(digest!==f.sha)return json(req,{ok:false,message:'Arquivo diferente da foto aprovada. Envio interrompido.',filename:f.name},409);
   const path=parent+'/mlb7960343796/2026-11-08-'+f.name.replace(/\.png$/i,'.jpg');
   const {error:uploadErr}=await db.storage.from(bucket).upload(path,buf,{
     contentType:'image/jpeg',cacheControl:'3600',upsert:false
   });
   if(uploadErr){
     // Se já foi importado, confere o checksum do arquivo existente (sem sobrescrever).
     const {data:present,error:downloadErr}=await db.storage.from(bucket).download(path);
     if(downloadErr||!present)return json(req,{ok:false,message:'Não foi possível guardar a foto no Storage.',filename:f.name,detail:String(uploadErr.message||'').slice(0,140)},502);
     const oldBytes=new Uint8Array(await present.arrayBuffer());
     const storedDigest=hex(new Uint8Array(await crypto.subtle.digest('SHA-256',oldBytes)));
     if(storedDigest!==f.sha)return json(req,{ok:false,message:'Conflito no nome da foto armazenada.',filename:f.name},409);
   }
   const url=db.storage.from(bucket).getPublicUrl(path).data.publicUrl;
   const check=await fetch(url,{method:'HEAD',signal:AbortSignal.timeout(12000)}).catch(()=>null);
   if(!check?.ok)return json(req,{ok:false,message:'Foto armazenada, mas não acessível publicamente.',filename:f.name},502);
   publicUrls.push(url);
 }
 // O PUT substitui TODA a galeria; a ID da foto antiga não é incluída.
 let update:any;
 try{update=await writeMeli('/items/'+ITEM,access,{pictures:publicUrls.map(source=>({source}))});}
 catch{return json(req,{ok:false,uncertain:true,message:'O Mercado Livre não retornou confirmação. Fotos foram importadas no Storage; verificar a galeria antes de repetir.',publicUrls},502);}
 if(!update.ok)return json(req,{ok:false,stage:'mercado_livre',message:'Fotos importadas na ANAROSA, mas Mercado Livre recusou substituir a galeria.',details:update,publicUrls},422);
 let check=await readMeli('/items/'+ITEM,access).catch(()=>({ok:false}));
 const photos=check.ok&&Array.isArray(check.data?.pictures)?check.data.pictures:[];
 const oldGone=!photos.some((p:any)=>p.id===OLD);
 const correct=check.ok&&photos.length===4&&oldGone;
 const safe=check.ok&&Number(check.data.price)===77.9&&Number(check.data.available_quantity)===3&&
   check.data.shipping?.mode==='me2'&&check.data.listing_type_id===it.listing_type_id;
 if(!safe)return json(req,{ok:false,remoteAccepted:true,uncertain:true,message:'A edição foi aceita, mas a validação dos dados comerciais falhou. Confira o anúncio.',pictureCount:photos.length,oldGone},202);
 // Depois da aceitação do Mercado Livre, sincroniza a Gestão ANAROSA.
 const {error:synced}=await db.from('store_marketplace_listings').update({
   images:publicUrls,updated_at:new Date().toISOString(),
   last_error:correct?null:'Novas fotos enviadas; aguardando processamento ou conferência pelo Mercado Livre.'
 }).eq('id',local.data.id).eq('external_listing_id',ITEM).eq('status','published');
 if(synced)return json(req,{ok:false,remoteAccepted:true,message:'Galeria editada externamente, mas falhou sincronização com a Gestão ANAROSA.',pictureCount:photos.length},502);
 return json(req,{ok:correct,remoteAccepted:true,updatedInManagement:true,
   itemId:ITEM,pictureCount:photos.length,oldRemoved:oldGone,
   status:check.data.status,price:check.data.price,stock:check.data.available_quantity,
   listingType:check.data.listing_type_id,shipping:check.data.shipping?.mode,
   pictures:photos.map((v:any)=>({id:v.id,url:v.secure_url||v.url})),
   pending:!correct,message:correct?'Quatro fotos novas confirmadas e foto antiga removida do anúncio verde.':
       'Fotos enviadas e gestão sincronizada. A confirmação das quatro imagens ainda está pendente.'},correct?200:202);
}

async function replaceDuzizoRedGallery(req:Request,adminId:string,body:any){
 const ITEM='MLB5529252361',PRODUCT='16725286274',SKU='0001',
 OLD='951426-MLB121070462263_112026';
 if(body.confirmar!==true||body.itemId!==ITEM){
   return json(req,{ok:false,message:'Confirme o anúncio vermelho DUZIZO e o pedido de substituição das quatro fotos.'},400);
 }
 const {data:allowed,error:rlErr}=await db.rpc('rl_check_and_increment',{
   p_bucket:'meli-replace-duzizo-red-20261108:'+adminId,p_limit:3,p_window_seconds:3600});
 if(rlErr||allowed!==true)return json(req,{ok:false,message:'Limite de segurança atingido.'},429);
 const [local,connected]=await Promise.all([
   db.from('store_marketplace_listings').select('id,status,bling_product_id,images,external_listing_id,price,last_error')
      .eq('external_listing_id',ITEM).eq('marketplace','mercado_livre').maybeSingle(),
   connection()
 ]);
 if(local.error||!local.data||local.data.bling_product_id!==PRODUCT||local.data.status!=='published')
   return json(req,{ok:false,message:'Vínculo do anúncio vermelho com o Bling não confirmado.'},409);
 if(!connected)return json(req,{ok:false,message:'Conexão Mercado Livre indisponível.'},503);
 let access:string;
 try{access=await usableToken(connected);}catch{return json(req,{ok:false,message:'Sessão do Mercado Livre precisa ser renovada.'},503);}
 const current=await readMeli('/items/'+ITEM,access);
 if(!current.ok)return json(req,{ok:false,message:'Não foi possível consultar o anúncio antes da edição.'},502);
 const it=current.data;
 const sku=String((it.attributes||[]).find((a:any)=>a.id==='SELLER_SKU')?.value_name||'');
 const cor=String((it.attributes||[]).find((a:any)=>a.id==='COLOR')?.value_name||'');
 if(it.status!=='active'||Number(it.seller_id)!==Number(connected.seller_id)||
    sku!==SKU||cor!=='Vermelho'||it.condition!=='new'||it.category_id!=='MLB28130'||
    Number(it.price)!==77.9||Number(it.available_quantity)!==3||it.shipping?.mode!=='me2')
   return json(req,{ok:false,message:'O anúncio alterou estado, cor, estoque, preço ou vendedor. Alteração cancelada.'},409);
 const originals=Array.isArray(it.pictures)?it.pictures.map((v:any)=>String(v.id||'')):[];
 if(originals.length!==1||originals[0]!==OLD)
   return json(req,{ok:false,message:'A galeria atual já mudou. Não substituir fotos desconhecidas.',pictures:originals},409);
 const files=[
  {name:'1000207948.png',role:'capa',url:'https://videocdn.pollo.ai/web-cdn/pollo/production/cmp0kq6ey09a745o9i18wq0h2/image/1794162735533-29dd84a7-015a-4ff7-93da-fe79ce8fa56f.png',sha:'72a38c2381bc56f406fdb04f93929a9cee843ce9fe26b005c01b89bb7625a1d1'},
  {name:'1000207949.png',role:'ambientada',url:'https://videocdn.pollo.ai/web-cdn/pollo/production/cmp0kq6ey09a745o9i18wq0h2/image/1794162738415-b146dbca-3be4-487c-af02-20dec0d2044a.png',sha:'0293df26af81cf2f99eee0a9a50b22967c2d9743d46fb33a77a047fcb0177f5c'},
  {name:'1000207950.png',role:'bebe',url:'https://videocdn.pollo.ai/web-cdn/pollo/production/cmp0kq6ey09a745o9i18wq0h2/image/1794162741448-27629507-7155-4ec6-91a3-dd2b61850ae4.png',sha:'f8570042e675dcfdbc45e5044b9dfd33566682cbc33c2ae4f59ee1bd622f09cc'},
  {name:'1000207951.png',role:'detalhes',url:'https://videocdn.pollo.ai/web-cdn/pollo/production/cmp0kq6ey09a745o9i18wq0h2/image/1794162744366-12d97081-eaff-4fd4-b52e-ee84edc21c97.png',sha:'9fc2dd9f0d457a3d23f5ea9ca3d3d52451997f7d1cfc8665010b0ac1f5f3976b'}
 ];
 const bucket='anarosa-product-images';
 const parent='c118f1e5-21c8-48ca-9ab6-cbd50539d0ec';
 const publicUrls:string[]=[];
 // Cada arquivo é conferido byte a byte contra a foto que o administrador enviou.
 for(const f of files){
   let buf:Uint8Array;
   try{
     const u=new URL(f.url);
     if(u.protocol!=='https:'||u.hostname!=='videocdn.pollo.ai')
       return json(req,{ok:false,message:'Origem de foto inesperada.'},422);
     const fetched=await fetch(f.url,{signal:AbortSignal.timeout(20000)});
     if(!fetched.ok)return json(req,{ok:false,message:'Não foi possível obter a foto '+f.name,httpStatus:fetched.status},502);
     buf=new Uint8Array(await fetched.arrayBuffer());
   }catch{return json(req,{ok:false,message:'Falha ao baixar uma foto. Não houve edição do anúncio.',filename:f.name},502);}
   if(buf.byteLength<30000||buf.byteLength>3000000||
      buf[0]!==255||buf[1]!==216||buf[2]!==255)
     return json(req,{ok:false,message:'Arquivo inválido ou acima do limite.',filename:f.name},422);
   const digest=hex(new Uint8Array(await crypto.subtle.digest('SHA-256',buf)));
   if(digest!==f.sha)return json(req,{ok:false,message:'Arquivo diferente da foto aprovada. Envio interrompido.',filename:f.name},409);
   const path=parent+'/mlb5529252361/2026-11-08-'+f.name.replace(/\.png$/i,'.jpg');
   const {error:uploadErr}=await db.storage.from(bucket).upload(path,buf,{
     contentType:'image/jpeg',cacheControl:'3600',upsert:false
   });
   if(uploadErr){
     // Se já foi importado, confere o checksum do arquivo existente (sem sobrescrever).
     const {data:present,error:downloadErr}=await db.storage.from(bucket).download(path);
     if(downloadErr||!present)return json(req,{ok:false,message:'Não foi possível guardar a foto no Storage.',filename:f.name,detail:String(uploadErr.message||'').slice(0,140)},502);
     const oldBytes=new Uint8Array(await present.arrayBuffer());
     const storedDigest=hex(new Uint8Array(await crypto.subtle.digest('SHA-256',oldBytes)));
     if(storedDigest!==f.sha)return json(req,{ok:false,message:'Conflito no nome da foto armazenada.',filename:f.name},409);
   }
   const url=db.storage.from(bucket).getPublicUrl(path).data.publicUrl;
   const check=await fetch(url,{method:'HEAD',signal:AbortSignal.timeout(12000)}).catch(()=>null);
   if(!check?.ok)return json(req,{ok:false,message:'Foto armazenada, mas não acessível publicamente.',filename:f.name},502);
   publicUrls.push(url);
 }
 // O PUT substitui TODA a galeria; a ID da foto antiga não é incluída.
 let update:any;
 try{update=await writeMeli('/items/'+ITEM,access,{pictures:publicUrls.map(source=>({source}))});}
 catch{return json(req,{ok:false,uncertain:true,message:'O Mercado Livre não retornou confirmação. Fotos foram importadas no Storage; verificar a galeria antes de repetir.',publicUrls},502);}
 if(!update.ok)return json(req,{ok:false,stage:'mercado_livre',message:'Fotos importadas na ANAROSA, mas Mercado Livre recusou substituir a galeria.',details:update,publicUrls},422);
 let check=await readMeli('/items/'+ITEM,access).catch(()=>({ok:false}));
 const photos=check.ok&&Array.isArray(check.data?.pictures)?check.data.pictures:[];
 const oldGone=!photos.some((p:any)=>p.id===OLD);
 const correct=check.ok&&photos.length===4&&oldGone;
 const safe=check.ok&&Number(check.data.price)===77.9&&Number(check.data.available_quantity)===3&&
   check.data.shipping?.mode==='me2'&&check.data.listing_type_id===it.listing_type_id;
 if(!safe)return json(req,{ok:false,remoteAccepted:true,uncertain:true,message:'A edição foi aceita, mas a validação dos dados comerciais falhou. Confira o anúncio.',pictureCount:photos.length,oldGone},202);
 // Depois da aceitação do Mercado Livre, sincroniza a Gestão ANAROSA.
 const {error:synced}=await db.from('store_marketplace_listings').update({
   images:publicUrls,updated_at:new Date().toISOString(),
   last_error:correct?null:'Novas fotos enviadas; aguardando processamento ou conferência pelo Mercado Livre.'
 }).eq('id',local.data.id).eq('external_listing_id',ITEM).eq('status','published');
 if(synced)return json(req,{ok:false,remoteAccepted:true,message:'Galeria editada externamente, mas falhou sincronização com a Gestão ANAROSA.',pictureCount:photos.length},502);
 return json(req,{ok:correct,remoteAccepted:true,updatedInManagement:true,
   itemId:ITEM,pictureCount:photos.length,oldRemoved:oldGone,
   status:check.data.status,price:check.data.price,stock:check.data.available_quantity,
   listingType:check.data.listing_type_id,shipping:check.data.shipping?.mode,
   pictures:photos.map((v:any)=>({id:v.id,url:v.secure_url||v.url})),
   pending:!correct,message:correct?'Quatro fotos novas confirmadas e foto antiga removida do anúncio vermelho.':
       'Fotos enviadas e gestão sincronizada. A confirmação das quatro imagens ainda está pendente.'},correct?200:202);
}

async function finalizeSeparatedDuzizoListings(req:Request,adminId:string,body:any) {
 const RED='MLB5529252361',GREEN='MLB7960343796',
   RED_PIC='951426-MLB121070462263_112026',
   GREEN_PIC='892902-MLB121074284583_112026';
 if(body.confirmar!==true||body.redItemId!==RED||body.greenItemId!==GREEN)
   return json(req,{ok:false,message:'Confirmação e IDs específicos obrigatórios.'},400);
 const {data:rate,error:re}=await db.rpc('rl_check_and_increment',{
   p_bucket:'meli-split-colors:'+adminId,p_limit:3,p_window_seconds:3600
 });
 if(re||rate!==true)return json(req,{ok:false,message:'Limite de segurança atingido.'},429);
 const conn=await connection();
 if(!conn)return json(req,{ok:false,message:'Mercado Livre não está conectado.'},409);
 let access:string;
 try{access=await usableToken(conn);}
 catch{return json(req,{ok:false,message:'Autorização Mercado Livre não disponível.'},503);}
 const [r,g,locals]=await Promise.all([
   readMeli('/items/'+RED,access),readMeli('/items/'+GREEN,access),
   db.from('store_marketplace_listings')
     .select('id,status,external_listing_id,bling_product_id,attributes,images,variation_mapping')
     .in('external_listing_id',[RED,GREEN]).eq('marketplace','mercado_livre')
 ]);
 if(!r.ok||!g.ok||locals.error)return json(req,{ok:false,message:'Não foi possível conferir ambos os anúncios.'},502);
 const red=r.data,green=g.data,redRec=locals.data?.find((v:any)=>v.external_listing_id===RED),
   greenRec=locals.data?.find((v:any)=>v.external_listing_id===GREEN);
 if(!redRec||!greenRec||redRec.bling_product_id!=='16725286274'||greenRec.bling_product_id!=='16725286274')
   return json(req,{ok:false,message:'Anúncios não estão vinculados ao produto DUZIZO da gestão.'},409);
 const sku=(x:any)=>String((x.attributes||[]).find((a:any)=>a.id==='SELLER_SKU')?.value_name||'');
 const color=(x:any)=>String((x.attributes||[]).find((a:any)=>a.id==='COLOR')?.value_name||'');
 const size=(x:any)=>String((x.attributes||[]).find((a:any)=>a.id==='SIZE')?.value_name||'').toUpperCase();
 if([red,green].some(x=>Number(x.seller_id)!==Number(conn.seller_id)||
    Number(x.price)!==77.9||Number(x.available_quantity)!==3||
    x.category_id!=='MLB28130'||x.condition!=='new'||
    x.shipping?.mode!=='me2'||Number(x.sold_quantity)!==0)||
    sku(red)!=='0001'||sku(green)!=='0002'||color(red)!=='Vermelho'||
    color(green)!=='Verde'||size(red)!=='RN'||size(green)!=='P')
    return json(req,{ok:false,message:'Um dos anúncios mudou de preço, estoque, SKU, cor, condição ou envio. Nenhuma alteração aplicada.'},409);
 if(red.status!=='active'||!['paused','active'].includes(green.status))
    return json(req,{ok:false,message:'Situação dos anúncios diverge do esperado. Atualize a conferência antes de agir.'},409);
 const redPics=Array.isArray(red.pictures)?red.pictures.map((x:any)=>String(x.id||'')):[];
 const greenPics=Array.isArray(green.pictures)?green.pictures.map((x:any)=>String(x.id||'')):[];
 if(!greenPics.includes(GREEN_PIC)||!([RED_PIC].every((id:string)=>redPics.includes(id)))||
     !(redPics.length===1&&redPics[0]===RED_PIC)&&
     !(redPics.length===3&&redPics[0]==='856778-MLA119361032992_112026'&&
       redPics[1]===RED_PIC&&redPics[2]==='633806-MLB121070462265_112026'))
   return json(req,{ok:false,message:'Fotos no Mercado Livre não correspondem à sequência revisada. Nenhuma alteração aplicada.'},409);
 const {data:stock}=await db.from('store_inventory').select('available_stock')
   .eq('bling_product_id','16725286276').eq('deposit_id','__total__').maybeSingle();
 if(Number(stock?.available_stock)!==3)return json(req,{ok:false,message:'Estoque verde não corresponde a 3 unidades.'},409);
 let photosChanged=false,redCheck=r;
 if(redPics.length>1){
   let applied:any;
   try{applied=await writeMeli('/items/'+RED,access,{pictures:[{id:RED_PIC}]});}
   catch{return json(req,{ok:false,uncertain:true,message:'Não foi possível confirmar a remoção das fotos. Verifique o anúncio antes de repetir.'},502);}
   if(!applied.ok)return json(req,{ok:false,phase:'red_photos',message:'Mercado Livre não aceitou remover as fotos verdes.',detail:applied},422);
   photosChanged=true;
   redCheck=await readMeli('/items/'+RED,access);
 }
 if(!redCheck.ok||redCheck.data?.pictures?.length!==1||redCheck.data.pictures[0]?.id!==RED_PIC)
   return json(req,{ok:false,phase:'verify_red_photos',photosChanged,
     message:'A remoção das fotos verdes não pôde ser confirmada; verde permanece pausado.'},202);
 // Refletir no painel somente após confirmar as fotos na API.
 if(redRec.images?.length===3){
   const {error:redErr}=await db.from('store_marketplace_listings').update({
     images:[redRec.images[1]],updated_at:new Date().toISOString()
   }).eq('id',redRec.id).eq('external_listing_id',RED);
   if(redErr)return json(req,{ok:false,phase:'sync_red',photosChanged,
     message:'Fotos corrigidas no Mercado Livre, porém a gestão não sincronizou; não executar o próximo passo sem reconciliar.'},502);
 }
 let activated=green.status==='active';
 let activation:any=null;
 if(!activated){
   try{activation=await writeMeli('/items/'+GREEN,access,{status:'active'});}
   catch{return json(req,{ok:false,phase:'green_activation',photosChanged,uncertain:true,
     message:'Resposta da ativação do verde foi interrompida. Confira o anúncio antes de repetir.'},502);}
   if(!activation.ok)return json(req,{ok:false,phase:'green_activation',photosChanged,
     message:'Fotos do vermelho corrigidas, mas Mercado Livre não aceitou ativar o verde.',detail:activation},422);
 }
 const [greenCheck,redFinal]=await Promise.all([readMeli('/items/'+GREEN,access),readMeli('/items/'+RED,access)]);
 activated=!!greenCheck.ok&&greenCheck.data?.status==='active';
 const redCorrect=!!redFinal.ok&&redFinal.data?.status==='active'&&
   redFinal.data?.pictures?.length===1&&redFinal.data.pictures[0]?.id===RED_PIC;
 if(activated&&redCorrect){
   const attrs={...(greenRec.attributes||{}),family_id:'82386193060690',user_product_id:'MLBU5850814980'};
   delete attrs.parent_user_product_id;
   const {error:syncErr}=await db.from('store_marketplace_listings').update({
     status:'published',last_error:null,
     external_url:String(greenCheck.data?.permalink||'')||null,
     published_at:new Date().toISOString(),updated_at:new Date().toISOString(),
     attributes:attrs
   }).eq('id',greenRec.id).eq('external_listing_id',GREEN);
   if(syncErr)return json(req,{ok:false,photosChanged:true,greenActive:true,
      message:'Os dois anúncios foram corrigidos externamente, mas falhou a sincronização do verde com a gestão.'},502);
 }
 return json(req,{
   ok:activated&&redCorrect,redPhotoCorrected:redCorrect,greenActive:activated,
   redItemId:RED,greenItemId:GREEN,
   redPhotoIds:redFinal.ok?redFinal.data?.pictures?.map((v:any)=>v.id):null,
   greenPhotoIds:greenCheck.ok?greenCheck.data?.pictures?.map((v:any)=>v.id):null,
   greenStatus:greenCheck.ok?greenCheck.data?.status:null,
   redStatus:redFinal.ok?redFinal.data?.status:null,
   redPrice:redFinal.ok?redFinal.data?.price:null,
   greenPrice:greenCheck.ok?greenCheck.data?.price:null,
   redStock:redFinal.ok?redFinal.data?.available_quantity:null,
   greenStock:greenCheck.ok?greenCheck.data?.available_quantity:null,
   message:activated&&redCorrect?
     'Vermelho RN: apenas foto vermelha. Verde P: anúncio separado ativo, sem duplicação.':
     'Atualização parcial: confira os anúncios antes de repetir.'
 },activated&&redCorrect?200:207);
}


function resolveListingAttributes(spec:any[],raw:any,product:any,variant:any){
  const norm=(x:any)=>String(x??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();
  const fields:Record<string,string>={};
  for(const [k,v] of Object.entries(raw||{})){
    if(/^[A-Z0-9_]{1,55}$/.test(k)&&(typeof v==='string'||typeof v==='number'||typeof v==='boolean')&&String(v).trim())
      fields[k]=String(v).trim();
  }
  fields.BRAND=fields.BRAND||String(product.brand||'');
  fields.COLOR=String(variant.color||fields.COLOR||'');
  fields.SIZE=String(variant.size||fields.SIZE||'');
  fields.SELLER_SKU=String(variant.sku||'');
  const condition=String(product.condition||'');
  if(!fields.ITEM_CONDITION&&condition==='new')fields.ITEM_CONDITION='Novo';
  const missing:string[]=[],invalid:any[]=[],attributes:any[]=[];
  for(const def of spec){
    const id=String(def.id||'');
    const value=fields[id];
    if(def.tags?.read_only===true)continue;
    if(!value){if(def.tags?.required===true)missing.push(id);continue;}
    const values=Array.isArray(def.values)?def.values:[];
    const match=values.find((x:any)=>String(x.id)===value||norm(x.name)===norm(value));
    if(match?.id){attributes.push({id,value_id:String(match.id)});}
    else if(def.value_type==='list'&&values.length){
      invalid.push({id,name:def.name,value,allowed:values.map((x:any)=>({id:x.id,name:x.name})).slice(0,100)});
    }else{attributes.push({id,value_name:value});}
  }
  for(const id of ['BRAND','MODEL','COLOR','SIZE','GENDER','SELLER_SKU']){
    if(!fields[id]&&!missing.includes(id))missing.push(id);
  }
  return {fields,attributes,missing,invalid};
}
async function meliCatalogMetadata(req:Request,adminId:string,body:any,action:string){
  const {data:permit,error}=await db.rpc('rl_check_and_increment',{p_bucket:'meli-metadata:'+adminId,p_limit:20,p_window_seconds:60});
  if(error||permit!==true)return json(req,{ok:false,message:'Limite temporário de consultas atingido.'},429);
  const row=await connection();
  if(!row)return json(req,{ok:false,message:'Reconecte o Mercado Livre.'},409);
  let access:string;
  try{access=await usableToken(row);}catch{return json(req,{ok:false,message:'Autorização indisponível. Reconecte se necessário.'},503);}
  const seller=await readMeli('/users/me',access);
  if(!seller.ok||Number(seller.data?.id)!==Number(row.seller_id))return json(req,{ok:false,message:'Identidade do vendedor não confirmada.'},409);
  if(action==='chart_detail'){
    const id=String(body.chartId||'');
    if(!/^\d{1,30}$/.test(id))return json(req,{ok:false,message:'ID de tabela inválido.'},400);
    const chart=await readMeli('/catalog/charts/'+id,access);
    if(!chart.ok)return json(req,{ok:false,message:'Tabela não disponível.',httpStatus:chart.status},404);
    const c=chart.data;
    if(c.type==='SPECIFIC'&&Number(c.seller_id)!==Number(row.seller_id))return json(req,{ok:false,message:'Tabela específica não pertence a esta conta.'},403);
    return json(req,{ok:true,chart:c});
  }
  const categoryId=String(body.categoryId||'').trim();
  if(!/^MLB\d{1,12}$/.test(categoryId))return json(req,{ok:false,message:'Categoria MLB inválida.'},400);
  const [cat,spec]=await Promise.all([readMeli('/categories/'+categoryId,access),readMeli('/categories/'+categoryId+'/attributes',access)]);
  if(!cat.ok||!spec.ok||!Array.isArray(spec.data))return json(req,{ok:false,message:'Não foi possível consultar categoria e atributos.'},502);
  const domainId=String(cat.data?.settings?.catalog_domain||'');
  if(action==='category_schema'){
    let shippingPreferences:any=null;
    try{
      const p=await readMeli('/users/'+Number(row.seller_id)+'/shipping_preferences',access);
      shippingPreferences=p.ok?{modes:p.data?.modes,option:p.data?.option,tags:p.data?.tags,logistics:(p.data?.logistics||[]).map((l:any)=>({mode:l.mode,types:(l.types||[]).map((x:any)=>({type:x.type,default:x.default}))}))}:{httpStatus:p.status};
    }catch{shippingPreferences={unavailable:true};}
    return json(req,{ok:true,categoryId,name:cat.data?.name,domainId,path:cat.data?.path_from_root,settings:cat.data?.settings,attributes:spec.data,shippingPreferences});
  }
  if(!/^MLB-[A-Z0-9_]+$/.test(domainId))return json(req,{ok:false,message:'Domínio não confirmado para tabela de medidas.'},422);
  if(action==='chart_template'||action==='chart_search'){
    const gender=String(body.gender||'').trim(),brand=String(body.brand||'').trim();
    const genderOption=spec.data.find((a:any)=>a.id==='GENDER')?.values?.find((g:any)=>String(g.id)===gender||String(g.name).toLowerCase()===gender.toLowerCase());
    if(!genderOption||!brand||brand.length>100)return json(req,{ok:false,message:'Selecione marca comprovada e gênero oficial da categoria.'},422);
    const filters=[
      {id:'GENDER',name:'Gênero',value_id:String(genderOption.id),value_name:genderOption.name,values:[{id:String(genderOption.id),name:genderOption.name}]},
      {id:'BRAND',name:'Marca',value_name:brand,values:[{name:brand}]}
    ];
    const extraRequired=spec.data.filter((a:any)=>a.tags?.grid_template_required===true&&!filters.some(f=>f.id===a.id)).map((a:any)=>a.id);
    if(extraRequired.length)return json(req,{ok:false,message:'Ficha de grade requer filtros adicionais.',missing:extraRequired},422);
    const isSearch=action==='chart_search';
    const path=isSearch?'/catalog/charts/search?offset=0&limit=100':'/domains/'+domainId+'/technical_specs?section=grids';
    const requestBody=isSearch?{domain_id:domainId.replace(/^MLB-/,''),site_id:'MLB',seller_id:Number(row.seller_id),
      attributes:filters.map(f=>({id:f.id,values:f.values}))}:{attributes:filters};
    const r=await fetch(BASE+path,{method:'POST',headers:{Authorization:'Bearer '+access,'Content-Type':'application/json',Accept:'application/json','x-caller-id':String(row.seller_id)},
      body:JSON.stringify(requestBody),signal:AbortSignal.timeout(20000)});
    const result=await r.json().catch(()=>({}));
    if(!r.ok)return json(req,{ok:false,message:'Mercado Livre rejeitou a consulta de tabela.',detail:String(result.message||result.error||'').slice(0,500),httpStatus:r.status},422);
    if(isSearch)return json(req,{ok:true,domainId,gender:genderOption,brand,paging:result.paging,charts:(result.charts||[]).filter((c:any)=>c.type!=='SPECIFIC'||Number(c.seller_id)===Number(row.seller_id)).map((c:any)=>({id:c.id,names:c.names,type:c.type,domain_id:c.domain_id,main_attribute_id:c.main_attribute_id,attributes:c.attributes,rows:c.rows}))});
    return json(req,{ok:true,domainId,gender:genderOption,brand,template:result});
  }
  const technical=await readMeli('/domains/'+domainId+'/technical_specs',access);
  if(!technical.ok)return json(req,{ok:false,message:'Ficha técnica do domínio indisponível.',httpStatus:technical.status},422);
  return json(req,{ok:true,categoryId,domainId,technicalSpecs:technical.data,categoryAttributes:spec.data.filter((x:any)=>x.id==='GENDER'||x.id==='AGE_GROUP'||x.id==='BRAND'||x.id==='SIZE'||x.id==='SIZE_GRID_ID'||x.id==='SIZE_GRID_ROW_ID')});
}


async function chartCreation(req:Request,adminId:string,body:any,action:string){
  const row=await connection();
  if(!row)return json(req,{ok:false,message:'Conecte a conta Mercado Livre.'},409);
  const sellerId=Number(row.seller_id);
  let access:string;
  try{access=await usableToken(row);}catch{return json(req,{ok:false,message:'Autorização indisponível.'},503);}
  const seller=await readMeli('/users/me',access);
  if(!seller.ok||Number(seller.data?.id)!==sellerId||seller.data?.site_id!=='MLB')
    return json(req,{ok:false,message:'Identidade da conta brasileira não confirmada.'},409);
  const {data:permitted,error:rateError}=await db.rpc('rl_check_and_increment',{
    p_bucket:'meli-'+action+':'+adminId,p_limit:action==='chart_create'?3:12,p_window_seconds:action==='chart_create'?3600:60});
  if(rateError||permitted!==true)return json(req,{ok:false,message:'Limite de segurança para tabelas atingido.'},429);
  if(action==='chart_create'){
    const id=String(body.intentId||'');
    if(body.confirmar!==true||!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id))
      return json(req,{ok:false,message:'Confirme expressamente a prévia exata da tabela.'},400);
    const {data:intent,error}=await db.from('meli_chart_creation_intents').select('*').eq('id',id)
      .eq('admin_id',adminId).eq('seller_id',sellerId).maybeSingle();
    if(error||!intent)return json(req,{ok:false,message:'Prévia não encontrada.'},404);
    if(intent.status==='created')return json(req,{ok:true,created:true,chartId:intent.remote_chart_id,alreadyCreated:true});
    if(intent.status!=='prepared'||Date.parse(intent.expires_at)<=Date.now())
      return json(req,{ok:false,message:'Prévia vencida ou tentativa existente; não repetir sem reconciliação.',status:intent.status},409);
    const payload=intent.payload;
    const searchBody={domain_id:payload.domain_id,site_id:'MLB',seller_id:sellerId,attributes:payload.attributes};
    const lookup=await fetch(BASE+'/catalog/charts/search?offset=0&limit=100',{
      method:'POST',headers:{Authorization:'Bearer '+access,'Content-Type':'application/json','x-caller-id':String(sellerId)},
      body:JSON.stringify(searchBody),signal:AbortSignal.timeout(20000)});
    const found=await lookup.json().catch(()=>({}));
    if(!lookup.ok||!Array.isArray(found.charts)||Number(found.paging?.total||0)>100)
      return json(req,{ok:false,message:'Não foi possível verificar tabelas existentes; criação suspensa.'},502);
    const same=found.charts.find((c:any)=>c.names?.MLB===payload.names.MLB);
    if(same)return json(req,{ok:false,message:'Já existe tabela com este nome; confira suas linhas antes de criar.',chartId:same.id},409);
    const {data:claimed,error:claimError}=await db.from('meli_chart_creation_intents')
      .update({status:'creating',updated_at:new Date().toISOString()}).eq('id',id).eq('status','prepared')
      .gt('expires_at',new Date().toISOString()).select('id').maybeSingle();
    if(claimError||!claimed)return json(req,{ok:false,message:'Criação concorrente detectada.'},409);
    try{
      const response=await fetch(BASE+'/catalog/charts',{method:'POST',
        headers:{Authorization:'Bearer '+access,'Content-Type':'application/json','x-caller-id':String(sellerId)},
        body:JSON.stringify(payload),signal:AbortSignal.timeout(25000)});
      const answer=await response.json().catch(()=>({}));
      const chartId=String(answer.id||'');
      if(!response.ok){
        const outcome={httpStatus:response.status,message:String(answer.message||answer.error||'Tabela rejeitada').slice(0,500),
          causes:Array.isArray(answer.errors)?answer.errors.slice(0,30).map((e:any)=>({code:e.code,message:e.message})):[]};
        const uncertain=response.status===408||response.status===429||response.status>=500;
        await db.from('meli_chart_creation_intents').update({status:uncertain?'uncertain':'rejected',outcome,updated_at:new Date().toISOString()}).eq('id',id);
        return json(req,{ok:false,created:false,uncertain,...outcome},422);
      }
      if(!/^\d{1,30}$/.test(chartId)){
        await db.from('meli_chart_creation_intents').update({status:'uncertain',updated_at:new Date().toISOString()}).eq('id',id);
        return json(req,{ok:false,uncertain:true,message:'Resposta sem ID verificável. Não repetir.'},502);
      }
      // Persistir o ID antes de qualquer nova leitura, evitando duplicação se a verificação falhar.
      await db.from('meli_chart_creation_intents').update({remote_chart_id:chartId,status:'uncertain',updated_at:new Date().toISOString()}).eq('id',id);
      const confirmed=await readMeli('/catalog/charts/'+chartId,access);
      if(!confirmed.ok||Number(confirmed.data?.seller_id)!==sellerId||String(confirmed.data?.domain_id||'').replace(/^MLB-/,'')!==payload.domain_id)
        return json(req,{ok:false,uncertain:true,chartId,message:'ID recebido; confirmação oficial pendente. Não repetir.'},502);
      await db.from('meli_chart_creation_intents').update({status:'created',outcome:{chartId},updated_at:new Date().toISOString()}).eq('id',id);
      return json(req,{ok:true,created:true,chartId,chart:confirmed.data,message:'Tabela criada e confirmada; nenhum anúncio foi publicado.'});
    }catch{
      await db.from('meli_chart_creation_intents').update({status:'uncertain',updated_at:new Date().toISOString()}).eq('id',id);
      return json(req,{ok:false,uncertain:true,message:'Criação com resposta incerta. Consulte tabelas antes de qualquer nova tentativa.'},502);
    }
  }
  const listingId=String(body.listingId||'');
  if(!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(listingId))return json(req,{ok:false,message:'Selecione rascunho Mercado Livre.'},400);
  const {data:a}=await db.from('store_marketplace_listings').select('bling_product_id,category_external_id,attributes,status')
    .eq('id',listingId).eq('marketplace','mercado_livre').maybeSingle();
  if(!a||!['ready','draft'].includes(a.status))return json(req,{ok:false,message:'Rascunho não disponível.'},404);
  const {data:p}=await db.from('store_products').select('id,brand,active').eq('bling_id',a.bling_product_id).maybeSingle();
  if(!p?.active)return json(req,{ok:false,message:'Produto Bling não disponível.'},409);
  const brand=String(a.attributes?.BRAND||p.brand||'').trim(),gender=String(a.attributes?.GENDER||'').trim();
  const categoryId=String(a.category_external_id||'');
  const name=String(body.name||'').trim();
  if(!brand||!gender||!/^MLB\d+$/.test(categoryId)||!(/^[\p{L}\p{N} ]{3,60}$/u.test(name)))
    return json(req,{ok:false,message:'Nome da tabela (letras, números e espaços), marca, gênero e categoria são obrigatórios.'},422);
  const spec=await meliCatalogMetadata(req,adminId,{categoryId,gender,brand},'chart_template');
  const meta=await spec.json();
  if(!meta.ok)return json(req,meta,spec.status);
  const defs:any[]=[];
  const visit=(x:any)=>{if(!x||typeof x!=='object')return;if(Array.isArray(x)){x.forEach(visit);return;}if(x.id&&x.value_type)defs.push(x);Object.values(x).forEach(visit);};
  visit(meta.template?.input);
  const measurementType=String(body.measurementType||'');
  const clothing=measurementType==='CLOTHING_MEASURE'||measurementType==='BODY_MEASURE';
  if(measurementType&&!clothing)return json(req,{ok:false,message:'Tipo de medida inválido.'},422);
  const tags=(x:any)=>Array.isArray(x?.tags)?x.tags:[];
  const main=defs.find(x=>x.id===(clothing?'SIZE':'MANUFACTURER_SIZE')&&tags(x).includes('main_attribute_candidate'));
  const foot=defs.find(x=>x.id==='FOOT_LENGTH'&&x.value_type==='number_unit');
  const footTo=defs.find(x=>x.id==='FOOT_LENGTH_TO'&&x.value_type==='number_unit');
  const selected=defs.filter(x=>tags(x).includes(measurementType)&&x.value_type==='number_unit');
  const measures=new Map<string,any>(selected.map(x=>[x.id,x]));
  const otherMode=measurementType==='CLOTHING_MEASURE'?'BODY_MEASURE':'CLOTHING_MEASURE';
  const equivalence=defs.find(x=>x.id==='FILTRABLE_SIZE'&&x.value_type==='list');
  if(!main||(!clothing&&!foot)||(clothing&&(!selected.length||!equivalence)))return json(req,{ok:false,message:'Ficha não compatível com o tipo de tabela solicitado.'},422);
  const supported=new Set(clothing?['BRAND','GENDER','SIZE','FILTRABLE_SIZE',...measures.keys()]:['BRAND','GENDER','MANUFACTURER_SIZE','FOOT_LENGTH']);
  const missing=defs.filter(x=>tags(x).includes('required')&&!tags(x).includes('read_only')&&!(clothing&&tags(x).includes(otherMode))&&!supported.has(x.id)).map(x=>x.id);
  if(missing.length)return json(req,{ok:false,message:'A ficha exige informações adicionais.',missing},422);
  if(clothing&&(!String(body.measurementSource||'').trim()||String(body.measurementSource).length>500))return json(req,{ok:false,message:'Informe a origem das medidas reais ou de referência para revisão.'},422);
  const {data:variants,error:ve}=await db.from('store_product_variants').select('size,active').eq('product_id',p.id);
  if(ve||!variants?.length)return json(req,{ok:false,message:'Numerações Bling indisponíveis.'},502);
  const expected=[...new Set(variants.filter(x=>x.active).map(x=>String(x.size||'').trim()).filter(Boolean))];
  const rows=Array.isArray(body.rows)?body.rows:[];
  if(!expected.length||rows.length!==expected.length||rows.length>75)
    return json(req,{ok:false,message:'Informe uma medida real para cada tamanho ativo do produto.',expectedSizes:expected},422);
  const seen=new Set<string>();
  const preparedRows:any[]=[];
  if(clothing){
    const required=selected.filter(x=>tags(x).includes('required')).map(x=>x.id);
    for(const r of rows){
      const size=String(r?.size||'').trim();
      const values=r?.measurements;
      const option=equivalence.values?.find((x:any)=>String(x.name).toUpperCase()===String(r?.equivalentSize||size).toUpperCase());
      if(!expected.includes(size)||seen.has(size)||!option?.id||!values||typeof values!=='object'||Array.isArray(values))
        return json(req,{ok:false,message:'Tamanho ou equivalência inválidos, ou medidas ausentes.',size},422);
      const missingMeasures=required.filter(k=>!Object.hasOwn(values,k));
      if(missingMeasures.length)return json(req,{ok:false,message:'Medidas obrigatórias ausentes.',size,missing:missingMeasures},422);
      const attrs:any[]=[{id:'SIZE',values:[{name:size}]},{id:'FILTRABLE_SIZE',values:[{id:String(option.id),name:option.name}]}];
      for(const [key,value] of Object.entries(values)){
        const def=measures.get(key);
        if(!def||typeof value!=='number'||!Number.isFinite(value)||value<=0||value>350||!(def.units||[]).some((u:any)=>u.id==='cm'))
          return json(req,{ok:false,message:'Medida inválida ou incompatível com o tipo selecionado.',size,attribute:key},422);
        if(key.endsWith('_TO')){
          const from=values[key.slice(0,-3)+'_FROM'];
          if(typeof from!=='number'||value<from)return json(req,{ok:false,message:'Intervalo de medidas inválido.',size,attribute:key},422);
        }
        attrs.push({id:key,values:[{name:value+' cm',struct:{number:value,unit:'cm'}}]});
      }
      seen.add(size);preparedRows.push({attributes:attrs});
    }
  }else{
  for(const r of rows){
    const size=String(r?.size||'').trim(),length=Number(r?.footLengthCm);
    const hasTo=r?.footLengthToCm!==undefined&&r?.footLengthToCm!==null&&r?.footLengthToCm!=='';
    const to=hasTo?Number(r.footLengthToCm):null;
    if(!expected.includes(size)||seen.has(size)||!Number.isFinite(length)||length<1||length>60||
        (to!==null&&(!footTo||!Number.isFinite(to)||to<length||to>60)))
      return json(req,{ok:false,message:'Tamanho repetido, medida inválida ou ausente no Bling.',size},422);
    seen.add(size);
    preparedRows.push({attributes:[
      {id:'MANUFACTURER_SIZE',values:[{name:size}]},
      {id:'FOOT_LENGTH',values:[{name:length+' cm',struct:{number:length,unit:'cm'}}]},
      ...(to===null?[]:[{id:'FOOT_LENGTH_TO',values:[{name:to+' cm',struct:{number:to,unit:'cm'}}]}])
    ]});
  }
  }
  const domainId=String(meta.domainId||'').replace(/^MLB-/,'');
  const payload={names:{MLB:name},domain_id:domainId,site_id:'MLB',...(clothing?{measure_type:measurementType}:{}),main_attribute:{attributes:[{site_id:'MLB',id:main.id}]},
    attributes:[{id:'GENDER',values:[{id:meta.gender.id,name:meta.gender.name}]},{id:'BRAND',values:[{name:brand}]}],
    rows:preparedRows};
  const hash=await sha(JSON.stringify(payload));
  const {data:previous,error:pe}=await db.from('meli_chart_creation_intents').select('id,status,remote_chart_id,expires_at')
    .eq('seller_id',sellerId).eq('request_hash',hash).maybeSingle();
  if(pe)return json(req,{ok:false,message:'Erro ao consultar histórico de tabelas.'},502);
  if(previous){
    if(previous.status!=='prepared')return json(req,{ok:false,message:'Já existe tentativa para a mesma tabela; confira o histórico.',status:previous.status,chartId:previous.remote_chart_id},409);
    const {data:renewed,error:renewError}=await db.from('meli_chart_creation_intents').update({expires_at:new Date(Date.now()+1800000).toISOString()})
      .eq('id',previous.id).eq('admin_id',adminId).eq('status','prepared').select('id').maybeSingle();
    if(renewError||!renewed)return json(req,{ok:false,message:'A prévia existente pertence a outro administrador ou foi alterada.'},409);
    return json(req,{ok:true,preview:true,intentId:previous.id,payload,message:'Revise e confirme a criação. Nenhuma tabela remota foi criada.'});
  }
  const {data:created,error:ce}=await db.from('meli_chart_creation_intents').insert({
    admin_id:adminId,seller_id:sellerId,bling_product_id:a.bling_product_id,request_hash:hash,payload,status:'prepared'
  }).select('id').single();
  if(ce||!created)return json(req,{ok:false,message:'Prévia não gravada; tente consultar novamente.'},409);
  return json(req,{ok:true,preview:true,intentId:created.id,payload,message:'Revise e confirme a criação. Nenhuma tabela remota foi criada.'});
}

// Read-only proof of family membership; do not infer grouping from title alone.
async function verifyListingFamily(item:any,access:string){
  const userProductId=String(item?.user_product_id||'');
  if(!/^MLBU\d+$/.test(userProductId))return {userProductId:null,familyId:null,verified:false,members:[] as string[]};
  try{
    const up=await readMeli('/user-products/'+encodeURIComponent(userProductId),access);
    const familyId=String(up.data?.family_id||'');
    if(!up.ok||!/^\d+$/.test(familyId))return {userProductId,familyId:null,verified:false,members:[] as string[]};
    const family=await readMeli('/user-products-families/'+familyId+'/user-products',access);
    const members:string[]=Array.isArray(family.data?.user_products_ids)?family.data.user_products_ids.map(String):[];
    return {userProductId,familyId,verified:!!family.ok&&members.includes(userProductId),members};
  }catch{return {userProductId,familyId:null,verified:false,members:[] as string[]};}
}
async function publishAnarosaListing(req:Request,adminId:string,body:any){
  const id=String(body?.listingId||'').trim();
  const preview=body?.action==='validate_listing';
  if((!preview&&body?.confirmar!==true)||!/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(id))
    return json(req,{ok:false,message:'Identificador e autorização de publicação obrigatórios.'},400);
  // Preflight is limited separately; rejected validation never consumes a creation slot.
  const {data:rl,error:re}=await db.rpc('rl_check_and_increment',{p_bucket:'meli-preview:'+adminId,p_limit:12,p_window_seconds:60});
  if(re||rl!==true)return json(req,{ok:false,message:'Limite temporário de validações atingido.',retryAfterSeconds:Math.max(1,60-Math.floor(Date.now()/1000)%60)},429);
  const {data:a,error:ae}=await db.from('store_marketplace_listings').select('*')
    .eq('id',id).eq('marketplace','mercado_livre').maybeSingle();
  if(ae||!a)return json(req,{ok:false,message:'Rascunho não encontrado.'},404);
  if(a.external_listing_id||!['draft','ready'].includes(a.status))
    return json(req,{ok:false,message:'Rascunho já publicado, bloqueado ou com tentativa pendente.',externalListingId:a.external_listing_id,status:a.status},409);
  if(!/^MLB\d+$/.test(String(a.category_external_id||''))||a.shipping_mode!=='me2'||!Array.isArray(a.images)||!a.images.length)
    return json(req,{ok:false,message:'Categoria, modalidade Mercado Envios 2 ou fotos ausentes.'},422);
  const variations=(Array.isArray(a.variation_mapping)?a.variation_mapping:[]).filter((v:any)=>v.enabled===true);
  if(variations.length!==1)return json(req,{ok:false,message:'User Products exige exatamente uma variação ativa por item.'},422);
  const {data:p}=await db.from('store_products').select('id,bling_id,name,brand,price,condition,active,images')
    .eq('bling_id',a.bling_product_id).maybeSingle();
  if(!p||p.active!==true||Math.abs(Number(p.price)-Number(a.price))>0.001)
    return json(req,{ok:false,message:'Cadastro Bling inativo ou preço divergente.'},409);
  const v=variations[0];
  const {data:variant}=await db.from('store_product_variants').select('id,bling_id,sku,color,size,active,price')
    .eq('product_id',p.id).eq('bling_id',String(v.blingId)).maybeSingle();
  if(!variant||variant.active!==true||variant.sku!==v.sku||
    (variant.price!=null&&Math.abs(Number(variant.price)-Number(a.price))>0.001))
    return json(req,{ok:false,message:'Variação inativa ou divergente do Bling.'},409);
  const {data:stock}=await db.from('store_inventory').select('available_stock,synced_at')
    .eq('bling_product_id',variant.bling_id).eq('deposit_id','__total__').maybeSingle();
  const qty=Number(stock?.available_stock);
  if(!Number.isInteger(qty)||qty<1||!stock?.synced_at||Date.now()-Date.parse(stock.synced_at)>7*86400000)
    return json(req,{ok:false,message:'Estoque não confirmado ou sincronização do Bling antiga.'},409);
  const known=new Set((Array.isArray(p.images)?p.images:[]).map((x:any)=>typeof x==='string'?x:x?.url));
  // Permite imagens da conta Pollo desta loja somente se já estiverem na galeria
  // sincronizada do produto. Não amplia a lista de fontes permitidas para edições gerais.
  const trustedPolloProductImage=(imageUrl:string):boolean=>{
    try {
      const u=new URL(imageUrl);
      return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash
        &&u.hostname.toLowerCase()==='videocdn.pollo.ai'
        &&u.pathname.startsWith('/web-cdn/pollo/production/cmp0kq6ey09a745o9i18wq0h2/image/')
        &&/\.(jpe?g|png|webp)$/i.test(u.pathname);
    } catch {return false;}
  };
  if(a.images.length>12||new Set(a.images).size!==a.images.length||
    a.images.some((x:any)=>typeof x!=='string'||!known.has(x)||
      (!publicPictureUrl(x)&&!trustedPolloProductImage(x))))
    return json(req,{ok:false,message:'Fotos não correspondem à galeria pública deste produto.'},422);
  const row=await connection();
  if(!row)return json(req,{ok:false,message:'Reconecte o Mercado Livre.'},409);
  let access:string;
  try{access=await usableToken(row);}catch{return json(req,{ok:false,message:'Token Mercado Livre indisponível.'},503);}
  const user=await readMeli('/users/me',access);
  if(!user.ok||Number(user.data?.id)!==Number(row.seller_id)||user.data?.site_id!=='MLB'||
    !user.data?.tags?.includes('user_product_seller'))
    return json(req,{ok:false,message:'Conta não validada para publicar via User Products no Brasil.'},409);
  const cat=await readMeli('/categories/'+encodeURIComponent(a.category_external_id),access);
  const spec=await readMeli('/categories/'+encodeURIComponent(a.category_external_id)+'/attributes',access);
  if(!cat.ok||cat.data?.settings?.listing_allowed!==true||!spec.ok||!Array.isArray(spec.data))
    return json(req,{ok:false,message:'Categoria ou ficha técnica inválida para publicação.'},422);
  const resolved=resolveListingAttributes(spec.data,a.attributes,p,variant);
  const {fields,attributes,missing,invalid}=resolved;
  if(missing.length||invalid.length)return json(req,{ok:false,published:false,message:'Revise os atributos da categoria oficial.',missing,invalid},422);
  // Grid and row are verified against the official chart before item creation.
  if(fields.SIZE_GRID_ID||fields.SIZE_GRID_ROW_ID){
    if(!/^\d{1,30}$/.test(fields.SIZE_GRID_ID||'')||!fields.SIZE_GRID_ROW_ID)return json(req,{ok:false,message:'Informe tabela de medidas e ID de linha válidos.'},422);
    const chart=await readMeli('/catalog/charts/'+fields.SIZE_GRID_ID,access);
    if(!chart.ok)return json(req,{ok:false,message:'Tabela de medidas não disponível.'},422);
    const c=chart.data;
    const normalize=(x:any)=>String(x??'').toLowerCase().replace(/[^a-z0-9]/g,'').replace(/br$/,'');
    const domain=String(cat.data?.settings?.catalog_domain||'').replace(/^MLB-/,'');
    const rowMatches=Array.isArray(c.rows)&&c.rows.some((r:any)=>String(r.id)===fields.SIZE_GRID_ROW_ID&&
      (r.attributes||[]).some((at:any)=>['SIZE','BR_SIZE','MANUFACTURER_SIZE',c.main_attribute_id].includes(at.id)&&
      (at.values||[]).some((value:any)=>normalize(value.name)===normalize(fields.SIZE))));
    const chartGender=(c.attributes||[]).find((at:any)=>at.id==='GENDER');
    const selectedGender=attributes.find((at:any)=>at.id==='GENDER');
    const genderMatches=!!chartGender&&!!selectedGender&&(chartGender.values||[]).some((g:any)=>(selectedGender.value_id&&String(g.id)===String(selectedGender.value_id))||normalize(g.name)===normalize(fields.GENDER));
    if((c.type==='SPECIFIC'&&Number(c.seller_id)!==Number(row.seller_id))||
      String(c.domain_id||'').replace(/^MLB-/,'')!==domain||!rowMatches||!genderMatches)
      return json(req,{ok:false,message:'Tabela incompatível com vendedor, domínio, gênero ou tamanho.'},422);
    for(const key of ['SIZE_GRID_ID','SIZE_GRID_ROW_ID']){
      if(!attributes.some((at:any)=>at.id===key))attributes.push({id:key,value_name:fields[key]});
    }
  }
  // Reconciliar os anúncios do vendedor ANTES do POST, sem assumir que rascunho é exclusivo.
  const search=await readMeli('/users/'+row.seller_id+'/items/search?limit=100&offset=0',access);
  if(!search.ok||!Array.isArray(search.data?.results)||Number(search.data?.paging?.total)>100)
    return json(req,{ok:false,message:'Não foi possível verificar a lista completa de anúncios para evitar duplicidade.'},502);
  for(const existingId of search.data.results){
    const r=await readMeli('/items/'+encodeURIComponent(existingId),access);
    if(!r.ok)return json(req,{ok:false,message:'Falha na verificação de duplicidade.'},502);
    const item=r.data;
    const sku=String((item.attributes||[]).find((x:any)=>x.id==='SELLER_SKU')?.value_name||item.seller_custom_field||'');
    const similar=String(item.family_name||item.title||'').toLowerCase();
    if(sku===variant.sku&&item.category_id===a.category_external_id||
      (a.bling_product_id==='16725286274'&&similar.includes('duzizo')&&similar.includes('body')))
      return json(req,{ok:false,message:'Anúncio existente detectado. Nenhuma duplicação será feita.',externalListingId:item.id},409);
  }
  const fees=await readMeli('/sites/MLB/listing_prices?'+new URLSearchParams({
    price:String(a.price),category_id:a.category_external_id,
    listing_type_id:'gold_special',currency_id:'BRL',shipping_mode:'me2'}).toString(),access);
  if(!fees.ok)return json(req,{ok:false,message:'Modalidade Clássico não pôde ser validada para este produto.',httpStatus:fees.status},422);
  const familyName=a.bling_product_id==='16725286274'
    ?'Conjunto Bebê Duzizo Body Shorts Faixa Canelado'
    :String(a.title||p.name||'').replace(/\s+(?:tam(?:anho)?\.?\s*)[0-9]+(?:[/.][0-9]+)?\s*$/i,'').trim().slice(0,60);
  if(familyName.length>Number(cat.data?.settings?.max_title_length||60))
    return json(req,{ok:false,message:'Nome da família excede o limite da categoria.'},422);
  // A condição deve ser coerente no item e na ficha técnica.
  const rawCondition=String(fields.ITEM_CONDITION||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();
  const chosen=rawCondition==='novo'||rawCondition==='new'||rawCondition==='2230284'?'new':
    rawCondition==='usado'||rawCondition==='used'||rawCondition==='2230581'?'used':
    rawCondition==='nao especificado'||rawCondition==='not_specified'?'not_specified':'';
  const sourceCondition=['new','used'].includes(String(p.condition))?String(p.condition):'';
  if(sourceCondition&&chosen&&chosen!=='not_specified'&&sourceCondition!==chosen)
    return json(req,{ok:false,message:'Condição informada diverge da condição confirmada no Bling.'},422);
  const condition=sourceCondition||chosen||'not_specified';
  if(!cat.data?.settings?.item_conditions?.includes(condition))
    return json(req,{ok:false,message:'Condição cadastrada não é aceita pela categoria.'},422);
  const shippingPrefs=await readMeli('/users/'+Number(row.seller_id)+'/shipping_preferences',access);
  if(!shippingPrefs.ok||!shippingPrefs.data?.modes?.includes('me2'))
    return json(req,{ok:false,message:'Mercado Envios 2 não confirmado para esta conta.'},422);
  const me2Logistics=(shippingPrefs.data?.logistics||[]).find((l:any)=>l.mode==='me2');
  const defaultLogistic=(me2Logistics?.types||[]).find((l:any)=>l.default===true);
  if(!defaultLogistic?.type||!['drop_off','cross_docking','xd_drop_off'].includes(defaultLogistic.type))
    return json(req,{ok:false,message:'Modalidade de postagem padrão do vendedor não confirmada.'},422);
  const payload={family_name:familyName,category_id:a.category_external_id,price:Number(a.price),
    currency_id:'BRL',available_quantity:qty,buying_mode:'buy_it_now',listing_type_id:'gold_special',
    condition,pictures:a.images.map((url:string)=>({source:url})),attributes,
    shipping:{mode:'me2',logistic_type:defaultLogistic.type,free_shipping:false,local_pick_up:false}};
  // Consult the official product-specific shipping eligibility before listing validation.
  const domainId=String(cat.data?.settings?.catalog_domain||'');
  const categoryShipping=await readMeli('/categories/'+a.category_external_id+'/shipping_preferences',access);
  const shippingAttributes=await readMeli('/catalog_domain/'+encodeURIComponent(domainId)+'/shipping_attributes',access);
  const eligibility=await fetch(BASE+'/users/'+Number(row.seller_id)+'/shipping_modes',{
    method:'POST',headers:{Authorization:'Bearer '+access,'Content-Type':'application/json',Accept:'application/json','x-multichannel':'true','X-Format-New':'true'},
    body:JSON.stringify({site_id:'MLB',seller_id:Number(row.seller_id),title:familyName,item_price:Number(a.price),item_currency:'BRL',category_id:a.category_external_id,channels:[{id:'marketplace'}],catalog:{domain_id:domainId,attributes},sale_terms:[],listing_type_id:'gold_special',buying_mode:'buy_it_now',condition,new_format:true,verbose:true}),
    signal:AbortSignal.timeout(15000)
  });
  const eligibilityData=await eligibility.json().catch(()=>({}));
  const shippingDiagnostic={category:categoryShipping.ok?categoryShipping.data:{httpStatus:categoryShipping.status},domainAttributes:shippingAttributes.ok?shippingAttributes.data:{httpStatus:shippingAttributes.status},eligibilityStatus:eligibility.status,eligibility:eligibilityData};
  if(preview&&body?.action==='validate_listing'){
    // Return diagnostics along with any validator failure; no publication takes place.
    (payload as any).channels=['marketplace'];
  }else{(payload as any).channels=['marketplace'];}
  // Official validation does not create a listing. Never spend a POST on an invalid payload.
  let validation:any;
  try{validation=await writeMeli('/items/validate',access,payload,'POST');}
  catch{return json(req,{ok:false,published:false,message:'Validador oficial indisponível; nenhum anúncio enviado.'},502);}
  // The marketplace documented warning 4053 means solely that ME1 is not
  // enabled. It is non-blocking when the exact item is eligible for ME2.
  // Fail closed for any other cause, missing type, or failed eligibility.
  const eligibleMe2=eligibility.ok&&Array.isArray(eligibilityData?.channels?.marketplace?.available_modes)&&
    eligibilityData.channels.marketplace.available_modes.some((m:any)=>m.mode==='me2'&&
      Array.isArray(m.logistic_types)&&m.logistic_types.some((l:any)=>l.type===defaultLogistic.type&&
        l.default===true&&l.attributes?.adoption==='not_required'&&l.attributes?.dimensions==='clear'&&
        l.attributes?.free_shipping!=='mandatory'));
  const warningOnly=validation.httpStatus===400&&eligibleMe2&&
    Array.isArray(validation.causes)&&validation.causes.length===1&&
    validation.causes[0].type==='warning'&&validation.causes[0].cause_id===4053&&
    validation.causes[0].code==='shipping.lost_me1_by_user';
  if(!validation.ok&&!warningOnly)return json(req,{ok:false,published:false,stage:'official_validation',message:'Mercado Livre rejeitou a validação prévia.',validation,shippingDiagnostic},422);
  if(warningOnly)validation={...validation,ok:true,warningOnly:true,shippingVerified:true};
  if(preview)return json(req,{ok:true,published:false,validated:true,listingId:id,sku:variant.sku,quantity:qty,payload,validation,message:'Validação concluída; nenhum anúncio foi publicado.'});
  // Consume the creation quota only after all local and official validation succeeds.
  const {data:creationAllowed,error:creationLimitError}=await db.rpc('rl_check_and_increment',{
    p_bucket:'meli-create:'+adminId,p_limit:10,p_window_seconds:3600
  });
  if(creationLimitError||creationAllowed!==true)return json(req,{ok:false,published:false,
    message:'Limite de segurança para publicações atingido.',retryAfterSeconds:Math.max(1,3600-Math.floor(Date.now()/1000)%3600)},429);
  const {data:claimed,error:ce}=await db.from('store_marketplace_listings')
    .update({status:'blocked',last_error:'Publicação iniciada; não repetir sem reconciliação.'})
    .eq('id',a.id).eq('status',a.status).is('external_listing_id',null).select('id').maybeSingle();
  if(ce||!claimed)return json(req,{ok:false,message:'Publicação concorrente detectada.'},409);
  let creation:any;
  try{
    const response=await fetch(BASE+'/items',{method:'POST',headers:{
      Authorization:'Bearer '+access,'Content-Type':'application/json',Accept:'application/json'
    },body:JSON.stringify(payload),signal:AbortSignal.timeout(25000)});
    const result=await response.json().catch(()=>({}));
    if(!response.ok){
      const detail=String(result.message||result.error||'Publicação rejeitada').slice(0,250);
      if(response.status<500&&response.status!==408&&response.status!==429){
        await db.from('store_marketplace_listings').update({status:'error',last_error:detail}).eq('id',a.id).eq('status','blocked');
      }
      return json(req,{ok:false,published:false,message:'Mercado Livre não aceitou o anúncio.',
        httpStatus:response.status,detail,causes:Array.isArray(result.cause)?
        result.cause.slice(0,10).map((v:any)=>({code:v.code,message:v.message})):[]},502);
    }
    creation=result;
  }catch{
    return json(req,{ok:false,published:false,uncertain:true,
      message:'Resposta interrompida; anúncio bloqueado contra novo POST até reconciliação.'},502);
  }
  const mlb=String(creation?.id||'');
  if(!/^MLB\d{8,16}$/.test(mlb))
    return json(req,{ok:false,published:false,uncertain:true,
      message:'Criação sem ID verificável; não repetir o envio.'},502);
  let check:any;
  try{check=await readMeli('/items/'+mlb,access);}catch{check={ok:false};}
  if(!check.ok||Number(check.data?.seller_id)!==Number(row.seller_id)){
    await db.from('store_marketplace_listings').update({external_listing_id:mlb,
      last_error:'ID recebido, verificação da API pendente; não publicar novamente.'}).eq('id',a.id);
    return json(req,{ok:false,published:false,externalListingId:mlb,verificationPending:true,
      message:'ID MLB recebido, confirmação remota ainda pendente.'},202);
  }
  let descriptionApplied=false;
  if(a.description&&String(a.description).trim().length>20){
    try{const r=await writeMeli('/items/'+mlb+'/description',access,
      {plain_text:String(a.description).trim()},'POST');descriptionApplied=r.ok;}catch{}
  }
  const remote=check.data;
  const remoteStatus=String(remote.status||'');
  const family=await verifyListingFamily(remote,access);
  const remoteSku=String((remote.attributes||[]).find((x:any)=>x.id==='SELLER_SKU')?.value_name||remote.seller_custom_field||'');
  const skuVerified=remoteSku===variant.sku;
  const stockVerified=Number(remote.available_quantity)===qty;
  const priceVerified=Number(remote.price)===Number(a.price);
  const {error:se}=await db.from('store_marketplace_listings').update({
    status:'published',external_listing_id:mlb,external_url:remote.permalink||null,
    published_at:new Date().toISOString(),
    last_error:remoteStatus!=='active'?'Situação remota: '+remoteStatus:
      !family.verified?'Família remota ainda não confirmada; não repetir publicação.':
      !skuVerified||!stockVerified||!priceVerified?'Divergência remota de SKU, estoque ou preço; revisar.':
      descriptionApplied?null:'Descrição do anúncio deve ser revisada.'
  }).eq('id',a.id).eq('status','blocked');
  if(se)return json(req,{ok:false,published:false,externalListingId:mlb,
    message:'Publicação criada, mas a gravação local falhou. Não repetir o envio.'},502);
  return json(req,{ok:true,published:true,active:remoteStatus==='active',
    remoteStatus,externalListingId:mlb,externalUrl:remote.permalink||null,
    price:remote.price,availableQuantity:remote.available_quantity,
    family,skuVerified,stockVerified,priceVerified,
    descriptionApplied,message:remoteStatus==='active'?
      'Publicado e confirmado ativo no Mercado Livre.':'Criado no Mercado Livre, mas ainda não está ativo.'});
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
    let publicationDiagnostics:any=null;
    if(row){
      try{
        const access=await usableToken(row);
        const [owner,category,attributes,downgrades]=await Promise.all([
          readMeli('/users/me',access),
          readMeli('/categories/MLB28130',access),
          readMeli('/categories/MLB28130/attributes',access),
          readMeli('/items/MLB5529252361/available_downgrades',access)
        ]);
        const attrs=attributes.ok&&Array.isArray(attributes.data)?attributes.data:[];
        const liveBody=await readMeli('/items/MLB5529252361',access);
        let redFamily:any=null;
        if(liveBody.ok&&Number(liveBody.data?.seller_id)===Number(row.seller_id)){
          const red=liveBody.data;
          const upId=String(red.user_product_id||'');
          const userProduct=upId?await readMeli('/user-products/'+encodeURIComponent(upId),access):{ok:false,status:0};
          const familyId=String(userProduct.ok?userProduct.data?.family_id||'':'');
          const family=familyId?await readMeli('/sites/MLB/user-products-families/'+encodeURIComponent(familyId),access):{ok:false,status:0};
          const familyStructure=familyId?await readMeli('/user-products-families/'+encodeURIComponent(familyId),access):{ok:false,status:0};
          const members=familyId?await readMeli('/user-products-families/'+encodeURIComponent(familyId)+'/user-products',access):{ok:false,status:0};
          const categoryAttributes=attributes.ok&&Array.isArray(attributes.data)?attributes.data:[];
          redFamily={
            redItemId:red.id,userProductId:upId,familyId:familyId||null,
            familyName:red.family_name||null,domainId:red.domain_id||null,
            condition:red.condition,status:red.status,categoryId:red.category_id,
            listingTypeId:red.listing_type_id,sellerSku:(red.attributes||[]).find((x:any)=>x.id==='SELLER_SKU')?.value_name||null,
            familyHttpStatus:family.ok?200:family.status,
            familyNameFromApi:family.ok?family.data?.family_name||family.data?.name:null,
            familyResponse:family.ok?{id:family.data?.id,domain_id:family.data?.domain_id,
              attributes:family.data?.attributes,variation_attributes:family.data?.variation_attributes}:null,
            familyMembers:members.ok?members.data?.user_products_ids||members.data:null,
            familyStructureStatus:familyStructure.ok?200:familyStructure.status,
            familyStructure:familyStructure.ok?{family_id:familyStructure.data?.family_id,family_name:familyStructure.data?.family_name,
              child_attributes_ids:familyStructure.data?.child_attributes_ids,attributes:familyStructure.data?.attributes,
              custom_attributes_names:familyStructure.data?.custom_attributes_names}:null,
            familyMembersStatus:members.ok?200:members.status,
            variationAttributes:categoryAttributes.filter((x:any)=>x.id==='COLOR'||x.id==='SIZE'||x.id==='BRAND'||x.id==='MODEL'||x.id==='ITEM_CONDITION').map((x:any)=>({
              id:x.id,name:x.name,tags:x.tags,
              values:(x.values||[]).filter((v:any)=>/verde|rn|^p$|new|novo/i.test(String(v.name||''))).slice(0,16)
            }))
          };
        }
        const greenLive=await readMeli('/items/MLB7960343796',access);
        const greenProd=await readMeli('/user-products/MLBU5850814980',access);
        const redProd=await readMeli('/user-products/MLBU5797635001',access);
        const greenStructure=await readMeli('/user-products-families/82386193060690',access);
        const greenFamilyDiagnostic={
          item:greenLive.ok?{
            id:greenLive.data?.id,status:greenLive.data?.status,
            condition:greenLive.data?.condition,family_name:greenLive.data?.family_name,
            user_product_id:greenLive.data?.user_product_id,
            domain_id:greenLive.data?.domain_id,
            attrs:(greenLive.data?.attributes||[]).map((a:any)=>({id:a.id,value_id:a.value_id,value_name:a.value_name})),
            pictures:(greenLive.data?.pictures||[]).map((p:any)=>p.id)
          }:{httpStatus:greenLive.status},
          greenUP:greenProd.ok?{
            id:greenProd.data?.id,name:greenProd.data?.name,
            family_name:greenProd.data?.family_name,family_id:greenProd.data?.family_id,
            domain_id:greenProd.data?.domain_id,
            attrs:greenProd.data?.attributes,site_id:greenProd.data?.site_id
          }:{httpStatus:greenProd.status},
          redUP:redProd.ok?{
            id:redProd.data?.id,name:redProd.data?.name,
            family_name:redProd.data?.family_name,family_id:redProd.data?.family_id,
            domain_id:redProd.data?.domain_id,
            attrs:redProd.data?.attributes,site_id:redProd.data?.site_id
          }:{httpStatus:redProd.status},
          greenStructure:greenStructure.ok?{
            family_id:greenStructure.data?.family_id,
            family_name:greenStructure.data?.family_name,
            attributes:greenStructure.data?.attributes,
            child_attributes_ids:greenStructure.data?.child_attributes_ids
          }:{httpStatus:greenStructure.status}
        };
        publicationDiagnostics={
          greenFamilyDiagnostic,
          redFamily,
          bodyListingDowngrades:downgrades.ok&&Array.isArray(downgrades.data)?downgrades.data.map((x:any)=>({id:x.id,name:x.name})):null,
          bodyListingDowngradesHttpStatus:downgrades.ok?200:downgrades.status,
          sellerTags:owner.ok?(Array.isArray(owner.data?.tags)?owner.data.tags:[]):null,
          siteId:owner.ok?owner.data?.site_id:null,
          category:{
            id:'MLB28130',exists:category.ok,
            name:category.ok?category.data?.name:null,
            path:category.ok?category.data?.path_from_root?.map((v:any)=>v.name):null,
            settings:category.ok?category.data?.settings:null,
            domainId:category.ok?category.data?.settings?.domain_id:null,
            httpStatus:category.ok?null:category.status
          },
          attributesHttpStatus:attributes.ok?200:attributes.status,
          mandatoryAttributes:attrs.filter((v:any)=>v.tags?.required||v.tags?.catalog_required||v.tags?.product_required)
            .map((v:any)=>({id:v.id,name:v.name,type:v.value_type,tags:v.tags,values:(v.values||[]).slice(0,8)})).slice(0,50)
        };
      }catch{publicationDiagnostics={error:'Falha ao consultar diagnostico de publicacao na API.'};}
    }
    return json(req,{ok:true,configured:true,connected:!!row,
      sellerNickname:row?.seller_nickname||null,
      lastCheckedAt:row?.updated_at||null,
      expiresAt:row?.expires_at||null,
      publicationDiagnostics});
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
  if(action==='publish_listing'||action==='validate_listing')return publishAnarosaListing(req,adminId,body);
  if(['category_schema','chart_schema','chart_detail','chart_template','chart_search'].includes(action))return meliCatalogMetadata(req,adminId,body,action);
  if(action==='chart_prepare'||action==='chart_create')return chartCreation(req,adminId,body,action);
  if(action==='finalize_separate_colors')return finalizeSeparatedDuzizoListings(req,adminId,body);
  if(action==='replace_red_gallery')return replaceDuzizoRedGallery(req,adminId,body);
  if(action==='replace_green_gallery')return replaceDuzizoGreenGallery(req,adminId,body);
  if(action==='ogochi_probe')return probeOgochiGallery(req,adminId,body);
  if(action==='anarosa_growth_audit')return auditAnarosaSalesGrowth(req,adminId,body);
  if(action==='ogochi_family_diagnose')return diagnoseOgochiUserProducts(req,adminId,body);
  if(action==='ogochi_transform_probe')return probeOgochiTransform(req,adminId,body);
  if(action==='ogochi_gallery_prepare')return prepareRealOgochiGallery(req,adminId,body);
  if(action==='ogochi_gallery_publish')return publishRealOgochiGallery(req,adminId,body);
  if(action==='diagnose_green_gallery')return diagnoseDuzizoGreenImageFiles(req,adminId,body);
  if(action==='diagnose_red_gallery')return diagnoseRedGalleryImage(req,adminId,body);
  if(action==='link_green_family')return linkDuzizoGreenVariant(req,adminId,body);
  if(action==='merge_green_family')return mergeDuzizoFamily(req,adminId,body);
  if(action==='correct_new_condition')return correctNewCondition(req,adminId,body);
  if(!['list','detail','verify','fees'].includes(action))return json(req,{ok:false,message:'Operação desconhecida.'},400);
  const row=await connection();
  if(!row)return json(req,{ok:false,connected:false,message:'Conecte primeiro a conta Mercado Livre na Gestão.'},409);
  let access:string;
  try{access=await usableToken(row);}catch{return json(req,{ok:false,message:'Não foi possível renovar a autorização Mercado Livre. Tente novamente ou reconecte a conta.'},503);}
  if(action==='fees'){
    const id=String(body.id||'').trim().toUpperCase();
    if(!/^MLB\d{8,16}$/.test(id))return json(req,{ok:false,message:'ID de anúncio inválido.'},400);
    let item:any;
    try {item=await readMeli('/items/'+id,access);} catch {item={ok:false};}
    if(!item.ok||Number(item.data?.seller_id)!==Number(row.seller_id))
      return json(req,{ok:false,message:'Anúncio não encontrado na conta conectada.'},404);
    const it=item.data;
    const base='/sites/MLB/listing_prices';
    const quotes:any[]=[];
    for(const typ of ['gold_special','gold_pro']){
      const qs=new URLSearchParams({
        price:String(it.price),category_id:String(it.category_id),listing_type_id:typ,
        currency_id:'BRL',shipping_mode:String(it.shipping?.mode||'me2')
      });
      if(it.shipping?.logistic_type)qs.set('logistic_type',String(it.shipping.logistic_type));
      let fetched:any;
      try{fetched=await readMeli(base+'?'+qs.toString(),access);}
      catch{fetched={ok:false,status:0};}
      if(!fetched.ok){quotes.push({type:typ,available:false,httpStatus:fetched.status||null});continue;}
      const val=Array.isArray(fetched.data)?fetched.data.find((v:any)=>v.listing_type_id===typ):fetched.data;
      if(!val || val.listing_type_id!==typ){quotes.push({type:typ,available:false});continue;}
      quotes.push({type:typ,available:true,name:val.listing_type_name,
        saleFee:Number(val.sale_fee_amount),feeDetails:{
          fixedFee:val.sale_fee_details?.fixed_fee??null,
          percentageFee:val.sale_fee_details?.percentage_fee??null,
          financingFee:val.sale_fee_details?.financing_add_on_fee??null,
        },
        exposure:val.listing_exposure||null
      });
    }
    return json(req,{ok:true,source:'Mercado Livre listing_prices API',
      itemId:id,currentListingType:it.listing_type_id,price:it.price,currency:'BRL',
      categoryId:it.category_id,shippingMode:it.shipping?.mode||null,logisticType:it.shipping?.logistic_type||null,
      quotes,notice:'A tarifa exibida é cotação da API para modalidade, categoria e logística informadas; custos de frete, impostos e outras cobranças podem ser adicionais. Não alterou o anúncio.'});
  }
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
  const family=await verifyListingFamily(d,access);
  return json(req,{ok:true,source:'Mercado Livre API',family,item:{
      id:d.id,title:d.title,price:d.price,currency_id:d.currency_id,original_price:d.original_price,
      user_product_id:family.userProductId,family_id:family.familyId,family_name:d.family_name||null,
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
