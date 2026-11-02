-- Permissão exclusiva do serviço backend da ANAROSA nas tabelas OAuth Mercado Livre.
-- Corrige respostas 403 nos endpoints de autenticação, sem acesso público.
grant select, insert, update, delete on table public.meli_connections to service_role;
grant select, insert, update, delete on table public.meli_oauth_states to service_role;
revoke all on table public.meli_connections from anon, authenticated;
revoke all on table public.meli_oauth_states from anon, authenticated;
