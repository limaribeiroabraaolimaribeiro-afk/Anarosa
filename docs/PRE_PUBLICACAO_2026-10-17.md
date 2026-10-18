# Preparação da publicação — Anarosa

**Situação: backup concluído e verificações apresentadas; produção não liberada.**
Projeto confirmado pela CLI autenticada: `gpmbkptimjipqsayrvce`.
Branch: `feat/production-hardening-20261016`.
Inspeção realizada em 17/10/2026, horário de Brasília, com registros UTC de 18/10.
Esta atualização complementa a [entrega anterior](ENTREGA_2026-10-17.md).

Nenhuma migration foi aplicada, função implantada, cobrança criada, pedido/estoque
editado ou secret/flag operacional alterado. Foram usados inventários, consultas,
download de código, backups e `db push --dry-run --skip-vault`.

## Estado encontrado no projeto correto

| Verificação | Resultado real |
|---|---|
| CLI utilizada | Supabase 2.121.0; vínculo local e project-ref conferidos |
| Banco | PostgreSQL **17.6**, aproximadamente 33,9 MB |
| Migrations remotas | **8**, todas com versões correspondentes no repositório; nenhuma versão exclusivamente remota |
| Migrations pendentes | `20261017023020_commerce_integrity.sql` e `20261018010144_pre_publication_security.sql` |
| Simulação da CLI | Somente essas duas migrations; nenhum seed, role ou secret de Vault a atualizar |
| Edge Functions | **27** implantadas; **33** locais; 6 novas. As 27 existentes têm alterações próprias ou dependências compartilhadas e precisam de novo bundle |
| Backup das funções | 27/27 versões copiadas separadamente, com hashes de todos os arquivos; 82 conteúdos distintos no pacote deduplicado |
| Administração | 2 usuários Auth e 2 administradores ativos; chamada sem sessão devolve **401** |
| Catálogo | 16 produtos ativos, 10 variações ativas, 17 SKUs no estoque, 0 categorias sincronizadas |
| Atualidade do catálogo | Sincronizações de produto entre 05/09/2026 e 16/10/2026 BRT; não presumir que todos os preços/saldos estão atuais |
| Pedidos | **7 pendentes**, 6 com link de pagamento, 0 pagos, 0 enviados ao Bling |
| Provas de pagamento | 0 eventos financeiros registrados; não há comprovação real do caminho pós-pagamento |
| Bling | Conexão gravada como conectada; access token expirado no horário da inspeção; refresh token presente. Nenhum refresh foi solicitado nesta preparação |
| Envio automático de pedidos | `BLING_ORDER_SYNC_ENABLED=false`, confirmado pelo valor/digest da listagem privada; flags adicionais de validação/contatos/imagens ainda ausentes |
| Webhooks Bling | 40 processados; 1 falho (`product.created`, `bling_rate_limited`, retry 1) |
| Cron | 3 jobs existentes ativos. A execução SQL foi bem-sucedida; isso não comprova a execução HTTP dos processadores |
| Configuração privada | Somente URL/segredo do processador InfinitePay registrados; configuração do processador Bling ausente |
| Storage / Vault | 0 buckets, 0 objetos Storage, 0 registros em `vault.secrets` |
| Backup gerenciado | API retornou `backups: null`, PITR desabilitado. Não assumir recuperação gerenciada disponível |

O catálogo público respondeu **200**, com o CORS da loja; uma origem externa não
recebeu permissão CORS. O preflight InfinitePay respondeu **204**. Esses testes
não chamaram criação de pagamento nem reconciliação de pedidos reais.

## Backup efetivamente preservado

Diretório privado, excluído do Git e do Pages:

```text
.backups/gpmbkptimjipqsayrvce/20261018T005827Z/
```

Conteúdo principal:

- `database-full.dump.dpapi`: arquivo custom do PostgreSQL completo, incluindo
  schemas/dados da aplicação, Auth, histórico de migrations e configuração no banco.
- `roles.sql.dpapi`: roles e vínculos **sem senhas de roles**.
- `archive-list.txt.dpapi`: índice do arquivo.
- `functions-source.json.gz.dpapi`: código das 27 funções e suas dependências,
  com versões, hashes e `verify_jwt` de cada função.
- Inventários, advisors e manifestos de integridade; listagem privada de secrets cifrada.

O dump foi finalizado em **17/10/2026 às 21:58:27 BRT** e contém **2.567.037 bytes**
antes da cifragem. SHA-256 do arquivo PostgreSQL original:

```text
dbeb604ace903599ba60f1abcd96dff7c6da32bc8b58e762f2c1f5af5ab58ea6
```

Foram comprovados: descriptografia, hashes, presença de pedidos no índice e
decodificação integral do arquivo pelo `pg_restore 17.6` até a conclusão.
**Uma restauração em outro banco ainda não foi executada.**

Os dados foram cifrados em memória usando **Windows DPAPI CurrentUser**, no perfil
Windows do proprietário do terminal. O perfil restrito do agente não é a chave de
restauração. Para recuperar em outra máquina será necessário preservar esse perfil
ou preparar uma exportação cifrada portátil por canal privado; nenhuma senha será
incluída neste documento. A listagem de secrets contém metadados/digests, não uma
cópia recuperável dos valores de ambiente. As credenciais originais precisam
continuar disponíveis no armazenamento seguro do proprietário.

O Docker não respondeu. A cópia foi feita com os clientes portáteis oficiais do
PostgreSQL 17.6, sem instalar servidor/serviço. Houve falta de espaço; o download
integral incompleto criado nesta tarefa foi removido e somente os executáveis e
bibliotecas necessários foram obtidos do arquivo oficial, com CRC e hashes.
Nenhum arquivo pessoal foi apagado. O espaço livre continuou baixo e impede subir
uma stack local de homologação com segurança neste momento.

## Avisos de segurança e correções preparadas

O advisor remoto retornou **6 avisos, nenhum erro**:

| Aviso | Tratamento preparado, ainda não aplicado |
|---|---|
| `store_available_stock` sem search_path fixo | Migration nova fixa `pg_catalog,public,pg_temp` |
| `set_updated_at` sem search_path fixo | Migration nova fixa o caminho e restringe execução pública do helper |
| `rls_auto_enable` executável por anon | Migration nova revoga EXECUTE público, preservando o event trigger |
| `rls_auto_enable` executável por authenticated | Mesmo tratamento; função existe no projeto e foi inspecionada |
| `pg_net` registrado no schema public | Extensão **não relocável**. Não será removida/recriada: os processadores dependem dela. Tratar com orientação Supabase, sem quebra da fila |
| Proteção de senhas vazadas desabilitada | Revisar disponibilidade/configuração no plano atual. Não foi habilitado recurso nem contratado plano |

As tabelas privadas inspecionadas têm RLS e não concedem SELECT a anon/authenticated;
a view de estoque usa `security_invoker=true`. O acesso administrativo positivo
com sessão real ainda precisa ser validado em homologação.

## Compatibilidade da publicação

O frontend atualmente publicado envia `orderId` para criar o link InfinitePay e
não fornece a nova intenção aleatória do checkout. O backend novo exige intenção
e token público. **Backend e frontend precisam ser publicados em janela controlada.**

Foi preparada, somente no código local, a flag `COMMERCE_CHECKOUT_PAUSED=true`:
os dois endpoints de novos pedidos/links devolvem 503 com mensagem de manutenção.
Webhooks e consulta/reconciliação de pagamentos existentes continuam disponíveis.
A flag não foi criada no projeto. As versões antigas dos endpoints não a conhecem;
a pausa passa a valer quando os dois endpoints preparados forem implantados.

A configuração local foi alinhada a PostgreSQL major 17; isso não altera a versão
do projeto remoto. Todos os bundles devem ser atualizados, porque módulos como
contexto, repositórios e logger são dependências das funções existentes. Não basta
publicar apenas os entrypoints cujo arquivo principal mudou.

## Homologação proposta — sem criar projeto pago

O proprietário confirmou que **não existe projeto separado** e solicitou o plano.
Não foi criada branch Supabase, projeto ou infraestrutura com cobrança.

1. **Preparar ambiente local:** liberar espaço suficiente e tornar o Docker já
   instalado operacional. Preservar o backup privado; não limpar dados da loja
   nem volumes pessoais para conseguir espaço. Confirmar a capacidade antes de
   baixar imagens ou iniciar a stack.
2. **Testar recuperação isoladamente:** restaurar a cópia em PostgreSQL/Supabase 17
   descartável, com saída de rede bloqueada desde antes da restauração. O dump
   inclui cron, URLs e tokens de produção: não pode ser ligado com egress aberto.
   Conferir schemas, constraints, RLS, funções e contagens. Desabilitar os jobs e
   remover/substituir credenciais/URLs apenas nessa cópia antes de permitir uso.
3. **Homologar a aplicação em base sintética:** ambiente local diferente da cópia
   de recuperação, com dados de teste e usuários administrativos próprios. Aplicar
   as duas migrations nesse ambiente somente após aprovação desta etapa.
4. **Bling simulado:** testar produto simples/grade, SKU duplicado, preço por tamanho,
   saldo zero, depósitos, imagens condicionadas a permissão, 401/403/429/timeout,
   pedido pago → contato → pedido ERP → retorno do estoque e recuperação sem POST
   duplicado. Proibir saída para a conta real durante esses testes.
5. **InfinitePay simulada:** conferir centavos, frete indefinido, idempotência, link
   existente, resultado ambíguo, webhook duplicado, amount divergente, URL forjada,
   pagamento pendente e aprovado → fila. Usar provider injetado; a documentação
   consultada não confirmou um ambiente financeiro sandbox para esta conta.
6. **Integrações reais, etapa separada:** validar escopos Bling na conta, canal,
   situação, parcelas e política de baixa; escolher registros exclusivos de teste.
   Refresh OAuth, alteração no ERP, criação de links ou pagamento real precisam de
   aprovação específica antes de execução. Manter os 7 pedidos atuais fora do teste.

Não foi alterada a conta Bling, feito refresh, criado link ou invocado pagamento.
As permissões numéricas gravadas na conexão não foram convertidas por suposição
em autorização de escrita de produtos, imagens, contatos ou pedidos.

## Sequência de implantação a aprovar após a homologação

| Etapa | Ação proposta | Condição para avançar |
|---|---|---|
| 0 | Revalidar ambiente, branch, hashes, estado financeiro e renovar o backup imediatamente antes da janela | Restauração ensaiada; credenciais disponíveis; backup novo verificado |
| 1 | Definir pausa de checkout e implantar somente `storefront-checkout` e `infinitepay-create-payment` preparados para a pausa | Ambos retornam 503; nenhum pedido/link novo pelo site; existentes preservados |
| 2 | Aplicar as duas migrations na ordem mostrada pelo dry-run, com `--skip-vault`, sem seeds/roles extras | Schema e privilégios conferidos; advisors comparados; nenhum pedido reescrito |
| 3 | Implantar os demais bundles existentes e as seis funções novas, por grupos e com project-ref explícito | Tipos/testes e smoke checks de leitura aprovados por grupo; JWT administrativo preservado |
| 4 | Configurar endereço, métodos e regras reais; publicar frontend após backend; conferir cache/atualização das páginas | Navegador usa os contratos novos; catálogo real e login autorizados/negados verificados |
| 5 | Retirar somente a pausa do checkout, após autorização comercial | Frete e preço corretos, tratamento de falhas validado; nenhum pagamento de teste disparado automaticamente |
| 6 | Habilitar contato/imagens/envio ao Bling e configurar a fila, cada um após sua homologação e aprovação | Comprovação de permissões, situação e baixa única por SKU; monitoramento disponível |

`BLING_ORDER_SYNC_ENABLED` deve permanecer falso até a etapa 6. Não preencher a
URL da nova fila nem ativar os demais gates para "ver se funciona". A homologação
financeira real continua separada da publicação de telas e funções.

Os comandos de implantação usarão a CLI conferida, `--project-ref` explícito e
`--use-api` quando apropriado. Não usar `--prune`, `--include-all`, `--include-seed`,
`--include-roles`, `migration repair` ou `db reset` nesse projeto.

## Reversão e critérios de interrupção

Interromper se houver divergência de schema, acesso administrativo indevido, erro
de preço/frete, duplicação, falha de gravação, pagamento sem prova ou mudança de
estoque não explicada. Manter os endpoints de criação pausados durante a reversão.
Restaurar código por função usando o snapshot da sua versão, sem misturar módulos
compartilhados de versões diferentes. Preservar as tabelas/colunas novas e os eventos.

Uma restauração integral do banco de produção não será automática: poderia apagar
pagamentos e eventos recebidos depois do backup. Exige outra aprovação, comparação
dos eventos posteriores e plano para preservar essas transações. A falta de PITR
comprovado torna esse cuidado especialmente relevante.

## Evidências e validações locais desta etapa

- **217 testes Deno aprovados**, incluindo a pausa de publicação.
- **12 testes PostgreSQL PGlite aprovados**, incluindo o endurecimento de helpers.
- Verificação de tipos e sintaxe JavaScript aprovadas.
- Os cinco scripts PowerShell passaram na análise de sintaxe; a varredura de segredos cobriu 133 arquivos sem ocorrências.
- As 16 verificações de navegador da entrega anterior permanecem registradas; o
  frontend não foi alterado nesta preparação.
- Backup cifrado e manifesto preservados em `.backups/`; inventários e logs privados
  complementares em `tmp/prepublicacao-20261017/`, ambos fora do artefato público.
- `db push --dry-run --skip-vault` confirmou as duas pendências sem aplicar alterações.
- Consulta final confirmou ainda **8 migrations**, ausência de `store_settings` e
  endurecimento ainda não aplicado; pedidos continuam em 7, eventos financeiros em 0.

Scripts preparados: `collect-supabase-preflight.ps1`, `backup-remote-functions.ps1`,
`backup-linked-database.ps1`, `verify-private-backup.ps1`,
`preserve-release-backup.ps1`, `compare-supabase-release.cjs` e consultas em
`scripts/sql/`; `package-functions-backup.cjs` valida e deduplica o snapshot de funções antes da cifragem. A coleta não altera os dados da aplicação. Os backups verificados
não podem ser sobrescritos: a próxima cópia exige outro diretório.

## Fontes oficiais verificadas

- [Backup e restauração com CLI](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)
- [Limites de backups gerenciados e Storage](https://supabase.com/docs/guides/platform/backups)
- [Clientes oficiais PostgreSQL para Windows](https://www.postgresql.org/download/windows/)
- [Contrato InfinitePay](https://www.infinitepay.io/checkout-documentacao)
- [Aplicativos e permissões Bling](https://developer.bling.com.br/aplicativos)
- [Aviso PostgreSQL 17.11](https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes): não atualizar o engine como parte desta publicação; revisão separada de extensões/criptografia.
- [Aviso TLS](https://supabase.com/changelog/cbc-tls-ciphers-deprecated): os acessos desta preparação funcionaram com clientes atuais; não foram alteradas configurações TLS.
