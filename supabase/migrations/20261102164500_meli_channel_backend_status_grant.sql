-- Atualização do status da integração Mercado Livre exclusivamente pelo backend.
grant update on table public.store_marketplace_connections to service_role;
revoke all on table public.store_marketplace_connections from anon, authenticated;
