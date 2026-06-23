#!/usr/bin/env node
/**
 * V7.5 Phase 1 — Migration Audit
 *
 * Verifies that migrations 008–014 are fully applied: every table, key column
 * (incl. NOT NULL where it matters), index, trigger, and named constraint from
 * the manifest exists in the live database.
 *
 * Usage:
 *   cd backend
 *   node --env-file=.env scripts/verify-migrations.mjs
 *   # or in CI/Railway where env is already set:
 *   SUPABASE_URL=… SUPABASE_SERVICE_KEY=… node scripts/verify-migrations.mjs
 *
 * Output: PASS / WARN / FAIL per component.
 *   - Index checks WARN (not FAIL) when pg_indexes isn't exposed via PostgREST —
 *     they cannot be introspected, but that doesn't mean they're missing.
 *
 * Exit codes: 0 = no failures, 1 = one or more FAIL, 2 = env/connection error.
 */

import { getClient, Reporter, tableExists, getColumns, triggerExists, constraintExists, indexExists } from "./lib/introspect.mjs";
import { MIGRATIONS } from "./lib/migration-manifest.mjs";

const db = getClient();
const r = new Reporter("V7.5 Migration Audit (008–014)");

// Track whether index introspection works at all, to avoid N identical warnings.
let indexIntrospectionBroken = false;

for (const m of MIGRATIONS) {
  r.section(m.id);

  // ── Tables ──
  for (const t of m.tables ?? []) {
    await r.check(`table ${t}`, async () => {
      const ok = await tableExists(db, t);
      if (!ok) throw new Error("missing");
      return "exists";
    });
  }

  // ── Columns ──
  for (const [table, cols] of Object.entries(m.columns ?? {})) {
    let columnMap = null;
    try {
      columnMap = await getColumns(db, table);
    } catch (err) {
      r.fail_(`columns on ${table}`, err.message);
    }
    if (!columnMap) continue;
    for (const col of cols) {
      const info = columnMap.get(col.name);
      if (!info) { r.fail_(`${table}.${col.name}`, "missing"); continue; }
      if (col.notNull && info.is_nullable !== "NO") {
        r.fail_(`${table}.${col.name} NOT NULL`, `is nullable (${info.is_nullable})`);
      } else {
        r.pass_(`${table}.${col.name}${col.notNull ? " NOT NULL" : ""}`, info.data_type);
      }
    }
  }

  // ── Triggers ──
  for (const trg of m.triggers ?? []) {
    await r.check(`trigger ${trg.name}`, async () => {
      const ok = await triggerExists(db, trg.table, trg.name);
      if (!ok) throw new Error(`missing on ${trg.table}`);
      return `on ${trg.table}`;
    });
  }

  // ── Constraints ──
  for (const c of m.constraints ?? []) {
    await r.check(`constraint ${c}`, async () => {
      const ok = await constraintExists(db, c);
      if (!ok) throw new Error("missing");
      return "exists";
    });
  }

  // ── Indexes (soft — pg_indexes may not be exposed) ──
  for (const idx of m.indexes ?? []) {
    if (indexIntrospectionBroken) {
      r.warn_(`index ${idx}`, "pg_indexes not introspectable — verify manually");
      continue;
    }
    const res = await indexExists(db, idx);
    if (!res.queryable) {
      indexIntrospectionBroken = true;
      r.warn_(`index ${idx}`, "pg_indexes not exposed via PostgREST — verify manually");
    } else if (res.ok) {
      r.pass_(`index ${idx}`, "exists");
    } else {
      r.fail_(`index ${idx}`, "missing");
    }
  }
}

const ok = r.summary();

if (indexIntrospectionBroken) {
  console.log(
    "ℹ Index existence could not be confirmed via PostgREST (pg_indexes not exposed).\n" +
    "  To audit indexes, run this query in the Supabase SQL editor:\n" +
    "    select indexname from pg_indexes where schemaname='public' order by indexname;\n",
  );
}

process.exit(ok ? 0 : 1);
