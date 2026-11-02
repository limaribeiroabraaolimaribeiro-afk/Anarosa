/** Mercado Livre oficial. Nunca enviar credenciais/token para frontend ou MCP. */
import type { Db } from './supabase.ts';
const API = 'https://api.mercadolibre.com';
export function mlConfig() {
  const clientId = Deno.env.get('ML_CLIENT_ID') || '';
  const clientSecret = Deno.env.get('ML_CLIENT_SECRET') || '';
  const redirectUri = Deno.env.get('ML_REDIRECT_URI') || '';
  if (!clientId || !clientSecret || !redirectUri || !redirectUri.startsWith('https://')) {
    throw new Error('Mercado Livre não configurado: cadastrar App ID, Secret e URL de retorno no Supabase.');
  }
  return { clientId, clientSecret, redirectUri };
}
export function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/,'');
}
export async function sha256(input: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)))]
    .map(v=>v.toString(16).padStart(2,'0')).join('');
}
export async function challenge(verifier: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}
export async function mlTokenExchange(body: Record<string,string>): Promise<Record<string,unknown>> {
  const cfg=mlConfig();
  const form=new URLSearchParams({...body,client_id:cfg.clientId,client_secret:cfg.clientSecret});
  const r=await fetch(API+'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:form,signal:AbortSignal.timeout(14000)});
  const json=await r.json().catch(()=>({})) as Record<string,unknown>;
  if (!r.ok || typeof json.access_token!=='string' || typeof json.refresh_token!=='string') {
    throw new Error('Falha na autorização/token do Mercado Livre (HTTP '+r.status+').');
  }
  return json;
}
export async function saveMlTokens(db:Db,data:Record<string,unknown>,nickname:string):Promise<void> {
  const user=Number(data.user_id), expires=Number(data.expires_in);
  if (!Number.isSafeInteger(user)||user<=0||!Number.isFinite(expires)||expires<=0) {
    throw new Error('Resposta de autorização do Mercado Livre inválida.');
  }
  const row={id:1,ml_user_id:user,nickname:nickname.slice(0,120),
    access_token:data.access_token,refresh_token:data.refresh_token,
    token_expires_at:new Date(Date.now()+expires*1000).toISOString(),
    scopes:String(data.scope||'').slice(0,200),refresh_lock_until:null,updated_at:new Date().toISOString()};
  const {error}=await db.from('ml_seller_credentials').upsert(row,{onConflict:'id'});
  if(error)throw new Error('Não foi possível salvar a conexão Mercado Livre.');
}
export async function mlAccessToken(db:Db):Promise<{token:string;sellerId:number}> {
  const {data,error}=await db.from('ml_seller_credentials').select('*').eq('id',1).maybeSingle();
  if(error||!data)throw new Error('Conta Mercado Livre ainda não conectada.');
  if(new Date(data.token_expires_at).getTime()>Date.now()+90000) {
    return {token:data.access_token,sellerId:Number(data.ml_user_id)};
  }
  const until=new Date(Date.now()+40000).toISOString();
  const lock=await db.from('ml_seller_credentials').update({refresh_lock_until:until}).eq('id',1)
    .eq('refresh_token',data.refresh_token)
    .or('refresh_lock_until.is.null,refresh_lock_until.lt.'+new Date().toISOString()).select('id').maybeSingle();
  if(lock.error||!lock.data)throw new Error('Token do Mercado Livre em renovação. Tente novamente.');
  try {
    const cfg=mlConfig();
    const renewed=await mlTokenExchange({grant_type:'refresh_token',refresh_token:data.refresh_token});
    const expires=Number(renewed.expires_in);
    const update=await db.from('ml_seller_credentials').update({
      access_token:renewed.access_token,refresh_token:renewed.refresh_token,
      token_expires_at:new Date(Date.now()+expires*1000).toISOString(),
      refresh_lock_until:null,updated_at:new Date().toISOString(),
    }).eq('id',1).eq('refresh_token',data.refresh_token).select('id').maybeSingle();
    if(update.error||!update.data)throw new Error('Conflito ao renovar token do Mercado Livre.');
    return {token:String(renewed.access_token),sellerId:Number(data.ml_user_id)};
  } catch (error) {
    await db.from('ml_seller_credentials').update({refresh_lock_until:null})
      .eq('id',1).eq('refresh_token',data.refresh_token);
    throw error;
  }
}
export async function mlApi(token:string,path:string,method:'GET'|'PUT'='GET',body?:unknown):Promise<Record<string,unknown>> {
  if(!/^\/(?:items\/MLB[0-9]{8,16}(?:\/description(?:\?api_version=2)?)?|users\/me)$/.test(path)) {
    throw new Error('Endpoint Mercado Livre não permitido.');
  }
  const res=await fetch(API+path,{method,headers:{Authorization:'Bearer '+token,Accept:'application/json',
    ...(body===undefined?{}:{'Content-Type':'application/json'})},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
  if(!res.ok)throw new Error('Mercado Livre recusou a operação (HTTP '+res.status+').');
  return await res.json().catch(()=>({})) as Record<string,unknown>;
}
