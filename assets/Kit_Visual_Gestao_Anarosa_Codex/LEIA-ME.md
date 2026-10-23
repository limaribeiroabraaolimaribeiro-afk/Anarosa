# KIT DE REFERENCIA VISUAL — GESTAO ANAROSA

## O que ha aqui

Um pacote de handoff para o Codex implementar no codigo existente o novo visual da **Gestao Anarosa**, usando como referencia uma captura de tela aprovada/fornecida pelo usuario, focada na pagina **Produtos > Novo produto**.

- `referencias/01_Tela_Completa_Novo_Produto.png`: imagem integral, sem alteracoes (1448 x 1086 pixels).
- `referencias/01b_Tela_Marcada_Referencia.png`: mesma imagem com caixas/indices para identificar as secoes.
- `recortes/*.png`: 8 recortes da imagem para inspecao detalhada pelo Codex, NAO sao telas independentes.
- `PROMPT_PARA_CODEX.md`: instrucao pronta para colar no Codex.
- `ESPECIFICACAO_VISUAL_E_FUNCIONAL.md`: mapeamento de layout, interacoes e pontos de atencao.
- `TOKENS_REFERENCIA.css`: tokens visuais aproximados, derivados/interpretados da imagem, para orientar CSS. Ajustar conforme o projeto.
- `ARQUIVOS.json`: lista de arquivos e sua procedencia.

## Limites IMPORTANTES

1. Foram encontradas **duas copias com conteudo visual identico** do mesmo mockup, nao uma colecao de telas diferentes. Este kit contem **uma imagem-base unica** e os recortes derivados dela.
2. O mockup mostra uma proposta de interface: **nao e codigo nem prova de funcionamento**. Foto de modelo, precos, contas, estoque, nota de avaliacao, nome da administradora e status de marketplace sao exemplos de tela; nao trate como dados reais.
3. A parte inferior de 'Variacoes (Tamanhos e Cores)' fica cortada no screenshot. Preservar o fluxo REAL existente, sem inventar regras comerciais.
4. Nao incluir a captura como imagem de fundo da pagina; **reconstruir os elementos em HTML/CSS/componentes editaveis**.
5. Nao substituir, desligar nem contornar login, autorizacao de administradores, integracoes ou banco de dados.

## Como entregar para o Codex

Anexe este ZIP ou extraia os arquivos para uma pasta local; na raiz do repositorio, indique ao Codex o arquivo `PROMPT_PARA_CODEX.md` e a imagem integral.

Fluxo recomendado: analisar o repositorio -> identificar as telas existentes -> planejar mudancas por componentes -> implementar em branch -> rodar testes -> conferir comparativo visual desktop/mobile -> entregar diff e instrucoes de deploy.
