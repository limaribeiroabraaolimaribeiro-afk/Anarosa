/**
 * Monta as dependências de uma Edge Function (Deno/Supabase runtime).
 * Único módulo que junta SDK Supabase + config + logger + client.
 */
import { AdminRepository } from './admin-repo.ts';
import { BlingClient } from './bling-client.ts';
import { CatalogRepository } from './catalog-repo.ts';
import {
  getAppConfig,
  getBlingConfig,
  getInfinitePayConfig,
  type AppConfig,
  type BlingConfig,
  type InfinitePayConfig,
} from './config.ts';
import { handlePreflight } from './cors.ts';
import { InfinitePayClient } from './infinitepay-client.ts';
import { createLogger, type Logger } from './logger.ts';
import { errorResponse } from './responses.ts';
import { dbLogSink, getServiceClient, type Db } from './supabase.ts';
import { SupabaseTokenStore } from './token-store.ts';

export interface AppContext {
  db: Db;
  logger: Logger;
  tokenStore: SupabaseTokenStore;
  repo: CatalogRepository;
  adminRepo: AdminRepository;
  blingConfig: BlingConfig;
  appConfig: AppConfig;
  infinitePayConfig: InfinitePayConfig;
  client: () => BlingClient;
  paymentClient: () => InfinitePayClient;
}

export function createContext(): AppContext {
  const db = getServiceClient();
  const logger = createLogger({ sink: dbLogSink(db), persistMinLevel: 'info' });
  const tokenStore = new SupabaseTokenStore(db);
  const repo = new CatalogRepository(db);
  const adminRepo = new AdminRepository(db);
  const blingConfig = getBlingConfig();
  const appConfig = getAppConfig();
  const infinitePayConfig = getInfinitePayConfig();
  let client: BlingClient | null = null;
  let paymentClient: InfinitePayClient | null = null;
  return {
    db,
    logger,
    tokenStore,
    repo,
    adminRepo,
    blingConfig,
    appConfig,
    infinitePayConfig,
    client: () => {
      if (!client) client = new BlingClient({ config: blingConfig, tokenStore, logger });
      return client;
    },
    paymentClient: () => {
      if (!paymentClient) paymentClient = new InfinitePayClient({ config: infinitePayConfig, logger });
      return paymentClient;
    },
  };
}

export type Handler = (req: Request, ctx: AppContext) => Promise<Response>;

/**
 * Envolve o handler com: preflight CORS, contexto, tratamento de erro
 * uniforme e flush dos logs.
 */
export function serve(handler: Handler): void {
  // deno-lint-ignore no-explicit-any
  (globalThis as any).Deno.serve(async (req: Request) => {
    const pre = handlePreflight(req);
    if (pre) return pre;

    let ctx: AppContext | null = null;
    try {
      ctx = createContext();
      return await handler(req, ctx);
    } catch (err) {
      ctx?.logger.error('edge.unhandled', 'erro não tratado', { error: err });
      return errorResponse(req, err);
    } finally {
      await ctx?.logger.flush();
    }
  });
}

/** Agenda trabalho após a resposta (EdgeRuntime.waitUntil) quando disponível. */
export function runInBackground(task: Promise<unknown>): boolean {
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt && typeof rt.waitUntil === 'function') {
    rt.waitUntil(task.catch(() => undefined));
    return true;
  }
  return false;
}
