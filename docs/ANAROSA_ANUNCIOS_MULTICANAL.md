# ANAROSA — Cadastro de variações e anúncios multicanal

## Objetivo
Centralizar na Gestão ANAROSA o produto mestre do Bling, as combinações de
cores/tamanhos, fotos gerais, fotos por variação e rascunhos comerciais distintos
para Mercado Livre e Shopee. Estoque e SKU sempre pertencem ao Bling.

## Como cadastrar um modelo com variações
1. Gestão → Produtos → Novo produto.
2. Informe nome, SKU principal, categoria Bling, preço, fotos gerais, informações
   fiscais, medidas e descrição reais.
3. Em Variações, informe **Cores** separadas por vírgula e **Tamanhos** separados
   por vírgula. Clique em **Gerar combinações**. Exemplos:
   - Branco, Preto × P, M, G → seis combinações.
   - Azul × P, M → duas combinações.
4. Cada combinação recebe SKU derivado do principal; revise preço, tamanho, cor
   e SKU (não reutilize códigos). Tamanho e cor usam o padrão Bling
   `Tamanho:M;Cor:Azul`.
5. Salve; verifique a confirmação do Bling. Ajustes de estoque são lançamentos
   separados por SKU e depósito. Novas combinações partem de estoque sem saldo
   até existir ajuste no Bling.
6. Editando produto com variações já existentes: **não remova IDs**. Desative
   combinações antigas. Não converta produto simples já existente com estoque
   sem conversão controlada no próprio ERP.

## Fotos e canais
1. A galeria do cadastro envia várias fotos do aparelho para o Storage; fotos
   internas do Bling já são recuperadas em arquivos permanentes quando possível.
2. Gestão → **Anúncios** → **Novo anúncio**.
3. Selecione o produto pai e o marketplace, título, categoria oficial do canal,
   modalidade de envio, preço e descrição.
4. Adicione as fotos gerais (upload múltiplo) e opcionalmente uma foto específica
   por variação (input de URL ou envio do arquivo).
5. Marque as variações que devem constar no anúncio. Para produtos sem variantes,
   deixe a grade vazia.
6. Preencha atributos obrigatórios comprovados pelo canal; categoria do Bling
   **não equivale** à categoria oficial de cada marketplace.
7. **Salvar rascunho** registra a configuração local. **Verificar para publicar**
   valida produto ativo, categoria, imagem, modalidade e seleção das variações,
   e marca `ready` para revisão. Um rascunho pronto **não foi publicado**.

## Publicação direta: dependência externa ainda não habilitada
- O Bling tem Gestão de Anúncios na interface e uma API `anuncios`, mas o
  conector Bling MCP disponível nesta conversa só disponibiliza métodos de
  produtos, estoque, categorias e pedidos, **não** de anúncios.
- Autenticar o Bling **não autentica** a conta de vendas Mercado Livre/Shopee.
  Não há credenciais de marketplace ou adaptador de publicação homologado
  configurados neste projeto.
- O botão **Publicar no marketplace** executa uma verificação administrativa
  segura, mas devolve status `blocked` (HTTP 409) com instruções explícitas
  enquanto faltar a autorização do canal. **Nunca cria anúncio fictício nem
  registra `published` sem resposta da API oficial.**
- Para habilitar envio real: autenticar a loja em cada marketplace (OAuth ou
  conexão homologada Bling), confirmar escopos e APIs de anúncios, implementar
  adaptador com payload revisado e validação dos atributos permitidos por
  categoria, idempotência de envio, conferência de resposta oficial e
  reconciliação dos IDs de anúncio e SKUs.
- Mercado Livre exige considerar modelo User Product (UP), categoria,
  atributos, modalidades, limites de variação e imagens; Shopee exige atributos
  e tamanhos de grade, logística e políticas específicas da categoria.
  **Não usar preços/saldos fictícios.**

## Segurança de produção
- Tabelas `store_marketplace_listings` e `store_marketplace_connections`
  têm RLS habilitada, sem grants/policies para `anon` ou `authenticated`.
- Nova Edge Function `admin-marketplace-listings` roda com `verify_jwt=true`,
  exige `requireAdminUser`, valida SKU da família do produto, preço,
  categorias, contagem de fotos e estrutura simples de atributos.
- ID e status de anúncio publicado só serão gravados após confirmação pela
  plataforma; credenciais nunca devem ser armazenadas no navegador ou no
  cadastro do anúncio.
- Não alterar webhooks, catálogo público ou estoque para preparar rascunhos.

## Critérios de aceite
- 2 cores × 3 tamanhos → 6 SKUs únicos sem duplicar combinações ao repetir.
- Rascunho Mercado Livre e Shopee podem coexistir sobre o mesmo `bling_id`.
- Fotos de cada cor são associadas ao ID da variação e persistidas por canal.
- Rejeita variação de outro produto, duplicadas, categorias vazias na preparação
  e anúncio sem foto ou modalidade.
- Sem autorização real, publicar não muda status para `published`.
- Listagem e edição só acessíveis à conta administradora autenticada.

Referências: https://developer.bling.com.br/referencia,
https://ajuda.bling.com.br/hc/pt-br/articles/34366219361047-Como-criar-novos-an%C3%BAncios-com-varia%C3%A7%C3%A3o-no-Bling-e-enviar-para-o-Mercado-Livre,
https://developers.mercadolivre.com.br/pt_br/variacoes
