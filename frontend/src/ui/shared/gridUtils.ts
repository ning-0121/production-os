/**
 * DataGrid pure utilities — no React, no DOM. Fully unit-testable.
 *
 * Owns the canonical column type so the utilities stay dependency-free
 * (DataGrid.tsx imports these + adds the React layer).
 */

import type { ReactNode } from "react";

export type SortDir = "asc" | "desc";

export type DataGridColumn<T> = {
  id: string;
  header: string;
  /** Cell renderer. Defaults to String(filterValue) when omitted. */
  accessor?: (row: T) => ReactNode;
  /** Sort key. If omitted, the column is not sortable. */
  sortValue?: (row: T) => string | number | Date | null | undefined;
  /** Text used for quick-search matching + CSV fallback. */
  filterValue?: (row: T) => string;
  /** Explicit CSV cell text (else filterValue, else sortValue). */
  csvValue?: (row: T) => string;
  width?: string | number;
  align?: "left" | "center" | "right";
  hidden?: boolean;
  sticky?: boolean;
};

export type SortState = { columnId: string; dir: SortDir } | null;

/** Lowercase + trim for case-insensitive search. */
export function normalizeSearchText(s: unknown): string {
  return String(s ?? "").trim().toLowerCase();
}

/**
 * Filter rows by a free-text query across all columns' filterValue.
 * Empty query → returns the same array (no copy).
 */
export function filterRows<T>(rows: T[], columns: DataGridColumn<T>[], search: string): T[] {
  const q = normalizeSearchText(search);
  if (!q) return rows;
  const searchable = columns.filter((c) => c.filterValue);
  if (searchable.length === 0) return rows;
  return rows.filter((row) =>
    searchable.some((c) => normalizeSearchText(c.filterValue!(row)).includes(q)),
  );
}

/**
 * Stable sort by a column's sortValue. Null/undefined sort last (both dirs).
 * Returns a NEW array; input is not mutated.
 */
export function sortRows<T>(rows: T[], columns: DataGridColumn<T>[], sort: SortState): T[] {
  if (!sort) return rows;
  const col = columns.find((c) => c.id === sort.columnId);
  if (!col?.sortValue) return rows;
  const dir = sort.dir === "desc" ? -1 : 1;
  // decorate-sort-undecorate for stability
  return rows
    .map((row, i) => ({ row, i, key: col.sortValue!(row) }))
    .sort((a, b) => {
      const an = a.key == null, bn = b.key == null;
      if (an && bn) return a.i - b.i;
      if (an) return 1;          // nulls last regardless of dir
      if (bn) return -1;
      const cmp = compareValues(a.key as NonNullable<typeof a.key>, b.key as NonNullable<typeof b.key>);
      return cmp !== 0 ? cmp * dir : a.i - b.i;   // stable tiebreak
    })
    .map((d) => d.row);
}

function compareValues(a: string | number | Date, b: string | number | Date): number {
  if (a instanceof Date || b instanceof Date) {
    return new Date(a).getTime() - new Date(b).getTime();
  }
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "zh-Hans-CN");
}

/** Slice rows for a 1-based page. Clamps page into range. */
export function paginateRows<T>(rows: T[], page: number, pageSize: number): T[] {
  if (pageSize <= 0) return rows;
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const p = Math.min(Math.max(1, page), pages);
  const start = (p - 1) * pageSize;
  return rows.slice(start, start + pageSize);
}

export function pageCount(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

/** CSV cell text for a column (csvValue → filterValue → sortValue → ""). */
export function csvCell<T>(col: DataGridColumn<T>, row: T): string {
  if (col.csvValue) return col.csvValue(row);
  if (col.filterValue) return col.filterValue(row);
  if (col.sortValue) { const v = col.sortValue(row); return v == null ? "" : String(v); }
  return "";
}

/** RFC-4180-ish CSV escaping. */
export function escapeCsv(value: string): string {
  const s = String(value ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Build a CSV string from rows + visible columns. Header row uses col.header.
 * Pure — returns the string; the component triggers the download.
 */
export function exportRowsToCsv<T>(rows: T[], columns: DataGridColumn<T>[]): string {
  const cols = columns.filter((c) => !c.hidden);
  const header = cols.map((c) => escapeCsv(c.header)).join(",");
  const lines = rows.map((row) => cols.map((c) => escapeCsv(csvCell(c, row))).join(","));
  return [header, ...lines].join("\r\n");
}

/** Full client-side pipeline: filter → sort → (record total) → paginate. */
export function processRows<T>(
  rows: T[],
  columns: DataGridColumn<T>[],
  opts: { search?: string; sort?: SortState; page?: number; pageSize?: number },
): { visible: T[]; filteredTotal: number; filteredSorted: T[] } {
  const filtered = filterRows(rows, columns, opts.search ?? "");
  const sorted = sortRows(filtered, columns, opts.sort ?? null);
  const visible = opts.pageSize && opts.pageSize > 0
    ? paginateRows(sorted, opts.page ?? 1, opts.pageSize)
    : sorted;
  return { visible, filteredTotal: filtered.length, filteredSorted: sorted };
}
