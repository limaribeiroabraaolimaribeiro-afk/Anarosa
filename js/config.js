/**
 * ANAROSA — configuração PÚBLICA do frontend.
 *
 * Este arquivo é publicado junto com o site: NUNCA coloque aqui
 * client_secret, service_role, access_token ou refresh_token.
 *
 * catalogProvider:
 *   "mock"     → usa js/products.js
 *   "supabase" → lê o catálogo cacheado via Supabase
 */

window.ANAROSA_CONFIG = Object.assign(
  {
    catalogProvider: 'supabase',

    supabaseUrl: 'https://gpmbkptimjipqsayrvce.supabase.co',

    supabaseAnonKey: '',

    functionsBaseUrl: '',

    catalogCacheTtlMs: 60 * 1000,

    placeholderImage: 'assets/products/placeholder.svg',
  },

  window.ANAROSA_CONFIG || {}
);