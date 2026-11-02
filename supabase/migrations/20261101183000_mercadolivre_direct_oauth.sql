-- Conexão direta Mercado Livre (não reutiliza tokens do Bling).
-- Credenciais são acessíveis apenas pelo backend service_role.
create table if not exists public.ml_oauth_states (
  state_hash text primary key,
  verifier text not null,
  admin_id uuid not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists public.ml_seller_credentials (
  id integer primary key default 1 check (id = 1),
  ml_user_id bigint not null,
  nickname text,
  access_token text not null,
  refresh_token text not null,
  token_expires_at timestamptz not null,
  scopes text,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  refresh_lock_until timestamptz
);
create index if not exists ml_oauth_states_expiry_idx on public.ml_oauth_states (expires_at);
alter table public.ml_oauth_states enable row level security;
alter table public.ml_seller_credentials enable row level security;
revoke all on table public.ml_oauth_states from PUBLIC, anon, authenticated;
revoke all on table public.ml_seller_credentials from PUBLIC, anon, authenticated;
grant select,insert,update,delete on table public.ml_oauth_states to service_role;
grant select,insert,update,delete on table public.ml_seller_credentials to service_role;
-- Uma atualização de refresh_token é feita somente se a linha ainda
-- tiver o refresh token lido pelo processo (compare-and-swap).
-- As tabelas não têm policies para usuários anônimos ou autenticados.
