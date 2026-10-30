-- Impede dois vínculos locais para o mesmo anúncio externo do marketplace,
-- inclusive em chamadas simultâneas. Não altera anúncios nem estoques.
CREATE UNIQUE INDEX IF NOT EXISTS store_marketplace_listing_external_once
  ON public.store_marketplace_listings (marketplace, external_listing_id)
  WHERE external_listing_id IS NOT NULL;
