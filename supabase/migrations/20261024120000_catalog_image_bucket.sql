-- Fotos de produtos são públicas apenas para leitura, porque Bling e marketplaces
-- precisam obter as URLs. Somente Edge Functions com service role escrevem aqui.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('anarosa-product-images', 'anarosa-product-images', true, 3145728,
  ARRAY['image/jpeg', 'image/png', 'image/webp']::text[])
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;
-- Não criar policy de insert/update/delete para anon ou authenticated.
