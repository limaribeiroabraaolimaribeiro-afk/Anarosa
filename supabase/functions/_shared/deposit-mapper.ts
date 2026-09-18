/**
 * Mapeamento de GET /depositos → formato usado pela Gestão Anarosa.
 * Função PURA (sem rede/banco) — extraída para ser testável com
 * precisão (ver _tests/deposit-mapper.test.ts).
 *
 * Contrato oficial (confirmado pelo usuário a partir da conta real):
 *   GET /depositos?pagina=1&limite=100&situacao=1
 *   { "data": [{ "id": integer, "descricao": string, "situacao": 1,
 *                "padrao": boolean, "desconsiderarSaldo": boolean }] }
 *
 * IMPORTANTE: situacao de DEPÓSITO é INTEIRO (1=ativo, 0=inativo) —
 * diferente do situacao de PRODUTO ('A'/'I', string). Comparar com a
 * string 'A' aqui foi exatamente o bug que fez a Gestão mostrar
 * "Nenhum depósito ativo" mesmo com um depósito real e ativo no Bling
 * (auditoria de 2026-09-18).
 */
// deno-lint-ignore no-explicit-any
export type BlingRawDeposit = Record<string, any>;

export interface AdminDeposit {
  id: string;
  descricao: string;
  ativo: boolean;
  padrao: boolean;
  desconsiderarSaldo: boolean;
}

function toId(value: unknown): string | null {
  if (value == null || value === '') return null;
  return String(value);
}

/**
 * Mapeia a lista bruta de GET /depositos para o formato da Gestão.
 * Nunca inventa depósito: só mapeia o que veio de fato na resposta, e
 * descarta linhas sem id válido. Por padrão só devolve depósitos ATIVOS
 * (situacao === 1) — quem ajusta estoque só pode escolher entre
 * depósitos reais e ativos, nunca um id arbitrário/inativo.
 */
export function mapBlingDeposits(raw: BlingRawDeposit[] | null | undefined): AdminDeposit[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((d) => ({
      id: toId(d?.id),
      descricao: typeof d?.descricao === 'string' && d.descricao.trim() ? d.descricao : `Depósito ${toId(d?.id)}`,
      ativo: d?.situacao === 1,
      padrao: d?.padrao === true,
      desconsiderarSaldo: d?.desconsiderarSaldo === true,
    }))
    .filter((d): d is AdminDeposit => d.id != null && d.ativo);
}

/**
 * Escolhe qual depósito pré-selecionar no formulário — a cliente não
 * deve precisar escolher "Geral" toda vez. Regra (FASE A / A2):
 *   - exatamente 1 depósito ativo → esse;
 *   - senão, o primeiro com padrao=true;
 *   - senão (vários, nenhum marcado como padrão) → null, a cliente
 *     escolhe manualmente (nunca adivinhamos entre vários iguais).
 */
export function pickDefaultDepositId(deposits: AdminDeposit[]): string | null {
  if (deposits.length === 1) return deposits[0].id;
  const padrao = deposits.find((d) => d.padrao);
  return padrao ? padrao.id : null;
}
