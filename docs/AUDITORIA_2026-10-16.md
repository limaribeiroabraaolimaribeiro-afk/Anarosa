# Auditoria e plano de verificação — 16/10/2026

Base: `d36ade2`, branch inicial `main`, árvore limpa. Trabalho em
`feat/production-hardening-20261016`. Nenhuma publicação ou transação real
faz parte desta execução. Os 197 testes Deno da base passaram.

## Matriz inicial (antes das correções)

| Área | Classificação | Evidência / risco |
|---|---|---|
| Auth administrativa e allowlist | Implementada, sem validação real nesta sessão | Testes de autorização passam; projeto de produção indisponível no conector |
| Catálogo real e erro sem fallback fictício | Implementada, sem validação real | Provider Supabase configurado; documentação README desatualizada |
| Produtos simples / estoque Bling | Parcialmente funcional | Criação/PUT; PUT omite campos complexos; balanço zero recusado |
| Editor de variações | Ausente | UI e endpoint bloqueiam edição do pai |
| Imagens, logística e fiscal | Parcialmente funcional | Leitura existe; formulário incompleto; escopos reais não verificáveis |
| Carrinho | Parcialmente funcional | Persistente; admite linha com quantidade zero e variante ausente |
| Checkout | Com defeito | Pedido e itens não atômicos; chave automática permanente; frete vindo do cliente; tamanho não obrigatório no backend |
| Disponibilidade | Com defeito | Estoque desconhecido permite venda; linhas repetidas não agregam quantidade; sem reserva concorrente |
| InfinitePay / reconciliação | Parcialmente funcional | Mocks passam; POST de link permite id interno; persistência sem checar erro; confirmação concorrente pode reportar pago incorretamente |
| Pago → Bling | Ausente | Migration enfileira, mas worker não existe; rota legada sem claim e sem recuperação |
| Webhooks de marketplace | Ausente | Pedidos que não existem localmente são ignorados |
| Pedidos administrativos | Parcialmente funcional | Somente leitura; sem eventos/transições/reprocessamento |
| Dashboard / clientes | Com defeito | Soma pendentes como receita/gasto; sem histórico de cliente |
| Configurações comerciais | Ausente | Valores operacionais espalhados em frontend |
| UX / comunicação | Com defeito | Pix anunciado como chave enviada depois; desconto 5% sem regra no checkout; newsletter simula inscrição |
| RLS / SQL | Implementada, sem validação real | Migrations restringem tabelas sensíveis; validar em PostgreSQL isolado |
| Deploy Pages | Parcialmente funcional | Allowlist de arquivos existente; publicação sem barreira de testes |
| Shopee | Bloqueada por dependência externa | Pausada por solicitação; não impede demais entregas |

## Dependências externas identificadas

- A configuração pública aponta para `gpmbkptimjipqsayrvce`. A listagem do
  conector Supabase não inclui esse projeto. Não usar outro projeto como substituto.
- Escopos reais do aplicativo Bling, canal da loja, situação operacional e política
  de reserva/baixa precisam ser conferidos na conta antes de ativar envio de pedidos.
- Sem pagamento real autorizado: webhook → confirmação real permanece pendente,
  mesmo após testes simulados completos.
- Estoque entre canais não tem transação distribuída. Reservas locais evitam
  concorrência do site; não bloqueiam venda simultânea no Mercado Livre.

## Fontes consultadas

- [OpenAPI oficial Bling](https://developer.bling.com.br/referencia): schema baixado
  de `build/assets/openapi-Dw6cY8yQ.json`; suporta PATCH parcial de produto,
  variações, `numerosLojas[]` e mídia por URL. Não há endpoint de upload binário
  de imagens nesse contrato. Não presumir escopo da conexão.
- [InfinitePay](https://www.infinitepay.io/checkout-documentacao): reconciliar no
  `payment_check`; notificação isolada não é prova de pagamento.
- [Supabase Auth em Edge Functions](https://supabase.com/docs/guides/functions/auth)
  e changelog consultados para validar práticas de autenticação.

O relatório de entrega deve distinguir teste local, teste simulado e validação real.
