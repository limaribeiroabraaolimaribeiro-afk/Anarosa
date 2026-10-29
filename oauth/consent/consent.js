(function(){
'use strict';
const byId=id=>document.getElementById(id);
const show=(id,value)=>byId(id).classList.toggle('hidden',!value);
const status=(s,err=false)=>{byId('status').textContent=s;byId('status').className=err?'error':'';};
const cfg=window.ANAROSA_CONFIG||{};
const id=new URLSearchParams(location.search).get('authorization_id');
if(!id||!/^[a-zA-Z0-9-]{8,140}$/.test(id)){status('Solicitação de autorização ausente ou inválida.',true);return;}
if(!window.supabase?.createClient||!cfg.supabaseUrl||!cfg.supabaseAnonKey){status('Autenticação não configurada neste ambiente.',true);return;}
const client=window.supabase.createClient(cfg.supabaseUrl,cfg.supabaseAnonKey,{
 auth:{persistSession:true,autoRefreshToken:true,storageKey:'anarosa-gestao-auth'}
});
async function checkAdmin(session){
 const r=await fetch(cfg.supabaseUrl+'/functions/v1/admin-products?limit=1',{
   headers:{'Authorization':'Bearer '+session.access_token,'apikey':cfg.supabaseAnonKey},
 });
 return r.ok;
}
async function start(){
 try{
  const {data:{session}}=await client.auth.getSession();
  if(!session){show('signin',true);show('consent',false);status('Entre com seu usuário da Gestão ANAROSA para continuar.');return;}
  if(!await checkAdmin(session)){status('A conta autenticada não possui permissão de administração da ANAROSA.',true);return;}
  const {data,error}=await client.auth.oauth.getAuthorizationDetails(id);
  if(error||!data)throw Error(error?.message||'Falha ao consultar o consentimento OAuth.');
  if(!('authorization_id' in data)){
    const next=new URL(data.redirect_url);
    if(next.protocol!=='https:')throw Error('Destino de redirecionamento inválido.');
    location.assign(next.href);return;
  }
  byId('client-name').textContent=data.client?.name||'Aplicativo conectado';
  byId('redirect').textContent=data.redirect_uri||'Não informado';
  byId('scopes').textContent=data.scope||'Solicitação de acesso à Gestão';
  status('Aprovação pendente. Confirme somente se reconhecer o aplicativo e o endereço de retorno.');
  show('signin',false);show('consent',true);
 }catch(err){status('Não foi possível preparar a autorização: '+String(err.message||err),true);}
}
async function decide(approve){
 const buttons=[byId('approve'),byId('deny')];buttons.forEach(x=>x.disabled=true);
 try{
  const result=approve ? await client.auth.oauth.approveAuthorization(id) : await client.auth.oauth.denyAuthorization(id);
  if(result.error)throw result.error;
  const destination=result.data?.redirect_url;
  if(destination){
   const next=new URL(destination);
   if(next.protocol!=='https:')throw Error('Destino de retorno inválido.');
   location.assign(next.href);
  }else status(approve?'Autorização confirmada. Retorne ao ChatGPT.':'Autorização cancelada.');
 }catch(e){status('Não foi possível concluir a decisão: '+String(e.message||e),true);}
 finally{buttons.forEach(x=>x.disabled=false);}
}
byId('login').addEventListener('click',async ()=>{
 const email=byId('email').value.trim(),password=byId('password').value;
 if(!email||!password){status('Informe e-mail e senha.',true);return;}
 byId('login').disabled=true;
 try{
  const {error}=await client.auth.signInWithPassword({email,password});
  if(error)throw error;
  byId('password').value='';
  await start();
 }catch{status('Não foi possível entrar. Confira suas credenciais.',true);}
 finally{byId('login').disabled=false;}
});
byId('approve').addEventListener('click',()=>decide(true));
byId('deny').addEventListener('click',()=>decide(false));
start();
})();