# Gestão Anarosa — upload de fotos e dados adicionais

## O que muda

- Em Novo produto/Editar, admins podem selecionar arquivos JPG, PNG ou WebP de até 3 MB por imagem; a interface mostra prévias.
- A Edge Function `admin-product-image-upload` valida a sessão Supabase, a permissão em `store_admins.active`, limite de upload e assinatura do arquivo antes de gravar no Storage.
- Cada imagem fica em URL HTTPS pública (exigência de exibição na loja/marketplaces). Não use este bucket para dados pessoais, documentos ou notas fiscais.
- O Bling continua sendo a fonte de verdade para produtos e estoque. Foto é enviada ao Storage **antes** de criar/atualizar o produto; o backend só confirma o sucesso após a resposta do Bling.
- O editor recebeu campos de **unidade** e **GTIN/EAN**, com validação de dígito verificador para códigos novos. GTIN não é SKU.

## Implantação (projeto correto ANAROSA)

1. Confirmar qual projeto Supabase hospeda a Gestão Anarosa (não aplicar em outro projeto).
2. Aplicar a migration `supabase/migrations/20261024120000_catalog_image_bucket.sql`; conferir bucket público para leitura, sem políticas de escrita para `anon` ou `authenticated`.
3. Implantar `admin-product-image-upload` com **verify_jwt=true**.
4. Redeploy `admin-product-detail`, `admin-product-create`, `admin-product-update`, `bling-sync-product` e funções de sincronização que importam `_shared/product-mapper.ts` ou `_shared/product-editor.ts`, conforme o pipeline.
5. Confirmar escopo OAuth de imagem no Bling ("Salvar imagens dos Produtos"); reautorizar o app se necessário.
6. Configurar o Bling para trabalhar com URLs de imagens externas e verificar gravação via API no ambiente real.
7. Configurar segredos/variáveis de ambiente no projeto correto:
   - `BLING_PRODUCT_IMAGES_ENABLED=true` **somente** após validar permissão real de mídia no Bling.
   - `ANAROSA_IMAGE_UPLOAD_ENABLED=true` **somente** após criar o bucket e implantar a função.
8. Executar testes e validar em uma peça de teste: login admin, upload, salvar no Bling, leitura na Gestão, sincronização e vitrine.

Se qualquer dependência faltar, o painel deixa o envio de arquivos desabilitado: não promete sucesso falso.

## Limites conhecidos

- Não publica automaticamente na Shopee ou no Mercado Livre; exige validação por canal.
- Se o cadastro existente tiver imagens **internas** no Bling, alterações na galeria são bloqueadas para evitar apagar as imagens antigas.
- Arquivos enviados com sucesso mas que não forem vinculados por falha posterior de gravação no Bling ficam no Storage e exigem limpeza administrativa futura.
- O cadastro de GTIN de cada variação ainda não é editável na grade de variações; use o Bling para esses campos.
- Código versionado no GitHub não equivale a deploy do backend; este PR não deve ser mesclado antes de CI e verificação no ambiente correto.

## Comandos de validação

```sh
npm run lint:js
npm run check
npm run test
npm run test:public
```
