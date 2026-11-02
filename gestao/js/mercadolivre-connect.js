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
  async function check(){
    const el=status(),btn=button();
    if(!el || !window.GestaoApi?.mercadoLivreControl)return;
    try{
      const s=await window.GestaoApi.mercadoLivreControl('status');
      if(s.connected){
        el.textContent='Conectado à conta '+(s.sellerNickname||'Mercado Livre')+'. As ferramentas de consulta direta do MCP estão habilitadas.';
        if(btn)btn.textContent='Reconectar Mercado Livre';
      }else{
        el.textContent=callbackMessages[callbackOutcome] || 'Conta Mercado Livre ainda não autorizada. Clique em Conectar Mercado Livre.';
        if(btn)btn.textContent='Conectar Mercado Livre';
      }
    }catch(e){
      el.textContent='Não foi possível verificar a conexão: '+(e?.message || 'falha de rede')+'.';
    }
  }
  document.addEventListener('click',async(e)=>{
    if(e.target.closest('[data-meli-refresh]')){await check();return;}
    const b=e.target.closest('[data-meli-connect]');
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
