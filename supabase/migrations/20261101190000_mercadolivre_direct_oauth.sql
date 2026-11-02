-- Integração direta Mercado Livre. O Bling permanece fonte de produtos e estoque.
-- Tokens OAuth e verificadores PKCE restritos ao backend service_role.
CREATE TABLE IF NOT EXISTS public.ml_oauth_states (
  state_hash text PRIMARY KEY CHECK (char_length(state_hash)=64),
  code_verifier text NOT NULL CHECK (char_length(code_verifier) BETWEEN 43 AND 128),
  admin_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX IF NOT EXISTS ml_oauth_states_expires_idx ON public.ml_oauth_states(expires_at);
CREATE TABLE IF NOT EXISTS public.ml_oauth_tokens (
  connection_key text PRIMARY KEY DEFAULT 'anarosa' CHECK (connection_key='anarosa'),
  seller_id text NOT NULL CHECK (seller_id ~ '^[0-9]+$'),
  seller_nickname text NOT NULL DEFAULT '',
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  scope text NOT NULL DEFAULT '',
  expires_at timestamptz NOT NULL,
  refresh_lock_until timestamptz,
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','expired','error')),
  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ml_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ml_oauth_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ml_oauth_states FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.ml_oauth_tokens FROM PUBLIC, anon, authenticated;
-- Nenhuma policy pública de leitura/escrita. Service role somente após validação admin.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ml_oauth_states TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ml_oauth_tokens TO service_role;
