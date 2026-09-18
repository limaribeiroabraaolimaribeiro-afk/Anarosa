/**
 * BlingClient — único ponto de acesso à API Bling v3.
 *
 * - Authorization: Bearer <access_token> + enable-jwt: 1 em toda chamada
 * - timeout por requisição (AbortController)
 * - 401 → refresh (com lock) → UMA repetição → BlingAuthError
 * - 429 → respeita Retry-After; UMA repetição apenas em GET
 * - POST nunca é repetido automaticamente (nunca duplicar pedidos)
 * - erros tipados; logs sanitizados
 * - sem loops infinitos: contadores explícitos em todos os caminhos
 */
import { BLING_DEFAULTS, type BlingConfig } from './config.ts';
import { type FetchLike, refreshAccessToken as refreshWithBling, type TokenSet } from './bling-auth.ts';
import {
  BlingApiError,
  BlingAuthError,
  BlingRateLimitError,
  BlingTimeoutError,
  describeError,
  NotConnectedError,
  TokenRefreshError,
} from './errors.ts';
import type { Logger } from './logger.ts';
import { isTokenExpiring, type StoredConnection, type TokenStore } from './token-store.ts';

export interface BlingClientOptions {
  config: BlingConfig;
  tokenStore: TokenStore;
  logger: Logger;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Função de refresh (injetável para testes). */
  refreshFn?: (cfg: BlingConfig, refreshToken: string, fetchImpl: FetchLike) => Promise<TokenSet>;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | Array<string | number> | undefined>;
  body?: unknown;
  operation?: string;
  /** Tentar refresh+repetição em 401 (padrão true). */
  retryOn401?: boolean;
}

export interface BlingListResponse<T = Record<string, unknown>> {
  data: T[];
}

export interface BlingItemResponse<T = Record<string, unknown>> {
  data: T;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const MAX_RATE_LIMIT_WAIT_MS = 10_000;
const REFRESH_LOCK_TTL_SECONDS = 30;
const REFRESH_WAIT_ATTEMPTS = 6;
const REFRESH_WAIT_BASE_MS = 400;
const MAX_LIST_PAGES = 500;

export class BlingClient {
  private readonly cfg: BlingConfig;
  private readonly store: TokenStore;
  private readonly log: Logger;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly refreshFn: NonNullable<BlingClientOptions['refreshFn']>;

  constructor(opts: BlingClientOptions) {
    this.cfg = opts.config;
    this.store = opts.tokenStore;
    this.log = opts.logger;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? (() => new Date());
    this.refreshFn = opts.refreshFn ?? refreshWithBling;
  }

  // -------------------------------------------------------------------
  // Tokens
  // -------------------------------------------------------------------
  private async loadConnection(): Promise<StoredConnection> {
    const conn = await this.store.getConnection();
    if (!conn || !conn.refreshToken || conn.status === 'revoked') {
      throw new NotConnectedError();
    }
    return conn;
  }

  /** Retorna um access_token válido, renovando antes se estiver perto de expirar. */
  async getValidAccessToken(): Promise<string> {
    const conn = await this.loadConnection();
    if (conn.accessToken && !isTokenExpiring(conn.expiresAt, this.cfg.refreshSkewSeconds, this.now())) {
      return conn.accessToken;
    }
    return await this.refreshAccessToken(conn);
  }

  /**
   * Renova o token com proteção contra concorrência:
   * quem obtém o lock renova; os demais aguardam e releem o banco.
   */
  async refreshAccessToken(conn?: StoredConnection): Promise<string> {
    const current = conn ?? (await this.loadConnection());
    const acquired = await this.store.tryAcquireRefreshLock(current.id, REFRESH_LOCK_TTL_SECONDS);

    if (!acquired) {
      this.log.debug('token.refresh', 'lock ocupado; aguardando renovação concorrente', { entityId: current.id });
      for (let attempt = 1; attempt <= REFRESH_WAIT_ATTEMPTS; attempt++) {
        await this.sleep(REFRESH_WAIT_BASE_MS * attempt);
        const fresh = await this.store.getConnection();
        if (!fresh) break;
        if (fresh.status === 'refresh_failed') {
          throw new TokenRefreshError('Renovação concorrente falhou.', { lastError: fresh.lastError });
        }
        const changed = fresh.accessToken && fresh.accessToken !== current.accessToken;
        if (changed && !isTokenExpiring(fresh.expiresAt, this.cfg.refreshSkewSeconds, this.now())) {
          return fresh.accessToken as string;
        }
      }
      throw new TokenRefreshError('Tempo esgotado aguardando renovação concorrente do token.');
    }

    try {
      const tokens = await this.refreshFn(this.cfg, current.refreshToken as string, this.fetchImpl);
      await this.store.completeRefresh(current.id, tokens);
      this.log.info('token.refresh', 'token renovado', {
        entityId: current.id,
        expiresAt: tokens.expiresAt.toISOString(),
        rotatedRefreshToken: Boolean(tokens.refreshToken),
      });
      return tokens.accessToken;
    } catch (err) {
      const d = describeError(err);
      await this.store.failRefresh(current.id, `${d.code}: ${d.message}`);
      this.log.error('token.refresh', 'falha ao renovar token', {
        entityId: current.id,
        errorCode: d.code,
        httpStatus: d.details?.blingStatus ?? null,
      });
      throw err instanceof TokenRefreshError || err instanceof BlingApiError
        ? err
        : new TokenRefreshError(d.message);
    }
  }

  // -------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------
  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const base = this.cfg.apiBaseUrl.replace(/\/+$/, '');
    const url = new URL(`${base}/${path.replace(/^\/+/, '')}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const v of value) url.searchParams.append(`${key}[]`, String(v));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async rawFetch(url: string, init: RequestInit, operation: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.requestTimeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw new BlingTimeoutError(operation);
      throw new BlingApiError(0, `Falha de rede em ${operation}.`, { operation });
    } finally {
      clearTimeout(timer);
    }
  }

  private static parseRetryAfter(res: Response): number | undefined {
    const h = res.headers.get('retry-after');
    if (!h) return undefined;
    const n = Number(h);
    if (Number.isFinite(n) && n >= 0) return n;
    const t = Date.parse(h);
    return Number.isFinite(t) ? Math.max(0, Math.ceil((t - Date.now()) / 1000)) : undefined;
  }

  private static async safeJson(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  private static blingError(status: number, payload: unknown, operation: string): BlingApiError {
    const p = (payload ?? {}) as Record<string, unknown>;
    const e = (p.error ?? {}) as Record<string, unknown>;
    return new BlingApiError(status, `Bling respondeu ${status} em ${operation}.`, {
      operation,
      blingType: typeof e.type === 'string' ? e.type : undefined,
      blingMessage: typeof e.message === 'string' ? e.message : (typeof e.description === 'string' ? e.description : undefined),
    });
  }

  /**
   * Requisição autenticada. Repete no máximo:
   *   - 1x após refresh (401)
   *   - 1x após Retry-After (429) — somente GET
   */
  async request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    const method = opts.method ?? 'GET';
    const operation = opts.operation ?? `${method} ${path}`;
    const url = this.buildUrl(path, opts.query);
    const isIdempotent = method === 'GET';

    let token = await this.getValidAccessToken();
    let refreshed = false;
    let rateLimitRetried = false;

    for (let attempt = 0; attempt < 3; attempt++) {
      const init: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          [BLING_DEFAULTS.jwtHeaderName]: BLING_DEFAULTS.jwtHeaderValue,
          Accept: 'application/json',
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      };

      const started = Date.now();
      const res = await this.rawFetch(url, init, operation);
      const durationMs = Date.now() - started;

      if (res.ok) {
        this.log.debug('bling.request', operation, { httpStatus: res.status, durationMs });
        if (res.status === 204) return undefined as T;
        return (await BlingClient.safeJson(res)) as T;
      }

      const payload = await BlingClient.safeJson(res);

      if (res.status === 401 && opts.retryOn401 !== false && !refreshed) {
        refreshed = true;
        this.log.warn('bling.request', '401 recebido; renovando token', { operation, durationMs });
        // outro worker pode já ter renovado: reler antes de forçar refresh
        const latest = await this.store.getConnection();
        if (latest?.accessToken && latest.accessToken !== token &&
            !isTokenExpiring(latest.expiresAt, this.cfg.refreshSkewSeconds, this.now())) {
          token = latest.accessToken;
        } else {
          token = await this.refreshAccessToken(latest ?? undefined);
        }
        continue;
      }

      if (res.status === 401) {
        throw new BlingAuthError(undefined, operation);
      }

      if (res.status === 429) {
        const retryAfter = BlingClient.parseRetryAfter(res);
        if (isIdempotent && !rateLimitRetried) {
          rateLimitRetried = true;
          const waitMs = Math.min((retryAfter ?? 1) * 1000, MAX_RATE_LIMIT_WAIT_MS);
          this.log.warn('bling.request', '429 recebido; aguardando Retry-After', { operation, waitMs });
          await this.sleep(waitMs);
          continue;
        }
        throw new BlingRateLimitError(retryAfter, operation);
      }

      const err = BlingClient.blingError(res.status, payload, operation);
      this.log.error('bling.request', 'erro da API Bling', {
        operation,
        httpStatus: res.status,
        blingType: err.blingType ?? null,
        durationMs,
      });
      throw err;
    }

    throw new BlingApiError(0, `Tentativas esgotadas em ${operation}.`, { operation });
  }

  // -------------------------------------------------------------------
  // Produtos
  // -------------------------------------------------------------------
  getProducts(params: { page?: number; limit?: number; criterio?: number; idCategoria?: string | number; ids?: Array<string | number> } = {}) {
    return this.request<BlingListResponse>('produtos', {
      operation: 'products.list',
      query: {
        pagina: params.page ?? 1,
        limite: Math.min(params.limit ?? this.cfg.productsPageSize, 100),
        criterio: params.criterio,
        idCategoria: params.idCategoria,
        idsProdutos: params.ids,
      },
    });
  }

  /** Percorre todas as páginas de /produtos (limite máximo de páginas por segurança). */
  async listAllProducts(params: { criterio?: number; onPage?: (page: number, count: number) => void } = {}): Promise<Record<string, unknown>[]> {
    const limit = this.cfg.productsPageSize;
    const all: Record<string, unknown>[] = [];
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      const res = await this.getProducts({ page, limit, criterio: params.criterio });
      const items = Array.isArray(res?.data) ? res.data : [];
      params.onPage?.(page, items.length);
      all.push(...items);
      if (items.length < limit) break;
    }
    return all;
  }

  getProductById(id: string | number) {
    return this.request<BlingItemResponse>(`produtos/${encodeURIComponent(String(id))}`, {
      operation: 'products.get',
    });
  }

  /**
   * POST /produtos — cria produto. Referência oficial:
   * developer.bling.com.br/referencia#/Produtos/post_produtos
   * Sem repetição automática (POST nunca é repetido — evita produto duplicado).
   */
  createProduct(payload: Record<string, unknown>) {
    return this.request<BlingItemResponse>('produtos', {
      method: 'POST',
      body: payload,
      operation: 'products.create',
    });
  }

  /**
   * PUT /produtos/{idProduto} — substitui o cadastro do produto.
   * developer.bling.com.br/referencia#/Produtos/put_produtos__idProduto_
   * SUBSTITUI o produto inteiro (não é PATCH parcial) — por isso o
   * chamador (admin-product-update) só usa isto para produtos SEM
   * variação (ver CatalogRepository.productHasVariants).
   */
  updateProduct(id: string | number, payload: Record<string, unknown>) {
    return this.request<BlingItemResponse>(`produtos/${encodeURIComponent(String(id))}`, {
      method: 'PUT',
      body: payload,
      operation: 'products.update',
    });
  }

  /**
   * PATCH /produtos/{idProduto}/situacoes — altera SÓ a situação
   * (ativo/inativo). Não toca em variações — seguro para qualquer
   * produto, com ou sem variação.
   * developer.bling.com.br/referencia#/Produtos/patch_produtos__idProduto__situacoes
   */
  async changeProductSituation(id: string | number, situacao: 'A' | 'I'): Promise<void> {
    await this.request<unknown>(`produtos/${encodeURIComponent(String(id))}/situacoes`, {
      method: 'PATCH',
      body: { situacao },
      operation: 'products.change_situation',
    });
  }

  // -------------------------------------------------------------------
  // Estoque
  // -------------------------------------------------------------------
  /**
   * POST /estoques — cria um LANÇAMENTO de estoque (não é um "set"
   * direto de saldo, exceto quando operacao='B'):
   *   E (entrada): soma `quantidade` ao saldo atual
   *   S (saída):   subtrai `quantidade` do saldo atual
   *   B (balanço): `quantidade` PASSA A SER o saldo atual (absoluto)
   * developer.bling.com.br/referencia#/Estoques/post_estoques
   * Sem repetição automática (POST nunca é repetido — evita lançar
   * o mesmo ajuste de estoque duas vezes).
   */
  createStockEntry(payload: { produto: { id: number }; deposito: { id: number }; operacao: 'B' | 'E' | 'S'; quantidade: number; preco?: number; observacoes?: string }) {
    return this.request<BlingItemResponse>('estoques', {
      method: 'POST',
      body: payload,
      operation: 'stock.create_entry',
    });
  }

  /**
   * GET /depositos — lista depósitos reais da conta. Nunca assumimos
   * um depósito default — quem ajusta estoque escolhe entre estes.
   * developer.bling.com.br/referencia#/Dep%C3%B3sitos/get_depositos
   *
   * Contrato oficial: GET /depositos?pagina=1&limite=100&situacao=1 —
   * `situacao` de depósito é INTEIRO (1=ativo, 0=inativo), diferente do
   * `situacao` de produto ('A'/'I', string). Pedimos situacao=1 direto
   * na query (a própria API já filtra), mas o mapeamento em
   * admin-deposits/index.ts NÃO confia cegamente nisso — recalcula
   * `ativo` a partir do valor bruto devolvido, comparando com o inteiro
   * 1 (nunca com a string 'A').
   */
  async getDeposits(): Promise<Record<string, unknown>[]> {
    const res = await this.request<BlingListResponse>('depositos', {
      operation: 'deposits.list',
      query: { pagina: 1, limite: 100, situacao: 1 },
    });
    return Array.isArray(res?.data) ? res.data : [];
  }

  async getStocks(productIds: Array<string | number>, depositId?: string | number): Promise<Record<string, unknown>[]> {
    const ids = Array.from(new Set(productIds.map(String))).filter(Boolean);
    const out: Record<string, unknown>[] = [];
    const CHUNK = 50;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const res = await this.request<BlingListResponse>('estoques/saldos', {
        operation: 'stocks.balances',
        query: { idsProdutos: chunk, idDeposito: depositId },
      });
      if (Array.isArray(res?.data)) out.push(...res.data);
    }
    return out;
  }

  // -------------------------------------------------------------------
  // Categorias
  // -------------------------------------------------------------------
  async getCategories(): Promise<Record<string, unknown>[]> {
    const all: Record<string, unknown>[] = [];
    const limit = 100;
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      const res = await this.request<BlingListResponse>('categorias/produtos', {
        operation: 'categories.list',
        query: { pagina: page, limite: limit },
      });
      const items = Array.isArray(res?.data) ? res.data : [];
      all.push(...items);
      if (items.length < limit) break;
    }
    return all;
  }

  // -------------------------------------------------------------------
  // Pedidos de venda
  // -------------------------------------------------------------------
  /** POST sem repetição automática. O chamador garante idempotência. */
  createOrder(payload: Record<string, unknown>) {
    return this.request<BlingItemResponse>('pedidos/vendas', {
      method: 'POST',
      body: payload,
      operation: 'orders.create',
    });
  }

  getOrderById(id: string | number) {
    return this.request<BlingItemResponse>(`pedidos/vendas/${encodeURIComponent(String(id))}`, {
      operation: 'orders.get',
    });
  }
}
