import assert from 'node:assert/strict';
import { corsHeaders, handlePreflight, resolveAllowedOrigin } from '../_shared/cors.ts';

const LIVE = ['https://www.lojaanarosa.com.br', 'https://lojaanarosa.com.br'];

Deno.test('CORS: loja publicada aceita www e domínio principal mesmo sem configurar STOREFRONT_URL', () => {
  const prev = Deno.env.get('STOREFRONT_URL');
  Deno.env.set('STOREFRONT_URL', 'http://localhost:5500');
  try {
    for (const origin of LIVE) {
      assert.equal(resolveAllowedOrigin(origin), origin);
      const req = new Request('https://example.supabase.co/functions/v1/admin-dashboard-summary', {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'authorization,apikey',
        },
      });
      const preflight = handlePreflight(req);
      assert.equal(preflight?.status, 204);
      assert.equal(preflight?.headers.get('Access-Control-Allow-Origin'), origin);
      assert.match(preflight?.headers.get('Access-Control-Allow-Headers') ?? '', /authorization/);
      assert.equal(corsHeaders(new Request(req.url, { headers: { Origin: origin } }))['Access-Control-Allow-Origin'], origin);
    }
  } finally {
    if (prev == null) Deno.env.delete('STOREFRONT_URL');
    else Deno.env.set('STOREFRONT_URL', prev);
  }
});

Deno.test('CORS: origem de terceiros ou subdomínio não autorizado continuam bloqueados', () => {
  for (const origin of ['https://evil.example.com', 'https://lojaanarosa.com.br.evil.example', 'http://www.lojaanarosa.com.br']) {
    assert.equal(resolveAllowedOrigin(origin), null);
    assert.equal(corsHeaders(new Request('https://example.supabase.co', { headers: { Origin: origin } }))['Access-Control-Allow-Origin'], undefined);
  }
});
