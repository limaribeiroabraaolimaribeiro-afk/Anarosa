import assert from 'node:assert/strict';
import {
  authorizeMl, makeMlChallenge, ML_CALLBACK_URI, mlExchange, mlSeller,
} from '../_shared/mercadolivre-oauth.ts';

Deno.test('Mercado Livre: autorização oficial tem state, redirect fixo e PKCE S256',async()=>{
  const {verifier,challenge}=await makeMlChallenge();
  assert(verifier.length>=43 && challenge.length>=43);
  const url=new URL(authorizeMl('1234567890123456','A'.repeat(43),challenge));
  assert.equal(url.origin,'https://auth.mercadolivre.com.br');
  assert.equal(url.searchParams.get('response_type'),'code');
  assert.equal(url.searchParams.get('redirect_uri'),ML_CALLBACK_URI);
  assert.equal(url.searchParams.get('code_challenge_method'),'S256');
  assert.equal(url.searchParams.get('state'),'A'.repeat(43));
  assert.throws(()=>authorizeMl('invalido','A'.repeat(43),challenge));
});
Deno.test('Mercado Livre: refresh usa form-urlencoded e valida token',async()=>{
  const token=await mlExchange({clientId:'123456',clientSecret:'secret',expectedSellerId:''},
  {grant_type:'refresh_token',refresh_token:'hidden'}, async (_url,init)=>{
    assert.equal(init?.method,'POST');
    assert.equal(new Headers(init?.headers).get('content-type'),'application/x-www-form-urlencoded');
    const body=init?.body as URLSearchParams;
    assert.equal(body.get('client_secret'),'secret');
    assert.equal(body.get('refresh_token'),'hidden');
    return new Response(JSON.stringify({
      access_token:'access',refresh_token:'rotated',user_id:123,
      scope:'read offline_access',expires_in:21600,
    }),{status:200});
  });
  assert.equal(token.refresh_token,'rotated');
  assert.equal(token.user_id,'123');
  await assert.rejects(()=>mlExchange({clientId:'123456',clientSecret:'s',expectedSellerId:''},
  {grant_type:'authorization_code'},async()=>new Response('{}',{status:401})),/ml_oauth_exchange_failed_401/);
});
Deno.test('Mercado Livre: valida identidade do vendedor por users/me',async()=>{
  const u=await mlSeller('secret',async (_url,init)=>{
    assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer secret');
    return new Response(JSON.stringify({id:45985,nickname:'ANAROSA'}),{status:200});
  });
  assert.deepEqual(u,{id:'45985',nickname:'ANAROSA'});
});
