# Gestão de produtos e estoque via Bling (Gestão Anarosa)

O Bling é a ÚNICA fonte de verdade para produto/estoque. A Gestão Anarosa
nunca escreve em `store_products`/`store_product_variants`/`store_inventory`
diretamente a partir de uma ação do usuário — toda ação primeiro grava no
Bling; o cache Supabase só é atualizado depois, por uma leitura segura
(o mesmo caminho que os webhooks `product.*`/`stock.*` já usam).

```
Gestão Anarosa (admin autenticado, store_admins)
  → admin-product-create / admin-product-update / admin-product-situacao / admin-stock-adjust
  → BlingClient (grava no Bling — POST/PUT/PATCH)
  → syncProductById / syncStockForProducts (LEITURA segura pós-escrita)
  → store_products / store_product_variants / store_inventory (cache)
  → storefront-* (loja pública) e Gestão (tela) refletem o cache atualizado
```

## 1. Endpoints oficiais utilizados

Confirmados via `developer.bling.com.br/referencia` (citados literalmente
nos `@see` de um SDK open-source gerado a partir do OpenAPI oficial —
`github.com/AlexandreBellas/bling-erp-api-js`, cujos operationIds
— ex. `patch_produtos__idProduto__situacoes` — batem com a convenção
Swagger da própria documentação):

| Ação | Método | Path | Referência |
|---|---|---|---|
| Criar produto | POST | `/produtos` | `#/Produtos/post_produtos` |
| Atualizar produto | PUT | `/produtos/{idProduto}` | `#/Produtos/put_produtos__idProduto_` |
| Ativar/desativar | PATCH | `/produtos/{idProduto}/situacoes` | `#/Produtos/patch_produtos__idProduto__situacoes` |
| Lançar estoque | POST | `/estoques` | `#/Estoques/post_estoques` |
| Listar depósitos | GET | `/depositos` | `#/Depósitos/get_depositos` |

Nenhum endpoint DELETE é usado (regra explícita desta primeira versão).

## 2. Situação, tipo, formato — códigos oficiais

- `situacao`: `A` = Ativo, `I` = Inativo.
- `tipo`: `P` = Produto (usado sempre — Anarosa só vende produto físico).
- `formato`: `S` = Simples, `V` = Com variações, `E` = Com composição.
- `condicao`: `0` = Não especificado (fixo nesta versão).
- `estoques.operacao`: `E` = Entrada (soma), `S` = Saída (subtrai),
  `B` = Balanço (a quantidade PASSA A SER o saldo atual — absoluto).

## 3. Por que produtos COM variação não são editáveis por aqui

`PUT /produtos/{id}` **substitui o cadastro inteiro**, incluindo o array
`variacoes` — a própria resposta documentada do endpoint relata variações
`deleted`/`updated`/`saved`, ou seja, o Bling faz um DIFF do array enviado
contra o atual. Um PUT que omite `variacoes` arrisca apagar as variações
existentes. Por isso:

- **Criar produto**: só formato `S` (simples) nesta versão.
- **Editar produto**: bloqueado (no backend E na UI) quando
  `CatalogRepository.productHasVariants()` é verdadeiro, ou quando o id
  pertence a uma variação (`parent_bling_id` preenchido).
- **Ativar/desativar** (PATCH `/situacoes`) e **ajustar estoque**
  (POST `/estoques`) continuam funcionando para QUALQUER produto —
  nenhum dos dois toca no array de variações.

## 4. PUT preserva o que não é editado no formulário

Como PUT substitui o cadastro inteiro, `admin-product-update` primeiro
faz `GET /produtos/{id}` e usa `buildBlingProductUpdatePayload()` para
copiar os campos ESCALARES atuais (codigo/marca/gtin/unidade/condicao/
peso/etc.) antes de sobrepor os campos editados no formulário. **Limitação
conhecida**: objetos complexos (`tributacao`, `estrutura`, `dimensoes`,
`camposCustomizados`, `midia`) não são copiados nesta versão — se o
produto editado depender desses campos (ex.: NCM/tributação configurada
por contador), confirme após salvar que continuam corretos, ou edite
esses campos específicos direto no Bling.

## 5. Estoque — comportamento explícito na UI

A tela deixa literal: "Entrada — SOMA a quantidade ao saldo atual",
"Saída — SUBTRAI a quantidade do saldo atual", "Balanço — a quantidade
PASSA A SER o saldo atual". O depósito é sempre escolhido de uma lista
carregada de `GET /depositos` — nunca um id assumido/hardcoded.

## 6. Segurança

- Todas as 5 novas Edge Functions exigem sessão Supabase Auth +
  `store_admins.active=true` (`requireAdminUser`) — `verify_jwt=true`
  (padrão, fora da lista de exceções do `config.toml`).
- Rate limiting por usuário admin via `rl_check_and_increment` (mesma
  função da integração InfinitePay) — 20-30 requisições/60s por ação.
- Validação no backend (`_shared/product-admin-mapper.ts`): preço ≥ 0,
  SKU sanitizado (`[A-Za-z0-9._-]`, máx. 60), quantidade > 0, ids do
  Bling só numéricos positivos, depósito/produto validados contra o
  catálogo sincronizado antes de qualquer chamada ao Bling.
- Nenhum `access_token`/`refresh_token`/`client_secret` do Bling chega
  ao navegador — todas as chamadas passam por `BlingClient` no backend.
- Logs (`ctx.logger`) sanitizados — nunca token, sempre `entityId`/
  `adminUserId`/código de erro estruturado.

## 7. Arquivos

- `_shared/bling-client.ts` — `createProduct`, `updateProduct`,
  `changeProductSituation`, `createStockEntry`, `getDeposits`.
- `_shared/product-admin-mapper.ts` — validação e montagem de payload.
- `_shared/catalog-repo.ts` — `productHasVariants()` (novo).
- `admin-product-create`, `admin-product-update`, `admin-product-situacao`,
  `admin-stock-adjust`, `admin-deposits` — novas Edge Functions.
- `gestao/index.html`, `gestao/js/gestao.js`, `gestao/js/gestao-api.js`,
  `gestao/css/gestao.css` — botões "Novo produto"/"Editar"/"Ajustar
  estoque"/"Ativar-Desativar" e os dois drawers de formulário.

## 8. Passos para o primeiro teste real controlado

1. Confirmar que a conexão Bling atual tem permissão de escrita em
   produtos/estoque (escopo do app Bling — ver `docs/BLING_SETUP_MANUAL.md`).
2. Criar UM produto de teste barato/descartável pela Gestão, confirmar
   que aparece no Bling E no cache/loja.
3. Ajustar o estoque desse produto de teste (entrada pequena), confirmar
   saldo no Bling e no cache.
4. Ativar/desativar esse mesmo produto de teste, confirmar refletido.
5. Só depois, com confiança, usar em produtos reais do catálogo.


## Atualização — Cadastro completo na Gestão (29/10/2026)

A tela de produto agora distingue **campos oficiais da API Bling** de **curadoria
comercial da vitrine ANAROSA**:

| Campo | Origem e gravação |
| --- | --- |
| Nome, SKU, marca, categoria, unidade, GTIN, descrições, preço normal | Produto no Bling v3 (API autenticada) |
| Variações, peso, dimensões e classificação fiscal | Produto no Bling v3; sujeito às validações de edição e permissões |
| Ajuste de estoque | Lançamento no Bling, usando depósito real |
| Tags de vitrine `novo`, `mais-vendido`, `oferta`, `escolha-da-semana`, `destaque` | Curadoria ANAROSA em `store_products.metadata.tags`; vínculo pelo `bling_id` |
| Coleção e segmento/gênero | Curadoria ANAROSA em `store_products.metadata`; vínculo pelo `bling_id` |
| Preço promocional da loja | `store_products.promotional_price`; não altera listas de preços do Bling |
| Tags internas do Bling, campos customizados e canais de venda | Não são alterados por esse editor: a API v3 não foi validada para essas operações |

**Salvamento:** as alterações de cadastro são enviadas primeiro ao Bling;
o cache é sincronizado por leitura; só então as informações comerciais
locais são gravadas. O carregamento do editor faz o inverso, juntando o
cadastro atual do ERP com a curadoria da vitrine. Webhooks e reimportações
preservam explicitamente essas chaves comerciais e o preço promocional.

**Atenção:** a edição comercial não promete editar etiquetas internas do
Bling, anúncios do Mercado Livre/Shopee nem suas regras de preços. Para
isso, primeiro é necessário validar os endpoints e escopos específicos.
As alterações do produto não movimentam estoque sem lançamento explícito.
O botão **Atualizar do Bling** consulta novamente as categorias oficiais.

**Publicação:** alterações em `gestao/js/` exigem deploy GitHub Pages.
Alterações em `_shared/product-editor.ts`, `_shared/product-save.ts`,
`_shared/catalog-repo.ts`, `_shared/storefront-serializer.ts`,
`admin-product-detail` e `admin-categories` precisam de deploy das
Edge Functions dependentes, inclusive as funções de sincronização e
webhooks para não perder os campos editoriais em imports posteriores.
