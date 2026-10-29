-- Corrige a migração 20261029203000_marketplace_listings.sql:
-- "REVOKE ... FROM anon, authenticated" retirou indiretamente também
-- privilégios herdados pelo service_role. O PostgREST da Edge Function
-- retornava 403 (permission denied), que virava erro HTTP 500 no painel.
--
-- Permissões mínimas exclusivas do backend; RLS continua habilitada.
GRANT SELECT, INSERT, UPDATE ON TABLE public.store_marketplace_listings TO service_role;
GRANT SELECT ON TABLE public.store_marketplace_connections TO service_role;
REVOKE ALL ON TABLE public.store_marketplace_listings FROM anon, authenticated;
REVOKE ALL ON TABLE public.store_marketplace_connections FROM anon, authenticated;
