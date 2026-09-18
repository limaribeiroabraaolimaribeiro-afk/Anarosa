# Manual de configuração manual — Gestão Anarosa (/gestao/)

Checklist do que você precisa fazer manualmente para o painel funcionar.
O código já está pronto; nada aqui exige alterar a arquitetura.

> Continua valendo: nenhum segredo vai para o Git nem para o frontend;
> `BLING_ORDER_SYNC_ENABLED` continua `false`; nenhum pedido é criado no
> Bling a partir deste painel.

## ETAPA 1 — Migration

- [ ] Rodar a nova migration (além das já existentes):
  ```bash
  supabase db push
  ```
  Confirma a criação de `store_admins` e das funções
  `admin_dashboard_summary` / `admin_customers_summary`.

## ETAPA 2 — Deploy das novas Edge Functions

- [ ] Deploy (mesmo fluxo já usado para as demais):
  ```bash
  supabase functions deploy admin-dashboard-summary
  supabase functions deploy admin-orders
  supabase functions deploy admin-products
  supabase functions deploy admin-customers
  supabase functions deploy admin-integration-status
  ```
  Essas 5 funções usam a sessão real do Supabase Auth (não o
  `INTEGRATION_ADMIN_SECRET`) — não precisam de secret novo.

## ETAPA 3 — Habilitar e configurar o Supabase Auth (se ainda não estiver)

- [ ] No painel Supabase: **Authentication → Providers** → confirmar que
  **Email** está habilitado.
- [ ] Em **Authentication → Settings**, **desabilitar cadastro público**
  ("Allow new users to sign up" = desligado) — o painel é só para quem
  você convidar; ninguém deve conseguir se auto-cadastrar.

## ETAPA 4 — Criar o primeiro usuário administrador

Escolha uma das opções:

**Opção A — pelo painel (mais simples):**
- [ ] **Authentication → Users → Add user** (ou "Invite user").
- [ ] Preencher o e-mail real da cliente e definir uma senha (ou enviar
  convite por e-mail, se configurado).
- [ ] Copiar o **User UID** gerado.

**Opção B — via SQL Editor**, se preferir criar a senha você mesmo:
```sql
-- Só se a Opção A não estiver disponível no seu plano/versão.
-- Prefira sempre a Opção A quando possível.
select id, email from auth.users where email = '<email da cliente>';
```

## ETAPA 5 — Autorizar esse usuário no painel (store_admins)

- [ ] No **SQL Editor**, rodar (substituindo pelo UID/e-mail reais —
  **não** cole isto num arquivo versionado no Git):
  ```sql
  insert into public.store_admins (user_id, email, name)
  values ('<USER_UID_da_ETAPA_4>', '<email>', '<nome da cliente>');
  ```
- [ ] Sem esse passo, o login funciona mas o painel mostra
  "Usuário não autorizado" — é o comportamento esperado e testado.

## ETAPA 6 — Configurar o frontend

- [ ] Em `js/config.js`, confirmar que `supabaseUrl` já aponta para o
  projeto certo (já deve estar configurado desde a integração com o
  Bling) e preencher `supabaseAnonKey` com a **anon key** do projeto
  (Settings → API → Project API keys → `anon` `public`). A anon key é
  pública por design — não é segredo, mas ainda assim **nunca** coloque
  a `service_role key` aqui.

## ETAPA 7 — Testar

- [ ] Abrir `/gestao/index.html`, logar com o usuário da ETAPA 4.
- [ ] Confirmar que o Dashboard mostra números reais (ou zerados, se
  ainda não houver pedidos — não é erro).
- [ ] Testar um login com e-mail/senha errados → mensagem de erro clara.
- [ ] Se quiser testar o caso "usuário não autorizado": criar um
  segundo usuário no Supabase Auth e **não** inserir em `store_admins`
  — o login deve funcionar mas o painel deve recusar o acesso.
- [ ] Testar "Sair" e confirmar que volta para a tela de login.

## ETAPA 8 — Gerenciar administradores no futuro

- [ ] Para remover o acesso de alguém: `update public.store_admins set active = false where email = '<email>';`
  (mantém o histórico; não precisa apagar o usuário do Supabase Auth).
- [ ] Para adicionar outra pessoa da equipe: repetir as ETAPAS 4 e 5.

## Publicação (GitHub Pages)

- [ ] `.github/workflows/deploy-pages.yml` já copia `/gestao/` junto com
  a loja no artefato público. Isso é intencional: a TELA DE LOGIN pode
  ficar pública (como o login de qualquer painel administrativo) — os
  DADOS atrás dela são protegidos por autenticação real + allowlist,
  não por a página estar "escondida". Se preferir manter `/gestao/`
  fora de um domínio público mesmo assim, isso pode ser revisto depois.
