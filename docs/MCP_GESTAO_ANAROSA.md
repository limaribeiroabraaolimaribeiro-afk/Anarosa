# MCP da Gestão ANAROSA — ChatGPT, produtos e anúncios

## O que é
Servidor remoto `anarosa-mcp` exclusivo de operações **comerciais** para a
ANAROSA. Nenhuma ferramenta para GitHub, código-fonte, terminal, SQL,
storage genérico, sistema de arquivos, segredos ou infraestrutura.

**Servidor**:
`https://gpmbkptimjipqsayrvce.supabase.co/functions/v1/anarosa-mcp`

**Tela de autorização**:
`https://www.lojaanarosa.com.br/oauth/consent/`

### O que o ChatGPT pode pedir
- Consultar produtos, variantes, categorias, depósitos, estoque, clientes, pedidos,
  relatórios, anúncios, canais e pendências do catálogo.
- Cadastrar e atualizar produtos usando as **mesmas validações da Gestão** e
  confirmação explícita, revisão do Bling e idempotência por UUID.
- Registrar balanço, entrada ou saída de estoque em um depósito específico,
  sempre por operação autorizada.
- Criar rascunhos ou preparar anúncios Shopee e Mercado Livre,
  usando IDs e variações do Bling. Solicitar publicação pelo fluxo existente.
- Criar propostas de títulos, descrição e prompts de foto com dados confirmados.
- Importar imagem real já gerada (JPG/PNG/WebP base64 até 3 MB) para o Storage.
- Gerar uma arte via API opcional do provedor com chave **separada** do ChatGPT,
  confirmação explícita, limite de 3 imagens/hora por admin, com custo da API
  e revisão antes de uso comercial. O provedor deve estar ativado.

### O que NÃO pode fazer
- Executar código; acessar GitHub, banco SQL ou arquivos; instalar dependências;
  extrair service-role, tokens Bling ou OpenAI; gerenciar OAuth ou usuários.
- Publicar Mercado Livre/Shopee sem credenciais de canal e adaptador oficial:
  o backend `admin-marketplace-listings` responde bloqueio e NUNCA finge
  ter publicado. **Não altere esse bloqueio sem homologar o canal.**
- Inventar estoque, preços, GTIN, NCM ou características das roupas.
- Anexar automaticamente uma foto ao Bling só porque ela foi criada ou
  armazenada. É preciso confirmar e salvar o produto/anúncio.

## Autenticação OAuth 2.1 — configuração obrigatória no Supabase
A Edge Function foi criada com `verify_jwt=false` **somente para permitir
OAuth Protected Resource Metadata público** (RFC 9728). Toda chamada
real de MCP exige Bearer Supabase Auth válido e
`requireAdminUser` (allowlist `store_admins.active`).

A configuração do provedor OAuth é uma ação de administração da conta:
não pode ser iniciada pelo MCP. Acesse o projeto em
Supabase Dashboard → Authentication → OAuth Server e configure:

1. **OAuth 2.1 server**: habilitado.
2. **Dynamic Client Registration (DCR)**: habilitado (revisar clientes e
   revogar consentimentos periodicamente).
3. **Authorization Path**: `/oauth/consent`.
4. **Site URL** (Authentication → URL Configuration):
   `https://www.lojaanarosa.com.br`.
5. Confirme as chaves de assinatura JWT, de preferência ES256 ou RS256.
6. O caminho `/oauth/consent/` deve carregar a página com o mesmo
   domínio da Gestão. Faça login com uma conta admin da ANAROSA, reveja
   nome do app, escopos e URL de retorno e só então autorize.

O servidor publica `/oauth-protected-resource` e envia
`WWW-Authenticate: Bearer resource_metadata="..."` quando uma chamada
POST não está autenticada. Discovery aponta para
`https://gpmbkptimjipqsayrvce.supabase.co/auth/v1`.
Não substitua o fluxo por uma chave estática pública, senha na URL ou
service-role no ChatGPT.

### Conectar ao ChatGPT
ChatGPT web → Plugins → adicionar servidor MCP personalizado:
- Nome: `Gestão ANAROSA`.
- URL: `https://gpmbkptimjipqsayrvce.supabase.co/functions/v1/anarosa-mcp`.
- Autenticação: OAuth.
- Concluir o login administrativo e a autorização de escopos.
- Testar ferramentas de **leitura** antes de habilitar ações de gravação.
- O acesso depende do plano e da permissão de plugins MCP na conta.

## Protocolo e ferramentas
Streamable HTTP sem sessão (JSON-RPC 2.0):
`initialize`, `ping`, `tools/list`, `tools/call`. Retorno
`application/json` (sem eventos SSE obrigatórios).
Funções de leitura e escrita acessam somente uma allowlist fixa
de Edge Functions `admin-*`, passando o Bearer do usuário;
cada função valida novamente administrador, entrada e limites.
`tools/list`/initialize também exigem autenticação.
O limite do MCP é 40 chamadas/minuto por administrador e o de imagens
geradas é 3/hora. Os limites adicionais de cada endpoint permanecem.
Todas as respostas e erros devem omitir stack trace e segredos.

Para chamadas que criam/modificam algo, exigir `confirmar=true`.
Para cadastro, atualização e estoque, o argumento `operationKey`
deve ser UUID estável, reutilizado em tentativas repetidas.

### Geração opcional de imagem
O MCP aceita `OPENAI_API_KEY` como segredo **apenas no Supabase Edge
Functions**, não na web nem no GitHub. Nunca cole esse segredo no chat.
A ferramenta `gerar_imagem_comercial` só tenta a API quando essa chave
já existir, e exige `confirmar=true`. Ela gera arte conceitual que
precisa de revisão. O recurso é cobrado conforme as tarifas da API de imagens;
a assinatura ChatGPT Plus não o inclui.
Se a chave não estiver configurada, o recurso explica a dependência
e oferece o fluxo ChatGPT → importar_imagem_gerada.

## Testes mínimos antes de liberar ao cliente
1. `GET /functions/v1/anarosa-mcp/oauth-protected-resource` deve retornar
   o provedor OAuth — **nenhum token**.
2. `POST initialize` sem Bearer deve retornar **401**, não lista de ferramentas.
3. Sessão de usuário normal sem allowlist deve retornar **403**.
4. Login admin com OAuth + DCR deve listar somente ferramentas comerciais.
5. `listar_produtos` lê o catálogo sem modificar nada.
6. `cadastrar_produto` requer confirmação, SKU válido e UUID; teste só com
   SKU de homologação aprovado pela cliente, depois arquive.
7. `salvar_anuncio` cria rascunho; `solicitar_publicacao_anuncio`
   deve devolver bloqueio até homologar os canais.
8. `gerar_imagem_comercial` sem segredo deve devolver mensagem sem cobrar
   nem produzir arquivo.
9. Inspecionar logs sem dados sensíveis, e revogar acesso OAuth teste.

## Publicação
Implantar somente a função `anarosa-mcp` com `verify_jwt=false` e a
tela `oauth/consent/` no GitHub Pages. **Não alterar** o tratamento
OAuth/segredos das outras Edge Functions. A ativação do OAuth Server e
DCR precisa ocorrer no Dashboard por um admin; sem ela a integração fica
**instalada, porém não conectável via OAuth**.
