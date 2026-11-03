-- Exclusão lógica no cache ANAROSA após confirmação pelo Bling.
-- Preserva IDs para itens de pedidos antigos e histórico financeiro.
alter table public.store_products
  add column if not exists deleted_from_bling_at timestamptz;

-- Mesmo se um webhook/sync atrasado reaparecer, jamais tornar visível
-- no site um produto já excluído no Bling por esta gestão.
create or replace function public.keep_bling_deleted_product_hidden()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.deleted_from_bling_at is not null then
    new.deleted_from_bling_at := old.deleted_from_bling_at;
    new.active := false;
  elsif new.deleted_from_bling_at is not null then
    new.active := false;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_keep_bling_deleted_product_hidden on public.store_products;
create trigger trg_keep_bling_deleted_product_hidden
before update on public.store_products
for each row
execute function public.keep_bling_deleted_product_hidden();
