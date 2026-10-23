# Publicação da Gestão Anarosa — 23/10/2026

Publicação autorizada pelo proprietário nesta conversa. Branch preparada sobre
`main` (`0055be77dfab50f18c4871ee8ef8b5187935edf7`), sem incorporar as alterações
antigas de checkout, pagamentos e integração de pedidos presentes na branch de trabalho.

## Escopo

- Novo visual da Gestão e editor de produto: fotos por URL conforme permissão,
  prévia, checklist, preços, dados fiscais e logísticos, tamanhos/cores, rascunho inativo e publicação ativa.
- Mantidos login Supabase, autorização `store_admins`, APIs públicas e checkout em produção.
- Funções administrativas atualizadas: `admin-product-create`, `admin-product-update`,
  `admin-stock-adjust`.
- Novas funções: `admin-product-detail`, `admin-stock-history`.
- Migração aditiva `20261023225251_gestao_product_operations.sql`: tabela e duas
  RPCs exclusivamente administrativas, acessíveis apenas ao serviço. RLS habilitada.
  Nenhuma alteração em tabelas de pedidos, pagamentos, catálogo ou estoque.
- Gravações preservam revisão e identidade de operação; resultados incertos exigem
  conferência antes de repetir. O novo registro usa nomes `gestao_*` para não conflitar
  com a migração antiga de integridade comercial ainda pendente em outra branch.
- O build mantém a versão por hash dos scripts/estilos e exclui o kit de referências.

As dependências do painel foram selecionadas porque ainda não estavam implantadas.
Os módulos financeiros e suas migrations não fazem parte desta publicação. As versões
anteriores das três funções atualizadas foram baixadas em
`.backups/gestao-release-20261023/`, fora do Git e do artefato público.

## Limitações mantidas

Upload binário depende de armazenamento e endpoint próprios. A galeria permite links
HTTPS somente quando a conexão habilita imagens. Promoções, coleção, tags, GTIN,
editor rico e vínculos de marketplaces permanecem conforme as limitações declaradas
na interface. Nenhuma flag de imagem, contato, envio automático ao ERP ou pagamento
foi ativada por este deploy.

## Validação antes da publicação

- 68 testes de navegador passaram em desktop e celular, incluindo os contratos
  publicados de Pix, cartão na retirada e WhatsApp, todos com tráfego externo interceptado.
- 202 testes Deno passaram; acrescida uma verificação específica de balanço de estoque zero.
- 3 testes PostgreSQL isolados: exclusão de operações concorrentes, repetição segura,
  resultados incertos e negação de acesso a anon/authenticated.
- 4 testes do artefato público, verificação JavaScript e checagem TypeScript passaram.
- Comparação com main confirma que arquivos da loja pública e checkout permanecem idênticos.

Não foram criados produtos, ajustados saldos ou executados pagamentos reais para validar o deploy.
Após publicar, conferir o resultado do GitHub Pages, os arquivos servidos e os endpoints
administrativos sem sessão (devem negar acesso).

## Reversão

Reverter o commit de publicação na main para restaurar o frontend. Se necessário,
reimplantar as três funções anteriores pelos backups preservados. A tabela nova é
aditiva e pode permanecer para preservar o histórico; não removê-la como parte de
uma reversão visual. As duas funções novas não precisam ser removidas para restaurar
o frontend anterior.
