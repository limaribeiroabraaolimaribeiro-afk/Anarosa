-- Vídeo escolhido para o anúncio (separado das fotos). Não é publicação externa.
-- Um vídeo por anúncio no fluxo inicial, sem alterar anúncio remoto.
ALTER TABLE public.store_marketplace_listings
  ADD COLUMN IF NOT EXISTS video_url text,
  ADD COLUMN IF NOT EXISTS video_status text NOT NULL DEFAULT 'not_selected',
  ADD COLUMN IF NOT EXISTS video_external_id text;

-- Estado exclusivamente preparatório; o código não escreve "published" aqui.
ALTER TABLE public.store_marketplace_listings
  DROP CONSTRAINT IF EXISTS store_marketplace_listings_video_status_check;
ALTER TABLE public.store_marketplace_listings
  ADD CONSTRAINT store_marketplace_listings_video_status_check
  CHECK (video_status IN ('not_selected','selected','uploading','processing','published','rejected'));
ALTER TABLE public.store_marketplace_listings
  DROP CONSTRAINT IF EXISTS store_marketplace_listings_video_url_check;
ALTER TABLE public.store_marketplace_listings
  ADD CONSTRAINT store_marketplace_listings_video_url_check
  CHECK (video_url IS NULL OR (length(video_url) <= 1024 AND left(video_url, 8) = 'https://'));
