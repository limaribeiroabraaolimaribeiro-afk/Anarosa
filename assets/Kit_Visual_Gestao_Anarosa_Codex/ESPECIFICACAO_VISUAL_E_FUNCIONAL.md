# Especificacao de implementacao visual e funcional

## Escopo confirmado pela referencia

A captura se refere a **Gestao Anarosa / Produtos > Novo produto**. Nao representa todas as telas do sistema. Reutilizar o design system nas demais telas somente onde nao houver conflito com funcionalidades ja existentes; novos layouts adicionais dependem de referencia ou aprovacao.

### Estrutura da tela

**1. Menu lateral**
- Fundo creme/bege; logo Anarosa em destaque no topo.
- Itens: Dashboard, Produtos (submenu: Todos os produtos, Novo produto, Categorias, Marcas, Atributos Tamanhos/Cores), Pedidos, Clientes, Conteudo, Relatorios, Configuracoes.
- Item ativo destacado com bloco bege e tipografia marrom. Slogan/imagem decorativa inferior na referencia.
- Menu colapsavel em telas estreitas, sem bloquear navegacao.

**2. Cabecalho**
- Campo global de busca; botao de abrir/fechar menu; notificacoes, ajuda, perfil da administradora.
- Breadcrumb 'Produtos > Novo produto', titulo serifado 'Novo Produto', subtitulo explicativo.
- Acoes: Salvar rascunho, Visualizar, Publicar produto.

**3. Fotos do produto**
- Card branco com titulo numerado. Grade de 4 miniaturas e area 'Adicionar fotos'.
- Distinguir imagem principal; permitir adicionar/remover/reordenar imagens se ja suportado pelo backend.
- Fotos reais do produto, nao imagens exemplificativas fixas da proposta.

**4. Informacoes basicas**
- Nome (obrigatorio), SKU (obrigatorio), marca, categoria (obrigatoria), colecao, segmento/genero.
- Descricao curta com contador, descricao completa com editor de texto rico caso o projeto ja possua solucao segura, tags removiveis.
- Reusar validacao, modelo de dados e regras existentes. Nao introduzir HTML de usuario sem sanitizacao.

**5. Preco e vendas**
- Preco normal, promocional, periodo opcional da promocao, toggles de destaque/promocao.
- Moeda BRL e datas no padrao brasileiro. Validar preco promocional de acordo com regra de negocio existente.
- Widget de parcelamento aparece como representacao visual; calculo real so se ja houver fonte confiavel de regras e taxas.

**6. Variacoes: tamanhos e cores**
- Seletor de cores, tamanhos, grade de estoque por combinacao (cor x tamanho).
- Dados editaveis; preservar SKU unico de cada variacao e saldo por deposito, sem somar indevidamente no produto pai.
- Permitir zero estoque; salvar e reabrir sem perder combinacoes; prevenir duplicatas.
- Screenshot exibe apenas parte inicial dessa secao. Dar prioridade ao comportamento atual real.

**7. Coluna direita: previa**
- Cartao de previa com imagem, titulo, preco, possivel promocao, navegacao de galeria.
- Previa atualiza com os dados preenchidos e usa placeholder somente quando o formulario estiver vazio.
- Estrelas/avaliacoes do mockup sao demonstrativas: NAO inventar avaliacoes ou reviews para produto novo.

**8. Status, checklist e canais**
- Status de publicacao, checklist de campos concluidos, progresso conforme validadores reais.
- Canais: loja propria, Mercado Livre, Shopee, apenas com estados reais da aplicacao.
- Botao Vincular deve seguir o fluxo autentico de integracao; nao mascarar vinculos ou exibir disponibilidade ficticia.
- 'Publicar produto' significa a acao realmente suportada e autorizada no sistema; verificar fluxo, nao disparar exportacao de marketplace sem confirmacao/regras.

## Preservacao obrigatoria

- Manter login, sessao, autorizacao e papel do administrador; nunca bypassar RLS.
- Nao sobrescrever configuracoes, tokens, chaves ou contratos das Edge Functions/Supabase, Bling, Shopee, Mercado Livre, checkout/pagamentos.
- Nao criar produtos ficticios em producao; usar mocks apenas em testes/Storybook com dados indicados como exemplo.
- Manter acessibilidade: labels, estados de foco, atalhos, texto alternativo e navegacao por teclado.
- Manter responsividade: desktop proximo a captura; mobile com menu recolhivel, uma coluna para formulario, previa abaixo ou via aba.
- Usar componentes reutilizaveis e estilos do framework ja presente; nao migrar stack sem autorizacao.

## Validacao/criterios de aceite

1. Tela desktop proxima a imagem integral em largura ~1448px.
2. Mobile sem rolagem horizontal desnecessaria, botoes e inputs acessiveis.
3. Formulario continua criando/editando produtos reais com persistencia, validacao e variacoes.
4. Fotos: upload/ordem/exclusao e imagem principal funcionam conforme implementacao existente.
5. Previa acompanha alteracoes sem expor dados ficticios.
6. Salvar rascunho, visualizar e publicar respeitam fluxos e permissoes reais.
7. Login e APIs continuam funcionando. Testar regressao de autentificacao, produtos e estoque.
8. Relatar claramente o que foi implementado, o que ficou apenas como visual e quais dependencias faltam.

## Nota de exatidao visual

Cores e tamanhos no CSS sao ponto de partida aproximado; tipografias aparentam combinar serifada elegante nos titulos e sans-serif discreta nos formularios. Foto, logo e elementos decorativos embutidos no mockup nao sao assets isolados em alta resolucao. Se o repositorio ja tiver logo/assets originais, reutilizar os existentes; nao recortar a foto de referencia para usá-la como imagem real de produto.
