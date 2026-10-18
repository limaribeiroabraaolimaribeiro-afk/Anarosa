# Homologação local Anarosa — 17/10/2026

**Restauração integral e duas migrations locais aprovadas. Publicação ainda não autorizada.**

Projeto de produção: `gpmbkptimjipqsayrvce`. Branch:
`feat/production-hardening-20261016`. Horário de Brasília; os registros UTC
correspondem a 18/10. Esta etapa executa a autorização de homologação local e
complementa a [preparação da publicação](PRE_PUBLICACAO_2026-10-17.md).

## Restauração comprovada

Foi restaurado o arquivo original cifrado em
`.backups/gpmbkptimjipqsayrvce/20261018T005827Z/`, sem substituí-lo ou editar seus
manifestos históricos. O SHA-256 do arquivo PostgreSQL decifrado foi confirmado:

`dbeb604ace903599ba60f1abcd96dff7c6da32bc8b58e762f2c1f5af5ab58ea6`

O destino exclusivo foi `anarosa_restore`, no container
`anarosa-restore-20261017-v3`, PostgreSQL **17.6**. Imagem pública fixada:

`supabase/postgres@sha256:49c938c7918f1543618b60568f5a995e52d98f19883075a14f89643e8b1571fe`

- Rede `none`, zero portas publicadas, conexões apenas pelo socket Unix `/tmp`.
- Filesystem raiz somente leitura, sem capabilities e sem novos privilégios.
- Dados em `tmpfs` de 256 MiB; limite de memória do container de 512 MiB.
- `cron.launch_active_jobs=off` desde o primeiro arranque. O worker `pg_net`
  aponta para o banco `postgres` vazio, separado do banco restaurado.
- Backup decifrado apenas em memória e pipes; nenhum dump com dados pessoais
  ou tokens foi gravado em texto aberto no host. Logs potencialmente sensíveis
  foram cifrados com DPAPI.

A restauração usou `pg_restore --single-transaction --exit-on-error`. Antes de
qualquer migration pendente, passaram **16 verificações de integridade**:

| Evidência | Resultado |
|---|---|
| Dados de todas as 56 tabelas com blocos COPY no arquivo | Mesmo número de linhas e SHA-256 do conteúdo por tabela; comparação em memória |
| Oito migrations originais | Versões, nomes, quantidade e hash dos statements iguais |
| Colunas, funções e constraints da aplicação | Iguais ao inventário de origem; definições das funções conferidas por hash |
| RLS, políticas e permissões de tabelas/funções | Iguais ao inventário; constraints validadas |
| Auth e Storage | Dois usuários e dois confirmados; Storage sem buckets/objetos |
| Extensões | Mesmas versões de `pg_cron`, `pg_net`, Vault, pgcrypto, UUID e pg_stat_statements |
| Propriedade/permissões do migrador | Banco pertencente a `postgres`; papel `postgres` sem SUPERUSER após o restore |
| Isolamento | Socket exclusivo, cron inativo e worker HTTP fora do banco restaurado |

Os hashes de linhas foram comparados sem depender da ordem física dos registros.
A comparação de metadados normaliza a ordem das chaves JSON e o `search_path`
da sessão; não ignora diferenças de definição ou privilégio.

## Migrations aplicadas exclusivamente no clone

Depois da aprovação da integridade, foram executados os arquivos existentes,
sem alterar seu SQL, como papel **postgres**, em **uma única transação**:

| Migration | SHA-256 do arquivo executado | Resultado local |
|---|---|---|
| `20261017023020_commerce_integrity.sql` | `2ee768b10a0ca3e53c083eebfbc012ed370929056c9df562428b1e67e0ad93a5` | Aplicada |
| `20261018010144_pre_publication_security.sql` | `466ac2111b52c132b7844d34762116cfd32dfbe4dcf8ad0e80a8d7a0999d85b0` | Aplicada |

O histórico do clone passou de 8 para **10 versões**. O registro local guarda o
SQL integral de cada arquivo no array `statements`; não foi usado `migration
repair`, `db push`, `db reset` ou qualquer comando remoto de implantação.

Os hashes de todos os campos originais dos **sete pedidos** e de todos os seus
itens permaneceram iguais antes/depois. Apenas as seis colunas aditivas foram
excluídas dessa comparação. Continuaram zero pagos e zero eventos financeiros;
nenhum evento de pedido foi criado pela migration. As três tabelas novas têm
RLS, checkout permanece privado e os helpers têm ACL/search_path corrigidos.

## Testes executados

Uma segunda base, **`anarosa_synthetic`**, recebeu apenas o schema migrado e
extensões necessárias. Nenhuma linha de usuário, sessão, pedido, estoque,
conexão Bling ou configuração privada foi copiada para ela.

Passaram **11 verificações PostgreSQL**, incluindo duas sessões reais concorrentes
comprando as mesmas duas unidades: uma compra aceita e outra recusada por estoque.
Também passaram preço de servidor, replay idempotente, prova de pagamento com
valor divergente/duplicada, receita paga, cancelamento inseguro e negação de
acesso para anon/authenticated. Todos os identificadores financeiros eram
sintéticos; nenhum provider HTTP foi chamado. Os hashes dos pedidos restaurados
continuaram intactos depois desses testes.

A suíte foi repetida **depois** da restauração e das migrations:

| Verificação | Resultado final |
|---|---|
| Backend Deno, incluindo Bling/InfinitePay simulados | **217 aprovados, zero falhas** |
| Banco PGlite, com as dez migrations | **12 aprovados, zero falhas** |
| Navegador desktop/mobile | **18 aprovados, zero falhas** |
| Tipos de todas as Edge Functions | Aprovados |
| Sintaxe JavaScript, PowerShell e Bash | Aprovada |
| Varredura de segredos | 140 arquivos, nenhuma ocorrência |
| Artefato público | 25 arquivos da aplicação + imagens/fontes; backups e ferramentas excluídos |

Deno não recebeu permissão de rede. Os testes de navegador agora negam
requisições externas não respondidas pelos mocks; dois testes novos comprovam
`ERR_BLOCKED_BY_CLIENT`. Navegador executado com um worker para caber na máquina.

Isso comprova banco real e contratos simulados. **Não foi iniciada a stack completa
Supabase com Auth, PostgREST, gateway e Edge Runtime**, nem testado OAuth real,
criação real de links ou recebimento real de webhooks. Esses itens não devem ser
apresentados como homologados por este ensaio.

## Espaço, recuperação do Docker e problemas registrados

A máquina começou com aproximadamente 638 MiB livres. Foram limpos somente
caches regeneráveis: downloads npm, instalações npx antigas/duplicadas, pip,
Chromium completo em cache (headless preservado), Puppeteer, VSIX baixados pelo
VS Code e caches de código/páginas dos navegadores. Nenhum backup, documento,
arquivo do projeto, configuração pessoal, histórico ou cookie foi excluído.
Arquivos de cache bloqueados e o instalador do VS Code em uso foram preservados.
Após parar a VM, a medição final foi aproximadamente **2,2 GiB livres**; a imagem
Docker de ensaio continua em cache. Esse espaço ainda é curto para uma stack completa.

O Docker estava travado desde 10/10, com WSL parado. O reinício normal travou;
foram encerrados somente seus processos e o Desktop foi reaberto. O inventário
anterior ao ensaio mostrou zero imagens, containers e volumes cadastrados.

O download inicial terminou com `unexpected EOF`; a extração seguinte encontrou
erro de I/O quando o host ficou sem espaço. Uma checagem `e2fsck -fn` desmontada
registrou inconsistências. O próprio bootstrap do Docker registrou uma tentativa
interna de provisionamento/formatação com falha. **Não foi executado reset, prune,
comando manual de formatação, exclusão de VHD ou reparo `e2fsck -y`.** Não se
afirma que o VHD permaneceu byte a byte intacto: a recuperação do Docker escreveu
nele. A opção `DataFolder` ensaiada não altera o caminho WSL nesta versão e foi
removida; a configuração anterior foi guardada.

Com mais espaço e outro arranque, a engine 29.8.2 baixou a imagem e executou o
ensaio completo. A última checagem somente leitura do VHD desmontado retornou
**exit 0**, mas ainda mostrou divergências nos contadores de blocos/inodes livres
com o replay do journal omitido por ser uma checagem sem escrita. Não houve
correção manual. **Saúde definitiva do armazenamento local continua pendente de
confirmação; não usar esse VHD como única cópia de dados importantes.**

Outros problemas resolvidos durante o ensaio:

- GRANTs PostgreSQL 17 exigiram manter `supabase_admin` como identidade de
  bootstrap. A criação duplicada desse papel foi omitida somente no restore local.
- `pg_net` exigiu preload. Foi carregado sem rede e com worker fora do clone.
- A transferência do event trigger de plataforma exigiu SUPERUSER temporário
  para `postgres` local; o atributo foi revertido em `finally`, antes da verificação.
- O banco de destino precisou pertencer a `postgres` para reproduzir a permissão
  CREATE do schema público. Tentativas de migration anteriores abortaram com
  histórico ainda em oito versões. Os arquivos de migration não foram modificados.
- A cópia de schema sintética exigiu substituir o schema público inicial vazio e
  instalar as extensões referenciadas; falhas anteriores tiveram rollback integral.
- A primeira rodada concorrente dos testes falhou por memória (PGlite) e teve
  três timeouts no navegador. Os logs foram mantidos; a repetição sequencial passou.

## Produção e segurança restante

O SELECT agregado final, às **23:08:54 de 17/10**, confirmou **8 migrations**, zero
das duas versões novas, ausência de `store_settings`, sete pedidos, zero pagos e
zero eventos de webhook financeiro. Nenhuma Edge Function foi publicada; nenhum
secret, flag, cron ou integração de produção foi alterado nesta homologação.

Os advisors finais de produção continuam com **6 WARN e 0 ERROR**:

| Aviso | Situação |
|---|---|
| Search path de `store_available_stock` e `set_updated_at` | Duas correções aprovadas localmente; dependem da migration autorizada em produção |
| Execução anon/authenticated de `rls_auto_enable` | Duas correções aprovadas localmente; dependem da mesma migration |
| `pg_net` registrado em public | Mantido; extensão não relocável. Não remover/recriar sem plano específico |
| Proteção contra senhas vazadas desabilitada | Configuração Auth ainda pendente; não habilitada nesta etapa |

O backup DPAPI depende deste perfil Windows. O ensaio comprovou sua restauração
com esse perfil, não recuperação após perda do perfil/máquina. Segredos de
ambiente não foram exportados em texto aberto; seus digests não recuperam valores.
Antes da publicação, preparar custódia recuperável das credenciais e uma cópia
cifrada fora desta máquina com chave de recuperação guardada separadamente.

## Evidências e encerramento seguro

Evidências privadas preservadas em
`.backups/homologacao-local/2026-10-17/`, com manifesto de hashes e atestado novo
`homologation-attestation.json`. Os manifestos originais que diziam
`full_restore_tested: false` registram a situação anterior e não foram sobrescritos.
O atestado novo comprova a restauração concluída, vinculada ao hash do mesmo dump.

Arquivos principais: `restore-completed.json`, `restore-integrity.json`,
`restored-inventory.json`, `local-migrations.json`, `postgres-integration.json`,
`isolation-final.json`, `production-read-check.json`, `production-advisors.json`,
logs das suítes e diagnósticos de filesystem. Logs SQL/restore sensíveis estão cifrados.

O container foi encerrado e o tmpfs eliminado, incluindo tokens, sessões e dados
pessoais do clone. A engine Docker também foi parada, e o disco anexado para
inspeção foi desanexado. **Não há banco restaurado nem servidor da loja em execução**;
a imagem e os scripts permitem repetir o ensaio. Não reiniciar o container antigo:
os dados eram temporários e a execução requer container/evidências novos.

Scripts preparados: `start-isolated-postgres.sh`, `restore-isolated-backup.ps1`,
`verify-isolated-restore.cjs`, `apply-isolated-migrations.cjs` e
`check-isolated-database.cjs`. Todos limitam os destinos a containers locais
identificados, sem rede; os executores conferem contexto Windows/named pipe.
Para outra rodada, usar novo nome `anarosa-restore-*`, nova pasta sob `tmp/` e
definir `ANAROSA_HOMOLOG_CONTAINER`/`ANAROSA_HOMOLOG_EVIDENCE_DIR` nos scripts Node;
passar os mesmos valores a `-Container`/`-EvidenceDirectory` no PowerShell.

## O que falta antes da publicação

1. Obter espaço estável, confirmar armazenamento Docker e validar a stack completa
   local: login Auth, PostgREST/RPC, verificação JWT e invocação HTTP das Edge Functions.
2. Confirmar permissões Bling, canal/situação, parcelas e momento único da baixa;
   resolver o token expirado e o evento com rate limit somente na etapa autorizada.
3. Confirmar configuração real de frete, retirada e métodos; guardar credenciais
   recuperáveis. Homologação financeira/ERP real exige autorização própria.
4. Renovar o backup e conferir alterações desde este snapshot na janela de publicação;
   o ensaio não torna o backup de 21:58 um snapshot atual para sempre.
5. Apresentar o pacote para aprovação e executar a sequência já documentada:
   pausa controlada, migrations, grupos de Edge Functions, frontend, smoke checks,
   liberação de checkout e, por último e separadamente, automações aprovadas.

Nenhuma infraestrutura paga foi criada. Publicação, alteração em produção e
ações com custo continuam dependendo de aprovação explícita.

Referências oficiais usadas na preparação do isolamento e restore:
[rede Docker](https://docs.docker.com/reference/cli/docker/network/create/),
[backup/restore Supabase](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)
e [armazenamento WSL do Docker](https://docs.docker.com/desktop/features/wsl/).
