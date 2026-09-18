/**
 * Configuração centralizada das Edge Functions.
 *
 * ÚNICO lugar do backend onde URLs do Bling e nomes de variáveis de
 * ambiente aparecem. Nenhum outro arquivo deve hardcodar essas URLs.
 *
 * Leitura de ambiente é isolada em `readEnv` para funcionar tanto no
 * Deno (Supabase Edge Runtime) quanto em Node (testes locais).
 */

// deno-lint-ignore no-explicit-any
const g = globalThis as any;

export function readEnv(name: string): string | undefined {
  try {
    if (g.Deno?.env?.get) return g.Deno.env.get(name) ?? undefined;
  } catch {
    // Deno sem permissão de env → cai para process.env
  }
  if (g.process?.env) return g.process.env[name];
  return undefined;
}

function envOr(name: string, fallback: string): string {
  const v = readEnv(name);
  return v && v.trim() !== '' ? v.trim() : fallback;
}

function envBool(name: string, fallback = false): boolean {
  const v = readEnv(name);
  if (v == null || v.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

function envInt(name: string, fallback: number): number {
  const v = Number(readEnv(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Valores padrão oficiais da API Bling v3 (podem ser sobrescritos por env). */
export const BLING_DEFAULTS = Object.freeze({
  apiBaseUrl: 'https://api.bling.com.br/Api/v3',
  authUrl: 'https://www.bling.com.br/Api/v3/oauth/authorize',
  // Endpoint de token conforme documentação de migração JWT
  // (POST /oauth/token). Isolado aqui: se a doc oficial indicar outro
  // host, basta ajustar BLING_TOKEN_URL nos secrets.
  tokenUrl: 'https://api.bling.com.br/Api/v3/oauth/token',
  requestTimeoutMs: 15_000,
  /** Renova o token quando faltar menos que isto para expirar. */
  refreshSkewSeconds: 120,
  /** Tempo de vida do state OAuth. */
  oauthStateTtlSeconds: 10 * 60,
  /** Tamanho de página ao listar produtos (máximo aceito pelo Bling: 100). */
  productsPageSize: 100,
  /** Header exigido pelo Bling para emitir/aceitar tokens JWT. */
  jwtHeaderName: 'enable-jwt',
  jwtHeaderValue: '1',
  /** Header de assinatura de webhooks. */
  webhookSignatureHeader: 'x-bling-signature-256',
});

export interface BlingConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  apiBaseUrl: string;
  authUrl: string;
  tokenUrl: string;
  requestTimeoutMs: number;
  refreshSkewSeconds: number;
  oauthStateTtlSeconds: number;
  productsPageSize: number;
  orderSyncEnabled: boolean;
}

export function getBlingConfig(): BlingConfig {
  return {
    clientId: envOr('BLING_CLIENT_ID', ''),
    clientSecret: envOr('BLING_CLIENT_SECRET', ''),
    redirectUri: envOr('BLING_REDIRECT_URI', ''),
    apiBaseUrl: envOr('BLING_API_BASE_URL', BLING_DEFAULTS.apiBaseUrl).replace(/\/+$/, ''),
    authUrl: envOr('BLING_AUTH_URL', BLING_DEFAULTS.authUrl),
    tokenUrl: envOr('BLING_TOKEN_URL', BLING_DEFAULTS.tokenUrl),
    requestTimeoutMs: envInt('BLING_REQUEST_TIMEOUT_MS', BLING_DEFAULTS.requestTimeoutMs),
    refreshSkewSeconds: envInt('BLING_REFRESH_SKEW_SECONDS', BLING_DEFAULTS.refreshSkewSeconds),
    oauthStateTtlSeconds: envInt('BLING_OAUTH_STATE_TTL_SECONDS', BLING_DEFAULTS.oauthStateTtlSeconds),
    productsPageSize: Math.min(envInt('BLING_PRODUCTS_PAGE_SIZE', BLING_DEFAULTS.productsPageSize), 100),
    orderSyncEnabled: envBool('BLING_ORDER_SYNC_ENABLED', false),
  };
}

/** true quando client_id, client_secret e redirect_uri estão presentes. */
export function isBlingConfigured(cfg: BlingConfig = getBlingConfig()): boolean {
  return Boolean(cfg.clientId && cfg.clientSecret && cfg.redirectUri);
}

export interface AppConfig {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  storefrontUrl: string;
  integrationAdminSecret: string;
  oauthSuccessRedirectUrl: string;
}

export function getAppConfig(): AppConfig {
  const storefrontUrl = envOr('STOREFRONT_URL', 'http://localhost:5500').replace(/\/+$/, '');
  return {
    supabaseUrl: envOr('SUPABASE_URL', ''),
    supabaseServiceRoleKey: envOr('SUPABASE_SERVICE_ROLE_KEY', ''),
    storefrontUrl,
    integrationAdminSecret: envOr('INTEGRATION_ADMIN_SECRET', ''),
    // Padrão aponta para a tela "Integração" dentro do próprio painel
    // Gestão (rota já existente no router de gestao/js/gestao.js) — não
    // para integration-status.html, que é uma ferramenta interna e
    // nunca é publicada (ver .github/workflows/deploy-pages.yml).
    oauthSuccessRedirectUrl: envOr(
      'OAUTH_SUCCESS_REDIRECT_URL',
      `${storefrontUrl}/gestao/#/integracao`,
    ),
  };
}

/**
 * Valores oficiais do Checkout Integrado InfinitePay
 * (https://www.infinitepay.io/checkout-documentacao — consultado em
 * 2026-09-14; sem versão/data de revisão publicada pela InfinitePay).
 * Endpoints fixos aqui; só o handle (identificador público da conta,
 * SEM o símbolo "$") vem de env.
 */
export const INFINITEPAY_DEFAULTS = Object.freeze({
  apiBaseUrl: 'https://api.checkout.infinitepay.io',
  requestTimeoutMs: 15_000,
});

export interface InfinitePayConfig {
  handle: string;
  apiBaseUrl: string;
  requestTimeoutMs: number;
  webhookUrl: string;
  redirectUrl: string;
}

export function getInfinitePayConfig(): InfinitePayConfig {
  const { storefrontUrl, supabaseUrl } = getAppConfig();
  const functionsBase = envOr('SUPABASE_FUNCTIONS_URL', supabaseUrl ? `${supabaseUrl.replace(/\/+$/, '')}/functions/v1` : '');
  return {
    // Infinite Tag exibida como "$maia_14" na conta — a API espera o
    // handle SEM o "$" (ver checkout-documentacao).
    handle: envOr('INFINITEPAY_HANDLE', '').replace(/^\$/, ''),
    apiBaseUrl: envOr('INFINITEPAY_API_BASE_URL', INFINITEPAY_DEFAULTS.apiBaseUrl).replace(/\/+$/, ''),
    requestTimeoutMs: envInt('INFINITEPAY_REQUEST_TIMEOUT_MS', INFINITEPAY_DEFAULTS.requestTimeoutMs),
    webhookUrl: envOr('INFINITEPAY_WEBHOOK_URL', functionsBase ? `${functionsBase}/infinitepay-webhook` : ''),
    redirectUrl: envOr('INFINITEPAY_REDIRECT_URL', `${storefrontUrl}/pedido-confirmado.html`),
  };
}

export function isInfinitePayConfigured(cfg: InfinitePayConfig = getInfinitePayConfig()): boolean {
  return Boolean(cfg.handle && cfg.webhookUrl);
}

/** Eventos de webhook que o backend está preparado para tratar. */
export const SUPPORTED_WEBHOOK_EVENTS = Object.freeze([
  'product.created',
  'product.updated',
  'product.deleted',
  'stock.created',
  'stock.updated',
  'stock.deleted',
  'virtual_stock.updated',
  'order.created',
  'order.updated',
  'order.deleted',
] as const);

export type SupportedWebhookEvent = (typeof SUPPORTED_WEBHOOK_EVENTS)[number];
