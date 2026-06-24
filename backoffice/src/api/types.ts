// Shared response types for the read-only /api/* surface. These mirror the
// server's shapes (src/backoffice) — the contract between the two halves. The
// SPA is read-only too: there are no request/mutation types, only responses.

export type CellValue = string | number | boolean | null;
export type Row = Record<string, CellValue>;

export interface TableMeta {
  table: string;
  label: string;
  icon: string;
}

export interface Catalogue {
  tables: TableMeta[];
}

export interface TableListing extends TableMeta {
  columns: string[];
  rows: Row[];
}

// --- Costs (Langfuse-derived, estimated) ------------------------------------
export interface TokenSplitSlice {
  label: string;
  pct: number;
  color: string;
}
export interface UsageTypeRow {
  name: string;
  note: string;
  tokens: number;
  cost: number;
  share: number;
}
export interface CostsResponse {
  estimated: true;
  budgetUsd: number;
  monthCostUsd: number;
  lastMonthCostUsd: number;
  tokensMonth: number;
  cacheReadPct: number;
  dailyCost: number[];
  tokenSplit: TokenSplitSlice[];
  byUsage: UsageTypeRow[];
}
