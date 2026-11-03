-- Preserva vídeos próprios da loja quando integrações antigas atualizarem o produto.
-- A remoção explícita envia "videos": [] e não é revertida pelo gatilho.
CREATE OR REPLACE FUNCTION public.preserve_store_product_videos()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.metadata ? 'videos' AND NOT (COALESCE(NEW.metadata, '{}'::jsonb) ? 'videos') THEN
    NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb) ||
      jsonb_build_object('videos', OLD.metadata->'videos');
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_preserve_store_product_videos ON public.store_products;
CREATE TRIGGER trg_preserve_store_product_videos
BEFORE UPDATE ON public.store_products
FOR EACH ROW EXECUTE FUNCTION public.preserve_store_product_videos();
