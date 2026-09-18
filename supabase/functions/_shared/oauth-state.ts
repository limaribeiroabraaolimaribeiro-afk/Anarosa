/**
 * State OAuth (proteção CSRF).
 *
 * - valor aleatório criptograficamente seguro (32 bytes, base64url)
 * - no banco fica apenas o SHA-256 do valor
 * - expiração curta (config.oauthStateTtlSeconds)
 * - uso único: consumo atômico via RPC bling_consume_oauth_state
 */
import { randomToken, sha256Hex } from './crypto.ts';

export interface OAuthStateStore {
  insert(stateHash: string, expiresAt: Date): Promise<void>;
  /** Marca como usado e retorna true SOMENTE se existir, não expirou e não foi usado. */
  consume(stateHash: string, now?: Date): Promise<boolean>;
}

export interface CreatedState {
  state: string;
  expiresAt: Date;
}

export async function createOAuthState(
  store: OAuthStateStore,
  ttlSeconds: number,
  now: Date = new Date(),
): Promise<CreatedState> {
  const state = randomToken(32);
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  await store.insert(await sha256Hex(state), expiresAt);
  return { state, expiresAt };
}

const STATE_FORMAT = /^[A-Za-z0-9_-]{32,128}$/;

export async function validateOAuthState(
  store: OAuthStateStore,
  state: string | null | undefined,
  now: Date = new Date(),
): Promise<boolean> {
  if (!state || !STATE_FORMAT.test(state)) return false;
  return await store.consume(await sha256Hex(state), now);
}

/** Store em memória — usado em testes; replica a semântica do RPC SQL. */
export class MemoryOAuthStateStore implements OAuthStateStore {
  readonly rows = new Map<string, { expiresAt: Date; usedAt: Date | null }>();

  insert(stateHash: string, expiresAt: Date): Promise<void> {
    this.rows.set(stateHash, { expiresAt, usedAt: null });
    return Promise.resolve();
  }

  consume(stateHash: string, now: Date = new Date()): Promise<boolean> {
    const row = this.rows.get(stateHash);
    if (!row) return Promise.resolve(false);
    if (row.usedAt) return Promise.resolve(false);
    if (row.expiresAt.getTime() <= now.getTime()) return Promise.resolve(false);
    row.usedAt = now;
    return Promise.resolve(true);
  }
}

/** Store real (Supabase). `db` é o cliente service role. */
export class SupabaseOAuthStateStore implements OAuthStateStore {
  // deno-lint-ignore no-explicit-any
  constructor(private readonly db: any) {}

  async insert(stateHash: string, expiresAt: Date): Promise<void> {
    const { error } = await this.db
      .from('bling_oauth_states')
      .insert({ state_hash: stateHash, expires_at: expiresAt.toISOString() });
    if (error) throw new Error(`oauth_state_insert_failed: ${error.message}`);
  }

  async consume(stateHash: string): Promise<boolean> {
    const { data, error } = await this.db.rpc('bling_consume_oauth_state', {
      p_state_hash: stateHash,
    });
    if (error) throw new Error(`oauth_state_consume_failed: ${error.message}`);
    return data === true;
  }
}
