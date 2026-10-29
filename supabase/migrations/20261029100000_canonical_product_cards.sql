-- Catálogo canônico: apenas pais/simples.
-- Algumas versões do Bling retornam filhos sem idProdutoPai e os antigos
-- sincronizadores os cadastraram também em store_products. Em vez de apagar
-- dados e estoques, escondemos do catálogo os ids que já pertencem a um pai
-- em store_product_variants. Isso também mantém paginação e filtros corretos.
CREATE OR REPLACE VIEW public.store_catalog_products
WITH (security_invoker = true)
AS
SELECT p.*
FROM public.store_products AS p
WHERE p.parent_bling_id IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.store_product_variants AS v
    WHERE v.bling_id = p.bling_id
      AND v.product_id <> p.id
  );

-- A view é usada pelo backend service_role; não concede leitura pública da
-- tabela administrativa por meio de um endpoint SQL.
REVOKE ALL ON public.store_catalog_products FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.store_catalog_products TO service_role;

CREATE INDEX IF NOT EXISTS store_product_variants_bling_product_idx
  ON public.store_product_variants (bling_id, product_id);

NOTIFY pgrst, 'reload schema';
