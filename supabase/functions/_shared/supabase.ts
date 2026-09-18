/**
 * Cliente Supabase com SERVICE ROLE (somente backend).
 * Único arquivo que importa o SDK — módulos de domínio recebem o cliente
 * por injeção, o que permite testá-los sem rede.
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { getAppConfig } from './config.ts';
import { ConfigError } from './errors.ts';
import type { LogEntry, LogSink } from './logger.ts';

// deno-lint-ignore no-explicit-any
export type Db = SupabaseClient<any, 'public', any>;

let cached: Db | null = null;

export function getServiceClient(): Db {
  if (cached) return cached;
  const { supabaseUrl, supabaseServiceRoleKey } = getAppConfig();
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new ConfigError('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes.');
  }
  cached = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-anarosa-integration': 'edge' } },
  });
  return cached;
}

/** Sink que grava em integration_logs (já sanitizado pelo logger). */
export function dbLogSink(db: Db): LogSink {
  return async (entry: LogEntry) => {
    await db.from('integration_logs').insert({
      integration: entry.integration,
      level: entry.level,
      operation: entry.operation,
      entity_type: entry.entityType ?? null,
      entity_id: entry.entityId ?? null,
      message: entry.message,
      details: entry.details,
      created_at: entry.timestamp,
    });
  };
}
