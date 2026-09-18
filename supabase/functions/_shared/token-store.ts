/**
 * Persistência segura da conexão Bling (tabela bling_connections).
 *
 * Interface + implementação em memória (testes) + implementação Supabase.
 * Contém a lógica de "token perto de expirar" e o protocolo de refresh
 * com lock leve (RPC bling_try_acquire_refresh_lock) para evitar duas
 * Edge Functions renovando o mesmo token ao mesmo tempo.
 */
import type { TokenSet } from './bling-auth.ts';

export type ConnectionStatus = 'disconnected' | 'connected' | 'refresh_failed' | 'revoked';

export interface StoredConnection {
  id: string;
  companyId: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  tokenType: string;
  expiresAt: string | null;
  scope: string | null;
  status: ConnectionStatus;
  connectedAt: string | null;
  lastRefreshAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  refreshLockUntil: string | null;
  metadata: Record<string, unknown>;
}

/** Projeção sem segredos — o único formato que sai para fora do backend. */
export interface PublicConnectionInfo {
  connected: boolean;
  status: ConnectionStatus;
  companyId: string | null;
  expiresAt: string | null;
  connectedAt: string | null;
  lastRefreshAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
}

export interface TokenStore {
  getConnection(): Promise<StoredConnection | null>;
  saveConnection(tokens: TokenSet, extra?: { companyId?: string | null; metadata?: Record<string, unknown> }): Promise<StoredConnection>;
  tryAcquireRefreshLock(connectionId: string, ttlSeconds: number): Promise<boolean>;
  completeRefresh(connectionId: string, tokens: TokenSet): Promise<void>;
  failRefresh(connectionId: string, error: string): Promise<void>;
  markSynced(connectionId: string): Promise<void>;
}

export function isTokenExpiring(
  expiresAt: string | Date | null | undefined,
  skewSeconds: number,
  now: Date = new Date(),
): boolean {
  if (!expiresAt) return true;
  const t = typeof expiresAt === 'string' ? Date.parse(expiresAt) : expiresAt.getTime();
  if (!Number.isFinite(t)) return true;
  return t - now.getTime() <= skewSeconds * 1000;
}

export function toPublicInfo(conn: StoredConnection | null): PublicConnectionInfo {
  if (!conn) {
    return {
      connected: false,
      status: 'disconnected',
      companyId: null,
      expiresAt: null,
      connectedAt: null,
      lastRefreshAt: null,
      lastSyncAt: null,
      lastError: null,
    };
  }
  return {
    connected: conn.status === 'connected' && Boolean(conn.accessToken),
    status: conn.status,
    companyId: conn.companyId,
    expiresAt: conn.expiresAt,
    connectedAt: conn.connectedAt,
    lastRefreshAt: conn.lastRefreshAt,
    lastSyncAt: conn.lastSyncAt,
    lastError: conn.lastError,
  };
}

// ---------------------------------------------------------------------
// Implementação em memória (testes)
// ---------------------------------------------------------------------
export class MemoryTokenStore implements TokenStore {
  conn: StoredConnection | null = null;
  lockCalls = 0;

  constructor(initial?: Partial<StoredConnection>) {
    if (initial) this.conn = { ...emptyConnection('mem-1'), ...initial };
  }

  getConnection(): Promise<StoredConnection | null> {
    return Promise.resolve(this.conn ? { ...this.conn } : null);
  }

  saveConnection(tokens: TokenSet, extra: { companyId?: string | null; metadata?: Record<string, unknown> } = {}): Promise<StoredConnection> {
    const now = new Date().toISOString();
    this.conn = {
      ...(this.conn ?? emptyConnection('mem-1')),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? this.conn?.refreshToken ?? null,
      tokenType: tokens.tokenType,
      expiresAt: tokens.expiresAt.toISOString(),
      scope: tokens.scope,
      status: 'connected',
      connectedAt: now,
      lastError: null,
      companyId: extra.companyId ?? this.conn?.companyId ?? null,
      metadata: extra.metadata ?? this.conn?.metadata ?? {},
    };
    return Promise.resolve({ ...this.conn });
  }

  tryAcquireRefreshLock(_id: string, ttlSeconds: number): Promise<boolean> {
    this.lockCalls++;
    if (!this.conn) return Promise.resolve(false);
    const now = Date.now();
    const until = this.conn.refreshLockUntil ? Date.parse(this.conn.refreshLockUntil) : 0;
    if (until > now) return Promise.resolve(false);
    this.conn.refreshLockUntil = new Date(now + ttlSeconds * 1000).toISOString();
    return Promise.resolve(true);
  }

  completeRefresh(_id: string, tokens: TokenSet): Promise<void> {
    if (!this.conn) return Promise.resolve();
    this.conn.accessToken = tokens.accessToken;
    this.conn.refreshToken = tokens.refreshToken ?? this.conn.refreshToken;
    this.conn.tokenType = tokens.tokenType;
    this.conn.expiresAt = tokens.expiresAt.toISOString();
    this.conn.scope = tokens.scope ?? this.conn.scope;
    this.conn.status = 'connected';
    this.conn.lastRefreshAt = new Date().toISOString();
    this.conn.lastError = null;
    this.conn.refreshLockUntil = null;
    return Promise.resolve();
  }

  failRefresh(_id: string, error: string): Promise<void> {
    if (!this.conn) return Promise.resolve();
    this.conn.status = 'refresh_failed';
    this.conn.lastError = error;
    this.conn.refreshLockUntil = null;
    return Promise.resolve();
  }

  markSynced(): Promise<void> {
    if (this.conn) this.conn.lastSyncAt = new Date().toISOString();
    return Promise.resolve();
  }
}

export function emptyConnection(id: string): StoredConnection {
  return {
    id,
    companyId: null,
    accessToken: null,
    refreshToken: null,
    tokenType: 'Bearer',
    expiresAt: null,
    scope: null,
    status: 'disconnected',
    connectedAt: null,
    lastRefreshAt: null,
    lastSyncAt: null,
    lastError: null,
    refreshLockUntil: null,
    metadata: {},
  };
}

// ---------------------------------------------------------------------
// Implementação Supabase (service role)
// ---------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
type AnyRow = Record<string, any>;

function rowToConnection(row: AnyRow): StoredConnection {
  return {
    id: row.id,
    companyId: row.company_id ?? null,
    accessToken: row.access_token ?? null,
    refreshToken: row.refresh_token ?? null,
    tokenType: row.token_type ?? 'Bearer',
    expiresAt: row.expires_at ?? null,
    scope: row.scope ?? null,
    status: (row.status ?? 'disconnected') as ConnectionStatus,
    connectedAt: row.connected_at ?? null,
    lastRefreshAt: row.last_refresh_at ?? null,
    lastSyncAt: row.last_sync_at ?? null,
    lastError: row.last_error ?? null,
    refreshLockUntil: row.refresh_lock_until ?? null,
    metadata: row.metadata ?? {},
  };
}

export class SupabaseTokenStore implements TokenStore {
  // deno-lint-ignore no-explicit-any
  constructor(private readonly db: any) {}

  async getConnection(): Promise<StoredConnection | null> {
    const { data, error } = await this.db
      .from('bling_connections')
      .select('*')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`connection_read_failed: ${error.message}`);
    return data ? rowToConnection(data) : null;
  }

  async saveConnection(
    tokens: TokenSet,
    extra: { companyId?: string | null; metadata?: Record<string, unknown> } = {},
  ): Promise<StoredConnection> {
    const existing = await this.getConnection();
    const now = new Date().toISOString();
    const values: AnyRow = {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken ?? existing?.refreshToken ?? null,
      token_type: tokens.tokenType,
      expires_at: tokens.expiresAt.toISOString(),
      scope: tokens.scope,
      status: 'connected',
      connected_at: now,
      last_error: null,
      refresh_lock_until: null,
    };
    if (extra.companyId !== undefined) values.company_id = extra.companyId;
    if (extra.metadata) values.metadata = extra.metadata;

    const query = existing
      ? this.db.from('bling_connections').update(values).eq('id', existing.id).select('*').single()
      : this.db.from('bling_connections').insert(values).select('*').single();

    const { data, error } = await query;
    if (error) throw new Error(`connection_save_failed: ${error.message}`);
    return rowToConnection(data);
  }

  async tryAcquireRefreshLock(connectionId: string, ttlSeconds: number): Promise<boolean> {
    const { data, error } = await this.db.rpc('bling_try_acquire_refresh_lock', {
      p_connection_id: connectionId,
      p_ttl_seconds: ttlSeconds,
    });
    if (error) throw new Error(`refresh_lock_failed: ${error.message}`);
    return data === true;
  }

  async completeRefresh(connectionId: string, tokens: TokenSet): Promise<void> {
    const { error } = await this.db.rpc('bling_complete_token_refresh', {
      p_connection_id: connectionId,
      p_access_token: tokens.accessToken,
      p_refresh_token: tokens.refreshToken,
      p_token_type: tokens.tokenType,
      p_expires_at: tokens.expiresAt.toISOString(),
      p_scope: tokens.scope,
    });
    if (error) throw new Error(`refresh_persist_failed: ${error.message}`);
  }

  async failRefresh(connectionId: string, errorMessage: string): Promise<void> {
    const { error } = await this.db.rpc('bling_fail_token_refresh', {
      p_connection_id: connectionId,
      p_error: errorMessage,
    });
    if (error) throw new Error(`refresh_fail_persist_failed: ${error.message}`);
  }

  async markSynced(connectionId: string): Promise<void> {
    const { error } = await this.db
      .from('bling_connections')
      .update({ last_sync_at: new Date().toISOString() })
      .eq('id', connectionId);
    if (error) throw new Error(`mark_synced_failed: ${error.message}`);
  }
}
