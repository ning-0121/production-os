import { describe, it, expect } from "vitest";
import {
  normalizeSearchText, filterRows, sortRows, paginateRows, pageCount,
  csvCell, escapeCsv, exportRowsToCsv, processRows,
  type DataGridColumn,
} from "./gridUtils";

type Row = { id: string; name: string; qty: number; due: string | null };

const ROWS: Row[] = [
  { id: "a", name: "Alpha", qty: 30, due: "2026-07-01" },
  { id: "b", name: "bravo", qty: 10, due: null },
  { id: "c", name: "Charlie", qty: 20, due: "2026-06-15" },
];

const COLS: DataGridColumn<Row>[] = [
  { id: "name", header: "Name", sortValue: (r) => r.name, filterValue: (r) => r.name },
  { id: "qty", header: "Qty", sortValue: (r) => r.qty, filterValue: (r) => String(r.qty) },
  { id: "due", header: "Due", sortValue: (r) => (r.due ? new Date(r.due) : null), filterValue: (r) => r.due ?? "" },
];

describe("normalizeSearchText", () => {
  it("lowercases and trims", () => {
    expect(normalizeSearchText("  HeLLo  ")).toBe("hello");
  });
  it("handles null/undefined", () => {
    expect(normalizeSearchText(null)).toBe("");
    expect(normalizeSearchText(undefined)).toBe("");
  });
});

describe("filterRows", () => {
  it("returns same array for empty query", () => {
    expect(filterRows(ROWS, COLS, "")).toBe(ROWS);
    expect(filterRows(ROWS, COLS, "   ")).toBe(ROWS);
  });
  it("matches case-insensitively across columns", () => {
    expect(filterRows(ROWS, COLS, "alpha").map((r) => r.id)).toEqual(["a"]);
    expect(filterRows(ROWS, COLS, "BRAVO").map((r) => r.id)).toEqual(["b"]);
  });
  it("matches numeric filterValue", () => {
    // "10" only matches bravo's qty (the 2026 dates don't contain it)
    expect(filterRows(ROWS, COLS, "10").map((r) => r.id)).toEqual(["b"]);
  });
  it("returns empty when nothing matches", () => {
    expect(filterRows(ROWS, COLS, "zzz")).toEqual([]);
  });
});

describe("sortRows", () => {
  it("returns input unchanged when sort is null", () => {
    expect(sortRows(ROWS, COLS, null)).toBe(ROWS);
  });
  it("sorts numbers ascending and descending", () => {
    expect(sortRows(ROWS, COLS, { columnId: "qty", dir: "asc" }).map((r) => r.qty)).toEqual([10, 20, 30]);
    expect(sortRows(ROWS, COLS, { columnId: "qty", dir: "desc" }).map((r) => r.qty)).toEqual([30, 20, 10]);
  });
  it("sorts strings", () => {
    expect(sortRows(ROWS, COLS, { columnId: "name", dir: "asc" }).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
  it("sorts dates and puts nulls last in both directions", () => {
    expect(sortRows(ROWS, COLS, { columnId: "due", dir: "asc" }).map((r) => r.id)).toEqual(["c", "a", "b"]);
    expect(sortRows(ROWS, COLS, { columnId: "due", dir: "desc" }).map((r) => r.id)).toEqual(["a", "c", "b"]);
  });
  it("does not mutate the input array", () => {
    const copy = [...ROWS];
    sortRows(ROWS, COLS, { columnId: "qty", dir: "desc" });
    expect(ROWS).toEqual(copy);
  });
  it("is stable for equal keys", () => {
    const rows = [{ id: "x", name: "same", qty: 1, due: null }, { id: "y", name: "same", qty: 1, due: null }];
    const cols: DataGridColumn<Row>[] = [{ id: "name", header: "n", sortValue: (r) => r.name }];
    expect(sortRows(rows, cols, { columnId: "name", dir: "asc" }).map((r) => r.id)).toEqual(["x", "y"]);
  });
});

describe("paginateRows / pageCount", () => {
  it("slices a 1-based page", () => {
    expect(paginateRows([1, 2, 3, 4, 5], 1, 2)).toEqual([1, 2]);
    expect(paginateRows([1, 2, 3, 4, 5], 2, 2)).toEqual([3, 4]);
    expect(paginateRows([1, 2, 3, 4, 5], 3, 2)).toEqual([5]);
  });
  it("clamps out-of-range pages", () => {
    expect(paginateRows([1, 2, 3], 99, 2)).toEqual([3]);
    expect(paginateRows([1, 2, 3], 0, 2)).toEqual([1, 2]);
  });
  it("computes page count", () => {
    expect(pageCount(0, 10)).toBe(1);
    expect(pageCount(10, 10)).toBe(1);
    expect(pageCount(11, 10)).toBe(2);
  });
});

describe("csv", () => {
  it("escapes quotes, commas, newlines", () => {
    expect(escapeCsv("plain")).toBe("plain");
    expect(escapeCsv("a,b")).toBe('"a,b"');
    expect(escapeCsv('he said "hi"')).toBe('"he said ""hi"""');
    expect(escapeCsv("line\nbreak")).toBe('"line\nbreak"');
  });
  it("picks csvCell precedence csvValue > filterValue > sortValue", () => {
    expect(csvCell({ id: "x", header: "X", csvValue: () => "csv", filterValue: () => "f" }, ROWS[0])).toBe("csv");
    expect(csvCell({ id: "x", header: "X", filterValue: () => "f" }, ROWS[0])).toBe("f");
    expect(csvCell({ id: "x", header: "X", sortValue: () => 42 }, ROWS[0])).toBe("42");
    expect(csvCell({ id: "x", header: "X" }, ROWS[0])).toBe("");
  });
  it("builds a CSV with header + rows", () => {
    const csv = exportRowsToCsv(ROWS, COLS);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("Name,Qty,Due");
    expect(lines[1]).toBe("Alpha,30,2026-07-01");
    expect(lines).toHaveLength(4);
  });
  it("skips hidden columns", () => {
    const cols: DataGridColumn<Row>[] = [...COLS, { id: "h", header: "Hidden", hidden: true, filterValue: () => "x" }];
    expect(exportRowsToCsv(ROWS, cols).split("\r\n")[0]).toBe("Name,Qty,Due");
  });
});

describe("processRows", () => {
  it("filters, sorts, then paginates and reports filtered total", () => {
    const r = processRows(ROWS, COLS, { search: "", sort: { columnId: "qty", dir: "asc" }, page: 1, pageSize: 2 });
    expect(r.visible.map((x) => x.qty)).toEqual([10, 20]);
    expect(r.filteredTotal).toBe(3);
    expect(r.filteredSorted.map((x) => x.qty)).toEqual([10, 20, 30]);
  });
  it("filteredTotal reflects search", () => {
    const r = processRows(ROWS, COLS, { search: "a", page: 1, pageSize: 10 });
    // "a" matches Alpha, bravo, Charlie (all contain 'a')
    expect(r.filteredTotal).toBe(r.visible.length);
  });
});
