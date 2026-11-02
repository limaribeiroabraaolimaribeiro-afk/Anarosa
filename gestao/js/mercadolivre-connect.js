/* Gestão ANAROSA — conexão direta com Mercado Livre */
(function(){
  'use strict';
  const $=(selector)=>document.querySelector(selector);
  const status=()=> $('[data-meli-status]');
  const button=()=> $('[data-meli-connect]');
  const refreshButton=()=> $('[data-meli-refresh]');
  let callbackOutcome=new URLSearchParams(location.search).get('meli_oauth');
  const callbackMessages={
    expired:'A autorização anterior expirou ou já foi utilizada. Clique em Conectar Mercado Livre para iniciar uma nova autorização e conclua em até 10 minutos.',
    denied:'A conexão não foi autorizada no Mercado Livre. Você pode tentar novamente.',
    error:'A autorização não foi concluída. Confira a conta e tente novamente.'
  };
  if(callbackOutcome){
    const url=new URL(location.href);
    url.searchParams.delete('meli_oauth');
    history.replaceState(history.state,'',url.toString());
  }
  const result=()=> $('[data-meli-check-result]');
  let inFlight=false;
  async function check({live=false}={}){
    const el=status(),btn=button(),refresh=refreshButton(),feedback=result();
    if(!el || !window.GestaoApi?.mercadoLivreControl)return;
    if(inFlight)return;
    inFlight=true;
    if(refresh){
      refresh.disabled=true;
      refresh.textContent=live?'Verificando...':'Consultando...';
      refresh.setAttribute('aria-busy','true');
    }
    if(live && feedback)feedback.textContent='Consultando a identidade e os anúncios na API oficial do Mercado Livre...';
    try{
      const s=await window.GestaoApi.mercadoLivreControl(live?'verify':'status');
      if(s.connected){
        el.textContent='Conectado à conta '+(s.sellerNickname||'Mercado Livre')+'.';
        if(btn)btn.textContent='Reconectar Mercado Livre';
      }else{
        el.textContent=callbackMessages[callbackOutcome] || 'Conta Mercado Livre ainda não autorizada. Clique em Conectar Mercado Livre.';
        if(btn)btn.textContent='Conectar Mercado Livre';
      }
      if(live&&feedback){
        if(s.verified){
          const hour=new Date(s.checkedAt||Date.now()).toLocaleTimeString('pt-BR');
          const count=Number.isInteger(s.listingsTotal)?' Total de anúncios: '+s.listingsTotal+'.':'';
          feedback.textContent='✓ Verificação concluída às '+hour+': API oficial respondeu com sucesso. Conta: '+s.sellerNickname+'.'+count;
        }else{
          feedback.textContent=s.connected?'A autorização está salva, mas ainda não foi possível confirmar o acesso aos anúncios.':'Conta ainda não autorizada.';
        }
      }
    }catch(e){
      const message=e?.message || 'falha de rede';
      if(live&&feedback)feedback.textContent='Falha na verificação da API: '+message;
      else el.textContent='Não foi possível verificar a conexão: '+message+'.';
    }finally{
      inFlight=false;
      if(refresh){
        refresh.disabled=false;
        refresh.textContent='Verificar conexão';
        refresh.removeAttribute('aria-busy');
      }
    }
  }
  document.addEventListener('click',async(e)=>{
    if(e.target instanceof Element && e.target.closest('[data-meli-refresh]')){await check({live:true});return;}
    const b=e.target instanceof Element ? e.target.closest('[data-meli-connect]') : null;
    if(!b)return;
    b.disabled=true;
    callbackOutcome=null;
    if(status())status().textContent='Preparando autorização segura...';
    try{
      const r=await window.GestaoApi.mercadoLivreControl('start');
      const u=new URL(r.authorizationUrl);
      if(u.origin!=='https://auth.mercadolivre.com.br')throw new Error('URL de autorização não reconhecida.');
      location.assign(u.toString());
    }catch(err){
      if(status())status().textContent='Conexão não iniciada: '+(err?.message||'erro inesperado');
      b.disabled=false;
    }
  });
  window.addEventListener('hashchange',()=>{if(location.hash.includes('/integracao'))check();});
  document.addEventListener('DOMContentLoaded',()=>{if(location.hash.includes('/integracao'))setTimeout(check,200);});
})();
