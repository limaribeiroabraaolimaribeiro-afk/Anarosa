# INSTRUCAO PRONTA PARA O CODEX — GESTAO ANAROSA

Implemente no meu repositorio da **Gestao Anarosa** o novo visual da pagina **Produtos > Novo produto** conforme a imagem `referencias/01_Tela_Completa_Novo_Produto.png`.

Leia PRIMEIRO `LEIA-ME.md` e `ESPECIFICACAO_VISUAL_E_FUNCIONAL.md`. Consulte os arquivos de `recortes/` para ver detalhes da barra lateral, cabecalho, formulario, variacoes, previa, status, checklist e canais.

## Regras principais

1. Inspecione a arquitetura e os arquivos do projeto antes de editar. Identifique rotas, componentes, estilos, autenticacao, chamadas de dados, validacoes, produtos, variacoes, estoque, imagens e canais.
2. Recrie o mockup em componentes **reais, responsivos e editaveis**; nao use a imagem como fundo, iframe ou HTML estatico sem funcionamento.
3. Preserve login, controles de acesso, RLS, Supabase, gestao de produtos/estoque, Bling e integracoes existentes. Nao altere contratos de API sem necessidade ou testes.
4. Preserve dados reais. Nao use 'Amanda', o conjunto listrado, avaliacoes 4.8, precos, estoques ou status de canais como dados permanentes; eles sao MOCKUP ilustrativo.
5. Os componentes visuais devem seguir a captura: sidebar creme, cor marrom/dourado, espacos arejados, titulo serifado, cards claros, botoes de rascunho/visualizacao/publicacao, galeria, formularios, tabela de cor/tamanho, previa da loja, checklist e canais.
6. Mantenha o fluxo funcional de variacoes com SKU por tamanho/cor, estoque por variacao/deposito, precos, fotos, categorias e validacoes.
7. A tela de variacoes aparece cortada na imagem. Nao invente behavior ou campos obrigatorios que contrariem o codigo atual.
8. Adapte o layout para mobile e tablet com menu recolhivel e formularios legiveis. Garanta acessibilidade.
9. Nao publique nem faca deploy sem pedido explicito. Trabalhe em branch, apresente alteracoes, testes e qualquer pendencia.

## Ordem de execucao

A) Levantar o estado atual e listar arquivos/telas afetados.
B) Propor plano de componentes e possiveis riscos (especialmente login, criacao de produto e estoque).
C) Implementar estrutura visual reutilizando a stack do projeto.
D) Integrar ao estado/dados/acoes reais.
E) Rodar build, lint e testes disponiveis. Acrescentar testes para fluxos alterados.
F) Comparar tela resultante com a imagem e ajustar detalhamento e responsividade.
G) Entregar resumo de arquivos alterados, diferencas versus mockup, comandos para rodar e riscos pendentes.

Se houver informacao faltando no mockup, use o comportamento do software existente, SEM substituir dados reais por exemplos.
