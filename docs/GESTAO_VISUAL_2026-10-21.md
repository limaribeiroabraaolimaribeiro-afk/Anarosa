# Gestão Anarosa — atualização visual de 21/10/2026

Implementação local na branch `feat/gestao-visual-20261021`. Sem deploy, alteração de banco, configuração remota ou gravação de produtos de teste em produção.

## Implementação

- Shell administrativo com sidebar creme, ícones em SVG, tipografia local DM Sans/Cormorant Garamond, busca por produtos/pedidos/clientes e navegação responsiva.
- Novo Produto e Editar Produto passam a ocupar a área principal, dentro da aplicação autenticada. As telas operacionais existentes continuam disponíveis.
- Formulário em cards numerados: fotos, dados básicos, descrição, preço, variações, estoque, logística e fiscal.
- Galeria com múltiplos links HTTPS, imagem principal, reordenação por botões ou arraste, exclusão e prévia. Escrita condicionada à capacidade `images` retornada pela API.
- Prévia atualizada pelo formulário, sem reviews, preços, fotos ou estados de marketplace inventados.
- Checklist de preenchimento, status do último cadastro carregado e indicação explícita de situações não informadas pelos canais.
- Rascunho cria cadastro inativo no Bling; Publicar cria cadastro ativo pelo serviço existente. Rascunhos também exigem nome, SKU e preço válidos. Na edição, Salvar alterações respeita o controle de ativo/inativo.
- Variações mantêm IDs, SKU próprio, preço, tamanho, cor e ativação. Novas combinações/SKUs repetidos são bloqueados no formulário; o servidor mantém suas validações existentes. Variações persistidas são desativadas, nunca removidas pelo editor.
- Saldos de variações são apresentados quando disponíveis na listagem. Ajustar estoque abre o fluxo existente por SKU e depósito; saldo zero continua permitido. O salvamento do cadastro não movimenta estoque.
- Campos de peso, volumes, dimensões em centímetros e classificações fiscais mantêm o contrato existente.
- Carregamento, bloqueio durante envio, mensagens de validação, erros e proteção contra respostas atrasadas do editor.

## Preservação

Nenhuma modificação em autenticação Supabase, autorização administrativa, RLS, tabelas, Edge Functions, contratos de API, credenciais, integração Bling, sincronização, InfinitePay, checkout ou páginas públicas.

As mutações continuam usando sessão administrativa, revisão do cadastro e chave de operação para evitar duplicação. A confirmação só é exibida após a resposta da API, inclusive sua mensagem de sincronização pendente.

`.mcp.json` e o kit visual já estavam não versionados e foram preservados. As imagens de referência foram excluídas do artefato público; são material de desenvolvimento.

## Dependências ainda pendentes

| Recurso | Situação |
| --- | --- |
| Upload de arquivos / arrastar arquivos locais | API atual informa `binaryUpload: false`. Requer armazenamento, endpoint e permissões definidos. Arraste implementado apenas para ordenar fotos já cadastradas por URL. |
| Gravação de fotos por URL | Requer `capabilities.images: true` na conexão; nenhuma flag remota foi alterada. Em leitura, os controles de alteração ficam desabilitados. |
| Preço promocional, período e destaque | Não são editáveis no contrato atual do editor. A interface informa a dependência; preço normal e preços de variações continuam funcionais. |
| Coleção, gênero independente e tags | Não há persistência desses campos no contrato atual. Coleção e gênero aparecem indisponíveis; categorias existentes e atributos de tamanho/cor continuam disponíveis. |
| GTIN por produto/variação | Diferenciado explicitamente do SKU, sem criar um campo que descarte dados. Edição permanece no Bling. |
| Mercado Livre / Shopee | API não fornece vínculo por produto. Interface informa situação desconhecida, sem botão fictício de vinculação ou exportação automática. |
| Avaliações e parcelamento | Não existem fontes adequadas para os exemplos do mockup. Nenhuma avaliação ou condição financeira fictícia é exibida. |
| Editor de texto rico | Descrição permanece texto, conforme solução existente, sem inserir HTML do usuário. |
| Menus sem implementação | Conteúdo, relatórios e gestores independentes de marcas/atributos não foram apresentados como páginas funcionais. |

Categoria permanece opcional como no contrato existente. A apresentação visual não muda regras do backend. A grade preserva o fluxo por SKU em vez de transformar o estoque em uma gravação junto ao cadastro.

## Arquivos

- `gestao/index.html`: shell, navegação, fontes locais e ponto de montagem do formulário.
- `gestao/css/product-editor.css`: novo sistema visual restrito ao painel e responsividade.
- `gestao/js/product-editor.js`: formulário, galeria, prévia, checklist, variações e capacidades.
- `gestao/js/gestao.js`: integração com navegação, salvamento, rascunho e controle de estoque existentes.
- `scripts/build-public.cjs`: inclusão do CSS e exclusão do kit de referências no build.
- `tests/browser/admin.spec.cjs`: testes novos e capturas.
- `docs/screenshots/gestao-2026-10-21/desktop.png` e `mobile.png`: evidências visuais.
- Este relatório.

## Validação

| Comando | Resultado |
| --- | --- |
| `npm.cmd run lint:js` | Passou |
| `npm.cmd run check` | Passou |
| `npm.cmd run build:public` | Passou; 30 arquivos de aplicação mais assets |
| `npm.cmd test` | 217 testes passaram |
| `npm.cmd run test:db` | 12 testes passaram |
| `npm.cmd run test:preview` | 3 testes passaram |
| `npm.cmd run test:browser -- --workers=2` | 52 testes passaram |
| `git diff --check` | Passou |

Navegador: autenticação rejeitada, edição com IDs/revisão preservados, rascunho/inativo, publicação/ativo, falhas e repetição da mesma operação, galeria, validação de URLs e combinações, estoque zero por depósito, prévia e navegação. Os testes existentes da loja, carrinho e checkout também passaram. Larguras verificadas: 320, 390, 768, 1024 e 1440 px.

As capturas usam dados explicitamente marcados como teste e fotos servidas por mocks locais. Não são produtos criados no catálogo. Os testes de navegador bloqueiam requisições externas não simuladas. Não foi feita homologação autenticada com gravações na conta real.

## Visualização local

No PowerShell, na raiz do projeto:

```powershell
npm.cmd run build:public
$env:ANAROSA_PUBLIC_ROOT = (Resolve-Path '_site').Path
node scripts/serve-local.cjs
```

Acesse `http://127.0.0.1:5500/gestao/#/produtos`, entre com uma conta administrativa já autorizada e clique em **Novo produto** ou **Editar**.

Este é o painel real servido localmente: depois do login, salvar e ajustar estoque usam o backend configurado. Para inspecionar o visual sem login ou gravações, abra as capturas deste diretório. Para repetir a validação isolada, use a suíte de navegador.

Não execute dois builds enquanto a suíte de navegador estiver usando `_site`: o build recria essa pasta.
