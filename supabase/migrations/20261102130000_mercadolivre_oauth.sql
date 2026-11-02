-- Dados OAuth Mercado Livre: service_role somente; nenhuma policy para anon/authenticated.
create table if not exists public.meli_oauth_states (
  state_hash text primary key, admin_user_id uuid not null, expires_at timestamptz not null,
  used boolean not null default false, created_at timestamptz not null default now()
);
create index if not exists meli_oauth_states_expiry on public.meli_oauth_states(expires_at);
alter table public.meli_oauth_states enable row level security;
revoke all on public.meli_oauth_states from anon, authenticated;
create table if not exists public.meli_connections (
  seller_id bigint primary key, seller_nickname text,
  access_token text not null, refresh_token text not null, scope text,
  expires_at timestamptz not null, refresh_lock_until timestamptz, connected_by uuid,
  connected_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.meli_connections enable row level security;
revoke all on public.meli_connections from anon, authenticated;
comment on table public.meli_connections is 'Credenciais privadas OAuth da ANAROSA. Apenas Edge Functions service_role. Nunca enviar tokens ao navegador nem ao MCP.';
