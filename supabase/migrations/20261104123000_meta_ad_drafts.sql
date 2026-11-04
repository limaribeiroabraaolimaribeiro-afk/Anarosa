-- Rascunhos de anúncios patrocinados Meta, separados do catálogo e dos anúncios MLB.
-- Sem RLS policies diretas: somente Edge Functions service_role autenticadas acessam.
CREATE TABLE IF NOT EXISTS public.store_meta_ad_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bling_product_id text NOT NULL,
  product_name text NOT NULL,
  product_sku text,
  title text NOT NULL DEFAULT '',
  primary_text text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  image_url text NOT NULL DEFAULT '',
  destination_url text NOT NULL DEFAULT '',
  adset_id text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  revision integer NOT NULL DEFAULT 1,
  approved_revision integer,
  approved_by uuid,
  approved_at timestamptz,
  meta_creative_id text,
  meta_ad_id text UNIQUE,
  last_error text,
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meta_drafts_status CHECK (status IN ('draft','approved','publishing','paused_on_meta','needs_reconciliation','error')),
  CONSTRAINT meta_drafts_title CHECK (length(title) <= 160),
  CONSTRAINT meta_drafts_body CHECK (length(primary_text) <= 2200),
  CONSTRAINT meta_drafts_description CHECK (length(description) <= 500),
  CONSTRAINT meta_drafts_revision CHECK (revision > 0),
  CONSTRAINT meta_drafts_blind_id CHECK (bling_product_id ~ '^[1-9][0-9]{0,18}$')
);
CREATE INDEX IF NOT EXISTS store_meta_ad_drafts_updated_idx ON public.store_meta_ad_drafts(updated_at DESC);
ALTER TABLE public.store_meta_ad_drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.store_meta_ad_drafts FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.store_meta_ad_drafts TO service_role;
