# ANAROSA — loja virtual

Loja da **Anarosa Textil** (Luiz Alves - SC): moda feminina, bebê, plus
size, masculina e acessórios.

- Frontend: HTML + CSS + JavaScript puro (sem framework).
- Backend/integração: Supabase (PostgreSQL + Edge Functions) ↔ **Bling API v3**.
- O Bling é a fonte operacional de verdade (produtos, variações, estoque,
  pedidos); o Supabase é a camada segura + cache; o site só lê dados públicos.

## Rodar o site localmente

```bash
npm run dev          # http://127.0.0.1:5500
```

Por padrão o catálogo vem do mock (`js/products.js`). Para ler o cache real
edite `js/config.js` (`catalogProvider: 'supabase'`, `supabaseUrl`).

## Estrutura

```
index.html, css/, js/, assets/     site (Home aprovada)
js/config.js                       configuração pública (provider, supabaseUrl)
js/services/catalog-service.js     CatalogService: mock | supabase
integration-status.html            página interna de diagnóstico da integração
supabase/migrations/               schema (tabelas, RLS, RPCs)
supabase/functions/                Edge Functions + módulos _shared + testes
docs/                              documentação
```

## Documentação

| Documento | Conteúdo |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | arquitetura, módulos, banco, segurança, limitações |
| [docs/BLING_SETUP_MANUAL.md](docs/BLING_SETUP_MANUAL.md) | **checklist manual** para ligar a integração (Supabase, app Bling, OAuth, webhooks, testes, produção) |
| [docs/BLING_DATA_FLOW.md](docs/BLING_DATA_FLOW.md) | fluxos: OAuth, refresh, sync, webhooks, vitrine, estoque, pedidos |
| [docs/TESTING.md](docs/TESTING.md) | como rodar e o que cobrem os testes |

## Comandos

```bash
npm test               # 63 testes Deno (sem rede, sem banco)
npm run check          # deno check de todas as Edge Functions
npm run lint:js        # sintaxe do JS do frontend
npm run secrets:scan   # procura segredos versionados por engano
```

## Estado atual da integração

| Item | Status |
| --- | --- |
| OAuth 2.0 (state seguro, troca de code, refresh JWT com lock) | pronto no código; aguarda app Bling + secrets |
| Webhooks (HMAC, idempotência, handlers produto/estoque/pedido) | pronto; aguarda cadastro da URL no app Bling |
| Sync de produtos/variações/categorias/estoque | pronto; execução **manual** |
| Storefront API + adapter mock/supabase | pronto; site em modo `mock` |
| Criação de pedidos no Bling | **desativada** (`BLING_ORDER_SYNC_ENABLED=false`) |
| Marketplaces / pagamento / NF-e | fora de escopo (Bling será o hub) |

Segredos nunca vão para o Git nem para o frontend — ver `.env.example`.
