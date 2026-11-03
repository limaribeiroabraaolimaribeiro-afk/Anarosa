-- Vídeos públicos de produto; somente Edge Functions autenticadas gravam.
-- Sem policies para anon/authenticated no storage.objects.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('anarosa-product-videos', 'anarosa-product-videos', true, 31457280,
  ARRAY['video/mp4', 'video/webm']::text[])
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;
