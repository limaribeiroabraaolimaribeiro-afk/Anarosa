-- Guarda previsualizacoes aprovaveis para edicao de anuncios Mercado Livre.
-- Tokens ficam em meli_connections e nao sao expostos na tabela de propostas.
create table if not exists public.meli_edit_intents (
  id uuid primary key default gen_random_uuid(),
  seller_id bigint not null,
  item_id text not null,
  admin_user_id uuid not null,
  snapshot_hash text not null,
  changes jsonb not null,
  preview jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  outcome jsonb,
  constraint valid_meli_item_id check (item_id ~ '^MLB[0-9]{8,16}$')
);
create index if not exists meli_edit_intents_admin_created on public.meli_edit_intents(admin_user_id,created_at desc);
create index if not exists meli_edit_intents_expiry on public.meli_edit_intents(expires_at);
alter table public.meli_edit_intents enable row level security;
revoke all on table public.meli_edit_intents from anon,authenticated;
grant select,insert,update on table public.meli_edit_intents to service_role;
comment on table public.meli_edit_intents is 'MCP Mercado Livre: propostas de edicao curtas, aprovadas e consumo unico, sem credenciais. Tabelas privadas com RLS, service_role apenas.';
