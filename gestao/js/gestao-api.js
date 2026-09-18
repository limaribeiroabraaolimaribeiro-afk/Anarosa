/**
 * Gestão Anarosa — cliente das Edge Functions admin-*.
 *
 * Envia sempre `Authorization: Bearer <access_token da sessão>` — a
 * sessão do usuário, nunca um segredo. 401 aqui significa sessão
 * ausente/expirada OU usuário fora da allowlist store_admins; em
 * qualquer um dos dois casos o app trata como "sessão expirada" e
 * volta para a tela de login (não tenta adivinhar qual dos dois foi).
 */
(function () {
  'use strict';

  const cfg = window.ANAROSA_CONFIG || {};
  const baseUrl = cfg.functionsBaseUrl || (cfg.supabaseUrl ? `${cfg.supabaseUrl.replace(/\/+$/, '')}/functions/v1` : '');

  class GestaoApiError extends Error {
    constructor(message, status, payload) {
      super(message);
      this.name = 'GestaoApiError';
      this.status = status;
      this.payload = payload;
    }
  }

  async function call(path, { params, method, body } = {}) {
    if (!baseUrl) throw new GestaoApiError('Backend não configurado (js/config.js).', 0, null);
    const session = await window.GestaoAuth.getSession();
    if (!session) throw new GestaoApiError('Sessão administrativa ausente.', 401, null);

    const url = new URL(`${baseUrl}/${path}`);
    for (const [key, value] of Object.entries(params || {})) {
      if (value != null && value !== '') url.searchParams.set(key, String(value));
    }

    const headers = { Accept: 'application/json', Authorization: `Bearer ${session.access_token}` };
    if (cfg.supabaseAnonKey) headers.apikey = cfg.supabaseAnonKey;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let res;
    try {
      res = await fetch(url.toString(), {
        method: method || (body !== undefined ? 'POST' : 'GET'),
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new GestaoApiError('Falha de rede ao contatar o painel.', 0, null);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new GestaoApiError(json.message || `HTTP ${res.status}`, res.status, json);
    }
    return json;
  }

  window.GestaoApi = {
    GestaoApiError,
    getDashboardSummary: () => call('admin-dashboard-summary'),
    listOrders: (params) => call('admin-orders', { params }),
    getOrder: (id) => call('admin-orders', { params: { id } }),
    listProducts: (params) => call('admin-products', { params }),
    listCustomers: (params) => call('admin-customers', { params }),
    getIntegrationStatus: () => call('admin-integration-status'),
    createProduct: (body) => call('admin-product-create', { body }),
    updateProduct: (body) => call('admin-product-update', { body }),
    changeProductSituation: (body) => call('admin-product-situacao', { body }),
    adjustStock: (body) => call('admin-stock-adjust', { body }),
    listDeposits: () => call('admin-deposits'),
    listCategories: () => call('admin-categories'),
  };
})();
