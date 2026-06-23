/**
 * DataGrid — shared industrial-grade table.
 *
 * Generic, client-side by default (filter/sort/paginate/CSV all pure via
 * gridUtils). Designed so server-side mode can be layered on later via
 * `serverMode` + `onQueryChange` without changing callers.
 *
 * Features: sticky header, sortable columns, quick search, column visibility,
 * row expansion, batch selection + actions slot, pagination, density toggle,
 * CSV export, empty-state CTA, loading skeleton, and a mobile card fallback.
 */

import React from "react";
import {
  type DataGridColumn, type SortState,
  processRows, exportRowsToCsv,
} from "./gridUtils";

export type { DataGridColumn } from "./gridUtils";

export type DataGridProps<T> = {
  rows: T[];
  columns: DataGridColumn<T>[];
  rowKey: (row: T) => string;
  loading?: boolean;
  error?: string | null;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: React.ReactNode;
  searchPlaceholder?: string;
  filters?: React.ReactNode;             // extra filter controls (chips/selects)
  batchActions?: (selected: T[], clear: () => void) => React.ReactNode;
  renderExpandedRow?: (row: T) => React.ReactNode;
  onRowClick?: (row: T) => void;
  pageSize?: number;
  density?: "compact" | "comfortable";
  csvFilename?: string;
  toolbarExtra?: React.ReactNode;        // right-aligned toolbar slot (e.g. "+ New")
  // ── server-side readiness (optional; client mode is default) ──
  serverMode?: boolean;
  totalRows?: number;
  onQueryChange?: (q: { page: number; pageSize: number; sortBy: string | null; sortDir: "asc" | "desc"; search: string }) => void;
};

export function DataGrid<T>(props: DataGridProps<T>) {
  const {
    rows, columns, rowKey, loading, error,
    emptyTitle = "暂无数据", emptyDescription, emptyAction,
    searchPlaceholder = "搜索…", filters, batchActions, renderExpandedRow,
    onRowClick, pageSize = 20, density: initialDensity = "comfortable",
    csvFilename = "export", toolbarExtra, serverMode, totalRows, onQueryChange,
  } = props;

  const [search, setSearch] = React.useState("");
  const [sort, setSort] = React.useState<SortState>(null);
  const [page, setPage] = React.useState(1);
  const [density, setDensity] = React.useState(initialDensity);
  const [hiddenCols, setHiddenCols] = React.useState<Set<string>>(
    () => new Set(columns.filter((c) => c.hidden).map((c) => c.id)),
  );
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [colMenuOpen, setColMenuOpen] = React.useState(false);

  // Reset to page 1 when the query changes
  React.useEffect(() => { setPage(1); }, [search, sort]);

  // Notify server-mode listeners
  React.useEffect(() => {
    if (serverMode && onQueryChange) {
      onQueryChange({ page, pageSize, sortBy: sort?.columnId ?? null, sortDir: sort?.dir ?? "asc", search });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverMode, page, pageSize, sort, search]);

  const visibleColumns = columns.filter((c) => !hiddenCols.has(c.id));

  // Client-side processing (skipped in server mode — rows are already the page)
  const { visible, filteredTotal, filteredSorted } = React.useMemo(() => {
    if (serverMode) return { visible: rows, filteredTotal: totalRows ?? rows.length, filteredSorted: rows };
    return processRows(rows, columns, { search, sort, page, pageSize });
  }, [serverMode, rows, columns, search, sort, page, pageSize, totalRows]);

  const total = serverMode ? (totalRows ?? rows.length) : filteredTotal;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const selectedRows = rows.filter((r) => selected.has(rowKey(r)));

  function toggleSort(colId: string) {
    const col = columns.find((c) => c.id === colId);
    if (!col?.sortValue) return;
    setSort((prev) => {
      if (!prev || prev.columnId !== colId) return { columnId: colId, dir: "asc" };
      if (prev.dir === "asc") return { columnId: colId, dir: "desc" };
      return null;   // third click clears
    });
  }
  function toggleSelect(key: string) {
    setSelected((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }
  function toggleSelectAll() {
    const pageKeys = visible.map(rowKey);
    const allOn = pageKeys.every((k) => selected.has(k));
    setSelected((prev) => {
      const n = new Set(prev);
      pageKeys.forEach((k) => (allOn ? n.delete(k) : n.add(k)));
      return n;
    });
  }
  function toggleExpand(key: string) {
    setExpanded((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }
  function doExport() {
    const csv = exportRowsToCsv(serverMode ? rows : filteredSorted, visibleColumns);
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${csvFilename}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  }

  const hasSelection = selectedRows.length > 0;

  return (
    <div className={`dg dg--${density}`}>
      {/* Toolbar */}
      <div className="dgToolbar">
        <input className="dgSearch" type="search" placeholder={searchPlaceholder} value={search} onChange={(e) => setSearch(e.target.value)} />
        {filters}
        <div className="dgToolbarRight">
          {toolbarExtra}
          <button className="dgIconBtn" title="密度" onClick={() => setDensity((d) => (d === "compact" ? "comfortable" : "compact"))}>
            {density === "compact" ? "⊟" : "☰"}
          </button>
          <div className="dgColMenu">
            <button className="dgIconBtn" title="列显隐" onClick={() => setColMenuOpen((v) => !v)}>⚙</button>
            {colMenuOpen && (
              <div className="dgColMenuPop" onMouseLeave={() => setColMenuOpen(false)}>
                {columns.map((c) => (
                  <label key={c.id} className="dgColMenuItem">
                    <input type="checkbox" checked={!hiddenCols.has(c.id)} onChange={() => {
                      setHiddenCols((prev) => { const n = new Set(prev); n.has(c.id) ? n.delete(c.id) : n.add(c.id); return n; });
                    }} />
                    {c.header}
                  </label>
                ))}
              </div>
            )}
          </div>
          <button className="dgIconBtn" title="导出 CSV" onClick={doExport}>⬇ CSV</button>
        </div>
      </div>

      {/* Batch action bar */}
      {hasSelection && batchActions && (
        <div className="dgBatchBar">
          <span>已选 {selectedRows.length} 项</span>
          <div className="dgBatchActions">{batchActions(selectedRows, () => setSelected(new Set()))}</div>
        </div>
      )}

      {error && <div className="dgError">加载失败：{error}</div>}

      {loading && total === 0 ? (
        <div className="dgSkeleton">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="dgSkeletonRow" />)}</div>
      ) : total === 0 && !error ? (
        <div className="dgEmpty">
          <div className="dgEmptyTitle">{emptyTitle}</div>
          {emptyDescription && <div className="dgEmptyDesc">{emptyDescription}</div>}
          {emptyAction && <div className="dgEmptyAction">{emptyAction}</div>}
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="dgTableWrap">
            <table className="dgTable">
              <thead>
                <tr>
                  {batchActions && (
                    <th className="dgCheckCol">
                      <input type="checkbox" checked={visible.length > 0 && visible.every((r) => selected.has(rowKey(r)))} onChange={toggleSelectAll} />
                    </th>
                  )}
                  {renderExpandedRow && <th className="dgExpandCol" />}
                  {visibleColumns.map((c) => (
                    <th
                      key={c.id}
                      className={`${c.sortValue ? "dgSortable" : ""} ${c.sticky ? "dgSticky" : ""}`}
                      style={{ width: c.width, textAlign: c.align }}
                      onClick={() => toggleSort(c.id)}
                    >
                      {c.header}
                      {sort?.columnId === c.id && <span className="dgSortArrow">{sort.dir === "asc" ? " ▲" : " ▼"}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => {
                  const key = rowKey(row);
                  const isExpanded = expanded.has(key);
                  return (
                    <React.Fragment key={key}>
                      <tr className={onRowClick ? "dgRow--clickable" : ""} onClick={onRowClick ? () => onRowClick(row) : undefined}>
                        {batchActions && (
                          <td className="dgCheckCol" onClick={(e) => e.stopPropagation()}>
                            <input type="checkbox" checked={selected.has(key)} onChange={() => toggleSelect(key)} />
                          </td>
                        )}
                        {renderExpandedRow && (
                          <td className="dgExpandCol" onClick={(e) => { e.stopPropagation(); toggleExpand(key); }}>
                            <span className="dgExpandToggle">{isExpanded ? "▾" : "▸"}</span>
                          </td>
                        )}
                        {visibleColumns.map((c) => (
                          <td key={c.id} className={c.sticky ? "dgSticky" : ""} style={{ textAlign: c.align }}>
                            {c.accessor ? c.accessor(row) : (c.filterValue ? c.filterValue(row) : "")}
                          </td>
                        ))}
                      </tr>
                      {isExpanded && renderExpandedRow && (
                        <tr className="dgExpandedRow">
                          <td colSpan={visibleColumns.length + (batchActions ? 1 : 0) + 1}>
                            {renderExpandedRow(row)}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile card fallback */}
          <div className="dgCards">
            {visible.map((row) => {
              const key = rowKey(row);
              return (
                <div key={key} className="dgCard" onClick={onRowClick ? () => onRowClick(row) : undefined}>
                  {visibleColumns.map((c) => (
                    <div key={c.id} className="dgCardField">
                      <span className="dgCardLabel">{c.header}</span>
                      <span className="dgCardValue">{c.accessor ? c.accessor(row) : (c.filterValue ? c.filterValue(row) : "")}</span>
                    </div>
                  ))}
                  {renderExpandedRow && <div className="dgCardExpanded">{renderExpandedRow(row)}</div>}
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          <div className="dgFooter">
            <span className="dgCount">共 {total} 条</span>
            {pages > 1 && (
              <div className="dgPager">
                <button className="dgPageBtn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</button>
                <span className="dgPageInfo">{page} / {pages}</span>
                <button className="dgPageBtn" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>下一页</button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
