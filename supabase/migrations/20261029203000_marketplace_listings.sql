-- Gestão ANAROSA: anúncios por canal, sem expor tokens de marketplaces.
-- Dados mestres/estoque continuam exclusivamente no Bling.
create table if not exists public.store_marketplace_listings (
  id uuid primary key default gen_random_uuid(),
  bling_product_id text not null references public.store_products(bling_id) on delete restrict,
  marketplace text not null check (marketplace in ('mercado_livre','shopee')),
  title text not null check (char_length(title) between 3 and 160),
  description text not null default '',
  category_external_id text not null default '',
  listing_type text not null default 'marketplace',
  shipping_mode text not null default '',
  price numeric(12,2) not null check (price >= 0),
  images jsonb not null default '[]'::jsonb check (jsonb_typeof(images)='array'),
  variation_mapping jsonb not null default '[]'::jsonb check (jsonb_typeof(variation_mapping)='array'),
  attributes jsonb not null default '{}'::jsonb check (jsonb_typeof(attributes)='object'),
  status text not null default 'draft' check (status in ('draft','ready','blocked','published','error')),
  external_listing_id text,
  external_url text,
  last_error text,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz
);
create index if not exists store_marketplace_listings_product_idx
  on public.store_marketplace_listings(bling_product_id, marketplace, updated_at desc);
create index if not exists store_marketplace_listings_status_idx
  on public.store_marketplace_listings(status, updated_at desc);
create table if not exists public.store_marketplace_connections (
  marketplace text primary key check (marketplace in ('mercado_livre','shopee')),
  status text not null default 'disconnected' check (status in ('disconnected','pending','connected','expired','error')),
  external_store_id text,
  external_store_name text,
  permissions jsonb not null default '[]'::jsonb,
  verified_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into public.store_marketplace_connections (marketplace,status)
values ('mercado_livre','disconnected'),('shopee','disconnected')
on conflict (marketplace) do nothing;
alter table public.store_marketplace_listings enable row level security;
alter table public.store_marketplace_connections enable row level security;
-- Não conceder permissões ou políticas para anon/authenticated.
-- Chamadas administrativas são verificadas em Edge Function com service role.
revoke all on public.store_marketplace_listings from anon, authenticated;
revoke all on public.store_marketplace_connections from anon, authenticated;
