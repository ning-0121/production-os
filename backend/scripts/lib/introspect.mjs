/**
 * Shared helpers for the V7.5 industrial-readiness scripts.
 *
 * - getClient()  : service-role Supabase client (fails fast if env missing)
 * - Reporter     : PASS / WARN / FAIL accounting + colored console output
 * - schema introspection via information_schema (proven to be queryable in
 *   this project's Supabase config; see scripts/v5-e2e-verify.mjs). Index
 *   checks use pg_indexes and degrade to WARN when PostgREST doesn't expose it.
 *
 * No DB writes. Pure read + reporting. Safe to run against production.
 */

import { createClient } from "@supabase/supabase-js";

// ── Client ──────────────────────────────────────────────────

export function getClient({ required = true } = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    if (required) {
      console.error(
        "\n❌ SUPABASE_URL and SUPABASE_SERVICE_KEY are required.\n" +
        "   Run with:  node --env-file=.env scripts/<script>.mjs\n" +
        "   (the service key lives in Railway → Variables for production)\n",
      );
      process.exit(2);
    }
    return null;
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

// ── ANSI colors (no dependency) ─────────────────────────────

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m", gray: "\x1b[90m",
};
const noColor = process.env.NO_COLOR != null || !process.stdout.isTTY;
const paint = (c, s) => (noColor ? s : `${c}${s}${C.reset}`);

// ── Reporter ────────────────────────────────────────────────

export class Reporter {
  constructor(title) {
    this.title = title;
    this.pass = 0; this.warn = 0; this.fail = 0;
    this.rows = [];
    if (title) console.log(`\n${paint(C.bold, title)}\n${paint(C.gray, "=".repeat(title.length))}`);
  }

  section(name) {
    this.rows.push({ kind: "section", name });
    console.log(`\n${paint(C.cyan, "▸ " + name)}`);
  }

  /** status: "PASS" | "WARN" | "FAIL" */
  add(status, label, detail = "") {
    if (status === "PASS") this.pass++;
    else if (status === "WARN") this.warn++;
    else this.fail++;
    this.rows.push({ kind: "check", status, label, detail });
    const tag = status === "PASS" ? paint(C.green, "PASS")
      : status === "WARN" ? paint(C.yellow, "WARN")
      : paint(C.red, "FAIL");
    const det = detail ? paint(C.gray, ` — ${detail}`) : "";
    console.log(`  ${tag}  ${label}${det}`);
  }

  pass_(label, detail) { this.add("PASS", label, detail); }
  warn_(label, detail) { this.add("WARN", label, detail); }
  fail_(label, detail) { this.add("FAIL", label, detail); }

  /** Run an async predicate; PASS on true, FAIL on false/throw. */
  async check(label, fn, { warnOnThrow = false } = {}) {
    try {
      const r = await fn();
      if (r === true || r === undefined) this.pass_(label, typeof r === "string" ? r : "");
      else if (typeof r === "string") this.pass_(label, r);
      else this.fail_(label, "predicate returned false");
    } catch (err) {
      const msg = err?.message ?? String(err);
      if (warnOnThrow) this.warn_(label, msg);
      else this.fail_(label, msg);
    }
  }

  summary() {
    const total = this.pass + this.warn + this.fail;
    console.log(`\n${paint(C.gray, "─".repeat(48))}`);
    console.log(
      `  ${paint(C.green, this.pass + " PASS")}   ` +
      `${paint(C.yellow, this.warn + " WARN")}   ` +
      `${paint(C.red, this.fail + " FAIL")}   ` +
      paint(C.gray, `(${total} checks)`),
    );
    const ok = this.fail === 0;
    console.log(
      ok
        ? paint(C.green, `\n✓ ${this.title ?? "checks"}: no failures\n`)
        : paint(C.red, `\n✗ ${this.title ?? "checks"}: ${this.fail} failure(s)\n`),
    );
    return ok;
  }

  toJSON() {
    return {
      title: this.title,
      totals: { pass: this.pass, warn: this.warn, fail: this.fail },
      checks: this.rows.filter((r) => r.kind === "check"),
    };
  }
}

// ── Introspection (information_schema) ──────────────────────
// These return data or throw. The caller decides PASS/WARN/FAIL.

export async function tableExists(db, table, schema = "public") {
  const { data, error } = await db
    .from("information_schema.tables")
    .select("table_name")
    .eq("table_schema", schema)
    .eq("table_name", table)
    .limit(1);
  if (error) throw new Error(`cannot read information_schema.tables: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

export async function getColumns(db, table, schema = "public") {
  const { data, error } = await db
    .from("information_schema.columns")
    .select("column_name, is_nullable, data_type")
    .eq("table_schema", schema)
    .eq("table_name", table);
  if (error) throw new Error(`cannot read information_schema.columns: ${error.message}`);
  return new Map((data ?? []).map((c) => [c.column_name, c]));
}

export async function triggerExists(db, table, triggerName) {
  const { data, error } = await db
    .from("information_schema.triggers")
    .select("trigger_name")
    .eq("event_object_table", table)
    .eq("trigger_name", triggerName)
    .limit(1);
  if (error) throw new Error(`cannot read information_schema.triggers: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

export async function constraintExists(db, constraintName, schema = "public") {
  const { data, error } = await db
    .from("information_schema.table_constraints")
    .select("constraint_name")
    .eq("table_schema", schema)
    .eq("constraint_name", constraintName)
    .limit(1);
  if (error) throw new Error(`cannot read information_schema.table_constraints: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

/**
 * Index check. pg_indexes is in pg_catalog and may not be exposed by PostgREST.
 * Returns { ok, queryable }. When not queryable, the caller should WARN, not FAIL.
 */
export async function indexExists(db, indexName, schema = "public") {
  const { data, error } = await db
    .from("pg_indexes")
    .select("indexname")
    .eq("schemaname", schema)
    .eq("indexname", indexName)
    .limit(1);
  if (error) return { ok: false, queryable: false, error: error.message };
  return { ok: (data?.length ?? 0) > 0, queryable: true };
}

/** Count rows matching a filter callback; returns the numeric count cheaply. */
export async function countRows(db, table, build = (q) => q) {
  const q = build(db.from(table).select("*", { count: "exact", head: true }));
  const { count, error } = await q;
  if (error) throw new Error(`count ${table}: ${error.message}`);
  return count ?? 0;
}

/**
 * Page through a table's selected columns (PostgREST caps each request ~1000).
 * Returns { rows, capped }. `capped` is true if we hit `cap` before exhausting.
 */
export async function pageRows(db, table, columns, build = (q) => q, { cap = 100000, pageSize = 1000 } = {}) {
  const rows = [];
  let from = 0;
  for (;;) {
    const q = build(db.from(table).select(columns)).range(from, from + pageSize - 1);
    const { data, error } = await q;
    if (error) throw new Error(`page ${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
    if (rows.length >= cap) return { rows, capped: true };
  }
  return { rows, capped: false };
}
