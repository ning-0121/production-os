#!/usr/bin/env node
/**
 * V7.5 Phase 3 — Runtime Integrity Validation
 *
 * Read-only integrity sweep over the operational core. Detects:
 *   1. Orphan runtime_events       (factory_id / line_id pointing nowhere)
 *   2. runtime_lines without factory
 *   3. decision_tasks without a source
 *   4. Broken (soft) foreign keys  (notifications, decision_logs, shopfloor children)
 *   5. Duplicate active tasks       (same source, both non-terminal)
 *   6. Unresolved notification references (task_id → missing task)
 *
 * Writes runtime-integrity-report.json (machine-readable) and prints a summary.
 *
 * Usage:  cd backend && node --env-file=.env scripts/runtime-integrity-check.mjs
 * Exit:   0 = clean, 1 = issues found, 2 = env/connection error.
 */

import { writeFileSync } from "node:fs";
import { getClient, Reporter, countRows, pageRows } from "./lib/introspect.mjs";

const db = getClient();
const r = new Reporter("V7.5 Runtime Integrity");
const report = { generated_at: new Date().toISOString(), ok: true, checks: [] };

function record(id, label, count, sample = [], { capped = false, kind = "issue" } = {}) {
  const status = count > 0 ? (kind === "warn" ? "WARN" : "ISSUES") : "CLEAN";
  report.checks.push({ id, label, status, count, capped, sample: sample.slice(0, 10) });
  if (status === "ISSUES") { report.ok = false; r.fail_(label, `${count} found${capped ? " (capped)" : ""}`); }
  else if (status === "WARN") r.warn_(label, `${count}${capped ? " (capped)" : ""}`);
  else r.pass_(label, "clean");
}

async function safe(id, label, fn) {
  try { await fn(); }
  catch (err) {
    report.checks.push({ id, label, status: "ERROR", error: err.message });
    r.warn_(label, `could not check: ${err.message}`);
  }
}

r.section("Referential integrity");

// Parent id sets (small dimension tables).
const factoryIds = new Set((await pageRows(db, "factories", "id")).rows.map((x) => x.id));
const lineIds = new Set((await pageRows(db, "production_lines", "id")).rows.map((x) => x.id));

// 1) Orphan runtime_events — factory_id / line_id referencing nothing.
await safe("orphan_runtime_events", "No orphan runtime_events", async () => {
  const { rows, capped } = await pageRows(db, "runtime_events", "id, factory_id, line_id",
    (q) => q.or("factory_id.not.is.null,line_id.not.is.null"), { cap: 50000 });
  const orphans = rows.filter((e) =>
    (e.factory_id && !factoryIds.has(e.factory_id)) || (e.line_id && !lineIds.has(e.line_id)));
  record("orphan_runtime_events", "No orphan runtime_events", orphans.length,
    orphans.map((o) => ({ id: o.id, factory_id: o.factory_id, line_id: o.line_id })), { capped });
});

// 2) runtime_lines without factory.
await safe("runtime_lines_no_factory", "No runtime_lines without factory", async () => {
  const n = await countRows(db, "production_runtime_lines", (q) => q.is("factory_id", null));
  record("runtime_lines_no_factory", "No runtime_lines without factory", n);
});

// 3) decision_tasks without a source.
await safe("tasks_without_source", "No decision_tasks without source", async () => {
  // source_type NULL, or a non-manual source with no source_ref anchor.
  const n = await countRows(db, "decision_tasks",
    (q) => q.or("source_type.is.null,and(source_ref.is.null,source_type.neq.manual)"));
  record("tasks_without_source", "No decision_tasks without source", n);
});

// 4) Broken soft FKs.
await safe("dangling_decision_logs", "No decision_logs with missing assessment", async () => {
  const assessmentIds = new Set((await pageRows(db, "decision_assessments", "id", (q) => q, { cap: 100000 })).rows.map((x) => x.id));
  const { rows, capped } = await pageRows(db, "decision_logs", "id, decision_id", (q) => q, { cap: 100000 });
  const dangling = rows.filter((l) => l.decision_id && !assessmentIds.has(l.decision_id));
  record("dangling_decision_logs", "No decision_logs with missing assessment", dangling.length, dangling, { capped });
});

await safe("dangling_shopfloor_children", "No shopfloor reports/events with missing work order", async () => {
  const woIds = new Set((await pageRows(db, "shopfloor_work_orders", "id", (q) => q, { cap: 100000 })).rows.map((x) => x.id));
  const reps = (await pageRows(db, "shopfloor_reports", "id, work_order_id", (q) => q, { cap: 100000 })).rows;
  const evs = (await pageRows(db, "shopfloor_events", "id, work_order_id", (q) => q, { cap: 100000 })).rows;
  const dangling = [...reps, ...evs].filter((x) => x.work_order_id && !woIds.has(x.work_order_id));
  record("dangling_shopfloor_children", "No shopfloor reports/events with missing work order", dangling.length, dangling);
});

r.section("Consistency");

// 5) Duplicate active tasks per source (the partial unique index should prevent this).
await safe("duplicate_active_tasks", "No duplicate active tasks per source", async () => {
  const { rows } = await pageRows(db, "decision_tasks", "id, source_type, source_ref, status",
    (q) => q.not("status", "in", "(resolved,dismissed)").not("source_ref", "is", null), { cap: 100000 });
  const byKey = new Map();
  for (const t of rows) {
    const k = `${t.source_type}::${t.source_ref}`;
    byKey.set(k, (byKey.get(k) ?? 0) + 1);
  }
  const dups = [...byKey.entries()].filter(([, n]) => n > 1).map(([key, n]) => ({ key, count: n }));
  record("duplicate_active_tasks", "No duplicate active tasks per source", dups.length, dups);
});

// 6) Unresolved notification references.
await safe("dangling_notifications", "No notifications referencing missing tasks", async () => {
  const taskIds = new Set((await pageRows(db, "decision_tasks", "id", (q) => q, { cap: 200000 })).rows.map((x) => x.id));
  const { rows, capped } = await pageRows(db, "notification_events", "id, task_id", (q) => q.not("task_id", "is", null), { cap: 100000 });
  const dangling = rows.filter((nrow) => nrow.task_id && !taskIds.has(nrow.task_id));
  record("dangling_notifications", "No notifications referencing missing tasks", dangling.length, dangling, { capped });
});

const ok = r.summary();
report.summary = {
  total: report.checks.length,
  clean: report.checks.filter((c) => c.status === "CLEAN").length,
  issues: report.checks.filter((c) => c.status === "ISSUES").length,
  warn: report.checks.filter((c) => c.status === "WARN").length,
  errors: report.checks.filter((c) => c.status === "ERROR").length,
};

const outPath = new URL("../runtime-integrity-report.json", import.meta.url).pathname;
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`📄 Report written: ${outPath}\n`);

process.exit(ok && report.ok ? 0 : 1);
