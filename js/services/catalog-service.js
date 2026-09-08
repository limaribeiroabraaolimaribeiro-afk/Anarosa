/**
 * ANAROSA — camada de acesso ao catálogo (CatalogService).
 *
 * A Home, os cards, a busca e o carrinho falam SOMENTE com esta camada.
 * Trocar `window.ANAROSA_CONFIG.catalogProvider` de "mock" para "supabase"
 * muda a origem dos dados sem reescrever a página.
 *
 * Providers:
 *   MockCatalogProvider     → js/products.js (fallback atual)
 *   SupabaseCatalogProvider → Edge Functions storefront-products / storefront-product
 *
 * Regra de fallback: em modo "supabase" NUNCA misturamos dados mock.
 * Se a API falhar, lançamos CatalogUnavailableError e a página mostra um
 * estado de erro amigável (um produto fictício jamais aparece como real).
 */
(function () {
  'use strict';

  const BADGE_TAGS = {
    novo: 'novo',
    'mais-vendido': 'mais-vendido',
    oferta: 'oferta',
  };

  class CatalogUnavailableError extends Error {
    constructor(message, cause) {
      super(message || 'Catálogo indisponível no momento.');
      this.name = 'CatalogUnavailableError';
      this.cause = cause;
    }
  }

  function formatPrice(value) {
    return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function makeInstallment(price, times = 6) {
    return `${times}x de ${formatPrice(price / times)} sem juros`;
  }

  /**
   * Converte o formato público da Storefront API no formato que a Home já
   * consome (mesmo shape de js/products.js).
   */
  function normalizePublicProduct(p, config) {
    const promotionalPrice = p.promotionalPrice != null ? Number(p.promotionalPrice) : null;
    const price = Number(p.price || 0);
    const activePrice = promotionalPrice != null ? promotionalPrice : price;
    const tags = Array.isArray(p.tags) ? p.tags : [];
    const images = Array.isArray(p.images) ? p.images.map((i) => (typeof i === 'string' ? i : i.url)).filter(Boolean) : [];
    const image = images[0] || config.placeholderImage;

    let badge = null;
    if (promotionalPrice != null && promotionalPrice < price) badge = 'oferta';
    for (const t of tags) if (BADGE_TAGS[t]) badge = BADGE_TAGS[t];

    const variants = Array.isArray(p.variants) ? p.variants : [];
    const sizes = [...new Set(variants.map((v) => v.size).filter(Boolean))];
    const colors = [...new Set(variants.map((v) => v.color).filter(Boolean))];

    return {
      id: p.id,
      blingId: p.blingId ?? null,
      sku: p.sku ?? null,
      name: p.name,
      slug: p.slug,
      category: p.category ? p.category.slug : null,
      categoryName: p.category ? p.category.name : null,
      description: p.description || p.shortDescription || '',
      image,
      images: images.length ? images : [image],
      price,
      promotionalPrice,
      installment: makeInstallment(activePrice),
      pixPrice: activePrice * 0.95,
      badge,
      variants: { sizes, colors, items: variants },
      stock: p.stock ?? null,
      available: p.available !== false,
      active: true,
      featured: tags.includes('novo') || tags.includes('destaque'),
      bestSeller: tags.includes('mais-vendido'),
      weeklyPick: tags.includes('escolha-da-semana'),
      tags,
      updatedAt: p.updatedAt || null,
    };
  }

  /* -----------------------------------------------------------------
     Provider: MOCK (js/products.js)
     ----------------------------------------------------------------- */
  class MockCatalogProvider {
    constructor() {
      this.name = 'mock';
    }
    _all() {
      const data = window.AnarosaData;
      return data && Array.isArray(data.PRODUCTS) ? data.PRODUCTS : [];
    }
    async getProducts() {
      return this._all().filter((p) => p.active !== false);
    }
    async getProductBySlug(slug) {
      return this._all().find((p) => p.slug === slug) || null;
    }
    async getProductsByCategory(category) {
      return this._all().filter((p) => p.category === category && p.active !== false);
    }
    async searchProducts(query) {
      const q = String(query || '').trim().toLowerCase();
      if (!q) return [];
      return this._all().filter((p) => p.name.toLowerCase().includes(q));
    }
  }

  /* -----------------------------------------------------------------
     Provider: SUPABASE (Edge Functions storefront-*)
     ----------------------------------------------------------------- */
  class SupabaseCatalogProvider {
    constructor(config) {
      this.name = 'supabase';
      this.config = config;
      const base = config.functionsBaseUrl || (config.supabaseUrl ? `${config.supabaseUrl.replace(/\/+$/, '')}/functions/v1` : '');
      this.baseUrl = base;
      this.cache = new Map();
      if (!this.baseUrl) {
        console.warn('[AnarosaCatalog] supabaseUrl/functionsBaseUrl não configurado; o catálogo real ficará indisponível.');
      }
    }

    _headers() {
      const h = { Accept: 'application/json' };
      if (this.config.supabaseAnonKey) {
        h.apikey = this.config.supabaseAnonKey;
        h.Authorization = `Bearer ${this.config.supabaseAnonKey}`;
      }
      return h;
    }

    async _fetchJson(path, params) {
      if (!this.baseUrl) throw new CatalogUnavailableError('Catálogo não configurado.');
      const url = new URL(`${this.baseUrl}/${path}`);
      for (const [k, v] of Object.entries(params || {})) {
        if (v != null && v !== '') url.searchParams.set(k, String(v));
      }
      const key = url.toString();
      const ttl = this.config.catalogCacheTtlMs || 0;
      const cached = this.cache.get(key);
      if (cached && Date.now() - cached.at < ttl) return cached.value;

      let res;
      try {
        res = await fetch(key, { headers: this._headers() });
      } catch (err) {
        throw new CatalogUnavailableError('Falha de rede ao carregar o catálogo.', err);
      }
      if (res.status === 404 && path === 'storefront-product') return null;
      if (!res.ok) throw new CatalogUnavailableError(`Catálogo respondeu ${res.status}.`);
      const json = await res.json().catch(() => null);
      if (!json || json.ok === false) throw new CatalogUnavailableError('Resposta inválida do catálogo.');
      this.cache.set(key, { at: Date.now(), value: json });
      return json;
    }

    async getProducts() {
      const json = await this._fetchJson('storefront-products', { limit: 200 });
      return (json.items || []).map((p) => normalizePublicProduct(p, this.config));
    }
    async getProductBySlug(slug) {
      const json = await this._fetchJson('storefront-product', { slug });
      return json && json.product ? normalizePublicProduct(json.product, this.config) : null;
    }
    async getProductsByCategory(category) {
      const json = await this._fetchJson('storefront-products', { category, limit: 200 });
      return (json.items || []).map((p) => normalizePublicProduct(p, this.config));
    }
    async searchProducts(query) {
      const q = String(query || '').trim();
      if (!q) return [];
      const json = await this._fetchJson('storefront-products', { q, limit: 100 });
      return (json.items || []).map((p) => normalizePublicProduct(p, this.config));
    }
  }

  /* -----------------------------------------------------------------
     CatalogService
     ----------------------------------------------------------------- */
  class CatalogService {
    constructor(provider) {
      this.provider = provider;
      this.mode = provider.name;
    }
    getProducts() {
      return this.provider.getProducts();
    }
    getProductBySlug(slug) {
      return this.provider.getProductBySlug(slug);
    }
    getProductsByCategory(category) {
      return this.provider.getProductsByCategory(category);
    }
    searchProducts(query) {
      return this.provider.searchProducts(query);
    }

    /**
     * Seções da Home. No modo real, se nenhum produto tiver tags de
     * curadoria, cada seção mostra o catálogo completo (nunca fica vazia).
     */
    getHomeSections(products) {
      const list = Array.isArray(products) ? products : [];
      const pick = (flag) => list.filter((p) => p[flag]);
      let featured = pick('featured');
      let bestSellers = pick('bestSeller');
      let weeklyPicks = pick('weeklyPick');
      if (this.mode !== 'mock') {
        if (!featured.length) featured = list.slice(0, 12);
        if (!bestSellers.length) bestSellers = list.slice(0, 12);
        if (!weeklyPicks.length) weeklyPicks = list.slice(0, 8);
      }
      return { featured, bestSellers, weeklyPicks };
    }
  }

  function createCatalogService(config) {
    const cfg = Object.assign({ catalogProvider: 'mock' }, config || {});
    const provider = cfg.catalogProvider === 'supabase'
      ? new SupabaseCatalogProvider(cfg)
      : new MockCatalogProvider();
    return new CatalogService(provider);
  }

  window.AnarosaCatalog = {
    CatalogService,
    MockCatalogProvider,
    SupabaseCatalogProvider,
    CatalogUnavailableError,
    createCatalogService,
    normalizePublicProduct,
  };
})();
