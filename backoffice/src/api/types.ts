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
