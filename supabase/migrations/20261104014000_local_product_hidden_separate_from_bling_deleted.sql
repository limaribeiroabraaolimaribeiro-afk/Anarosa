-- Independente da exclusão no ERP: ocultar no catálogo local não falsifica a situação do Bling.
ALTER TABLE public.store_products
  ADD COLUMN IF NOT EXISTS hidden_from_gestao_at timestamptz;

-- Persistir remoções locais/externas por eventos de sincronização fora de ordem.
CREATE OR REPLACE FUNCTION public.keep_bling_deleted_product_hidden()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.deleted_from_bling_at IS NOT NULL THEN
    NEW.deleted_from_bling_at := OLD.deleted_from_bling_at;
  END IF;
  IF OLD.hidden_from_gestao_at IS NOT NULL THEN
    NEW.hidden_from_gestao_at := OLD.hidden_from_gestao_at;
  END IF;
  IF NEW.deleted_from_bling_at IS NOT NULL OR NEW.hidden_from_gestao_at IS NOT NULL THEN
    NEW.active := false;
  END IF;
  RETURN NEW;
END;
$$;
