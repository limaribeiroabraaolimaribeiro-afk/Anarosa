# API direta Mercado Livre → Gestão Anarosa (somente leitura na primeira fase)

## Integração e responsabilidades
- O Bling continua sendo o ERP e a fonte de produtos, variações, SKU e estoque.
- A autorização do Mercado Livre é **independente da integração Mercado Livre 01 no Bling**.
- Nenhum anúncio é criado, modificado ou republicado por este módulo.
- O usuário precisa autorizar com a conta *administradora vendedora* da Anarosa, não com uma conta de colaborador ou pessoal.

## 1. Criar aplicativo no Mercado Livre DevCenter
Acesse https://developers.mercadolivre.com.br/ e, autenticado com a conta responsável pela empresa, entre em **Minhas aplicações > Criar aplicação**. Escolha unidade de negócio **Mercado Livre** (não Mercado Pago), com nome **Gestão ANAROSA**, descrevendo que conecta os anúncios ao ERP da Anarosa.

URL de redirecionamento OAuth **exata** (HTTPS, sem parâmetros):
`https://gpmbkptimjipqsayrvce.supabase.co/functions/v1/mercadolivre-oauth-callback`

Configuração:
- Ative **PKCE S256**.
- Permissões para leitura da conta, anúncios e acesso offline (`read`, `offline_access`). A autorização de escrita pode ser adicionada mais tarde, apenas se o backend de publicação for implementado e testado.
- Não cadastre tópicos de notificação até existir endpoint para recebê-las.
- Aplicativos Mercado Livre e Mercado Pago devem ser separados (regra em vigor a partir de agosto/2026).

## 2. Salvar Client ID e Secret Key — nunca no GitHub ou ChatGPT
No projeto Supabase **gpmbkptimjipqsayrvce**, abra **Project Settings > Edge Functions > Secrets** e configure:
- `ML_CLIENT_ID` — ID numérico do aplicativo Mercado Livre.
- `ML_CLIENT_SECRET` — Secret Key do app (nunca em chat, commit, print ou HTML).
- Opcional, mas recomendado: `ML_EXPECTED_SELLER_ID` — ID numérico da conta vendedora autorizada, para bloquear conta errada.

Estas variáveis só são acessíveis ao código servidor. A URL de callback está fixada no código exatamente como acima.

## 3. Conectar na Gestão
Após publicar a migration e as duas Edge Functions:
1. Abrir https://www.lojaanarosa.com.br/gestao/#/integracao
2. Na seção **Mercado Livre — API direta**, clicar em **Conectar Mercado Livre**.
3. Login na conta administradora vendedora e aprovar as permissões.
4. Após o retorno, conferir o nome da loja e o status em Integrações.

## Fluxo técnico
- O endpoint `admin-mercadolivre-connect` exige JWT Supabase + verificação `store_admins.active`.
- Cria state aleatório de uso único (no Postgres só fica SHA-256) e par PKCE S256.
- Callback `mercadolivre-oauth-callback` troca `code` por tokens no backend, valida identity `GET /users/me`, mantém o vendedor existente e grava tokens com RLS, sem retorná-los ao navegador.
- GET autenticado de status renova access token próximo do vencimento usando lock e grava o refresh_token novo (uso único).
- Falhas de OAuth redirecionam com códigos genéricos; não expõem segredo.
- Publicação de anúncios segue **bloqueada** em `admin-marketplace-listings` até o adaptador oficial ser validado.

## Validação
- `npm run lint:js`
- `npm run check`
- `npm run test`
- `npm run test:public`
- Teste OAuth real e verificação de identidade só após criação do aplicativo e inserção de segredos.

Fontes: https://developers.mercadolivre.com.br/autenticacao-e-autorizacao e https://developers.mercadolivre.com.br/desenvolvimento-in-house
