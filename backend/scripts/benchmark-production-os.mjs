#!/usr/bin/env node
/**
 * V7.5 Phase 4 — Performance Baseline
 *
 * Seeds a realistic synthetic workload (5 factories, 20 lines, 100 orders,
 * 1000 runtime events, 500 tasks, 200 notifications — all clearly marked) and
 * measures the core operations, reporting P50 / P95 / P99.
 *
 * Operations measured:
 *   - runtime propagation   (pure graph walk)
 *   - risk evaluation       (pure scoring envelope)
 *   - decision evaluation   (pure option assembly + scoring)
 *   - task generation       (DB: auto-generate from persisted sources)
 *   - dashboard loading     (DB: runtime lines + task summary + recent events)
 *
 * Usage:
 *   cd backend
 *   node --env-file=.env scripts/benchmark-production-os.mjs
 *   node --env-file=.env scripts/benchmark-production-os.mjs --no-seed   # pure ops only
 *   node --env-file=.env scripts/benchmark-production-os.mjs --keep      # leave data
 *
 * Writes performance-baseline.json. Exit 0 unless seeding/connection fails.
 */

import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { getClient } from "./lib/introspect.mjs";
import { createTestFactoryAndLine, teardownTestData, V75_MARK, V75_ACTOR } from "./lib/test-fixtures.mjs";
import { buildGraph } from "../src/runtime/graph.js";
import { propagateImpact as propagate } from "../src/runtime/propagation.js";
import { assessOrder } from "../src/risk-engine/index.js";
import { assembleDecision } from "../src/decision-engine/index.js";
import { autoGenerateTasks } from "../src/execution/auto-generate.js";

const NO_SEED = process.argv.includes("--no-seed");
const KEEP = process.argv.includes("--keep");
const RECIPIENT = `${V75_MARK}-recipient`;
const db = getClient();

const EVENT_TYPES = ["material_delayed", "line_slowdown", "qc_failure", "labor_shortage", "shipment_risk"];
const SEVERITIES = ["critical", "high", "medium", "low", "info"];

// ── Percentiles ─────────────────────────────────────────────
function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}
const round = (n) => Math.round(n * 1000) / 1000;

async function bench(label, iters, fn) {
  // small warmup
  for (let i = 0; i < Math.min(5, iters); i++) await fn(i);
  const t = [];
  for (let i = 0; i < iters; i++) {
    const s = performance.now();
    await fn(i);
    t.push(performance.now() - s);
  }
  const row = { label, iters, p50_ms: round(pct(t, 50)), p95_ms: round(pct(t, 95)), p99_ms: round(pct(t, 99)), mean_ms: round(t.reduce((a, b) => a + b, 0) / t.length) };
  console.log(`  ${label.padEnd(26)} p50=${String(row.p50_ms).padStart(8)}  p95=${String(row.p95_ms).padStart(8)}  p99=${String(row.p99_ms).padStart(8)}  (n=${iters})`);
  return row;
}

// ── Synthetic builders for pure ops ─────────────────────────
function syntheticGraph(nNodes = 60, fanout = 2) {
  const nodes = [];
  for (let i = 0; i < nNodes; i++) {
    const type = ["material", "order", "allocation", "line", "factory"][i % 5];
    nodes.push({ id: `n${i}`, node_type: type, ref_id: `ref${i}`, attrs: {} });
  }
  const edges = [];
  for (let i = 0; i < nNodes; i++) {
    for (let f = 1; f <= fanout; f++) {
      const to = (i + f) % nNodes;
      if (to !== i) edges.push({ from_node: `n${i}`, to_node: `n${to}`, edge_type: "feeds", weight: 0.8 });
    }
  }
  return buildGraph(nodes, edges);
}
const RISK_SIGNALS = { buffer_days: -2, deviation_pct: -18, qc_failure_count: 1, active_rework_count: 1, material_shortage_count: 1, runtime_risk: "amber", customer_risk_level: "medium", recent_anomalies: 2 };
const DECISION_CTX = {
  subject: { type: "order", id: "bench-order" }, decision_type: "delay_resolution", urgency: "high",
  risk_score: 65, expected_delay_days: 6, deviation_pct: -18, qty: 1000, order_revenue: 80000,
  gross_margin_pct: 18, estimated_margin_impact: 2600, affected_orders: ["bench-order"], affected_lines: [], affected_factories: [],
  runtime_status: "blocked", overload_pct: 20, current_efficiency: 0.8, material_shortage_count: 1, material_eta_days: 4,
  has_substitute: true, partial_available: true, qc_failed: false, defect_rate_pct: 10, rework_qty: 50,
  alternative_factories: [{ id: "f2", name: "Alt A", score: 80, affected_orders: [] }], alternative_lines: [{ id: "l2", name: "Line 2", affected_orders: [] }],
};

// ── Seeding ─────────────────────────────────────────────────
async function seed() {
  console.log("\n▸ Seeding synthetic workload…");
  const factories = [];
  for (let i = 1; i <= 5; i++) {
    const { factoryId, lineId } = await createTestFactoryAndLine(db, String(i));
    const lines = [lineId];
    // 3 extra lines per factory → 4 each → 20 total
    const extra = [];
    for (let j = 2; j <= 4; j++) extra.push({ factory_id: factoryId, name: `${V75_MARK}-line${i}-${j}`, status: "active" });
    const { data } = await db.from("production_lines").insert(extra).select("id");
    (data ?? []).forEach((l) => lines.push(l.id));
    factories.push({ factoryId, lines });
  }
  const allLines = factories.flatMap((f) => f.lines.map((id) => ({ id, factoryId: f.factoryId })));
  const orderIds = Array.from({ length: 100 }, (_, i) => `${V75_MARK}-order-${i}`);

  // 1000 runtime events
  const events = Array.from({ length: 1000 }, (_, i) => {
    const ln = allLines[i % allLines.length];
    return {
      event_type: EVENT_TYPES[i % EVENT_TYPES.length], severity: SEVERITIES[i % SEVERITIES.length],
      source: "system", source_ref: `${V75_MARK}:bench:${i}`,
      factory_id: ln.factoryId, line_id: ln.id, order_id: orderIds[i % orderIds.length],
      payload: { i }, occurred_at: new Date(Date.now() - i * 60000).toISOString(),
    };
  });
  await insertBatched("runtime_events", events);

  // 500 tasks (manual source so no partial-unique conflicts)
  const tasks = Array.from({ length: 500 }, (_, i) => ({
    title: `${V75_MARK} bench task ${i}`, severity: ["ok", "warn", "critical"][i % 3],
    status: "open", source_type: "manual", source_ref: `${V75_MARK}:bench-task:${i}`,
    subject_type: "order", subject_id: orderIds[i % orderIds.length], created_by: V75_ACTOR,
  }));
  await insertBatched("decision_tasks", tasks);

  // 200 notifications (no task_id → avoids dedup unique + FK)
  const notifs = Array.from({ length: 200 }, (_, i) => ({
    recipient: RECIPIENT, kind: "task_created", channel: "in_app",
    title: `${V75_MARK} bench notif ${i}`, dedup_key: `${V75_MARK}:bench:${i}`, severity: "warn",
  }));
  await insertBatched("notification_events", notifs);

  console.log(`  seeded: 5 factories, ${allLines.length} lines, 100 orders, 1000 events, 500 tasks, 200 notifications`);
  return { factories, allLines, orderIds };
}

async function insertBatched(table, rows, size = 500) {
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await db.from(table).insert(rows.slice(i, i + size));
    if (error) throw new Error(`seed ${table}: ${error.message}`);
  }
}

async function benchCleanup() {
  if (KEEP) { console.log("\nℹ Seeded data retained (--keep)."); return; }
  console.log("\n▸ Teardown…");
  try { await db.from("notification_events").delete().eq("recipient", RECIPIENT); } catch { /* best effort */ }
  try { await db.from("decision_tasks").delete().eq("created_by", V75_ACTOR); } catch { /* best effort */ }
  const removed = await teardownTestData(db);
  console.log("  done:", Object.keys(removed).join(", "));
}

// ── Run ──────────────────────────────────────────────────────
const report = { generated_at: new Date().toISOString(), seeded: !NO_SEED, results: [] };

try {
  let seedInfo = null;
  if (!NO_SEED) seedInfo = await seed();

  console.log("\n▸ Pure operations");
  const graph = syntheticGraph();
  report.results.push(await bench("runtime propagation", 2000, () => { propagate(graph, "n0", "critical"); }));
  report.results.push(await bench("risk evaluation", 5000, () => { assessOrder({ id: "bench" }, RISK_SIGNALS); }));
  report.results.push(await bench("decision evaluation", 2000, () => { assembleDecision(DECISION_CTX, {}); }));

  if (!NO_SEED) {
    console.log("\n▸ Database operations");
    const f = seedInfo.factories[0];
    // dashboard loading — representative read mix scoped to a seeded factory
    report.results.push(await bench("dashboard loading", 30, async () => {
      await Promise.all([
        db.from("production_runtime_lines").select("line_id, runtime_status, runtime_risk").eq("factory_id", f.factoryId),
        db.from("decision_tasks").select("id", { count: "exact", head: true }).not("status", "in", "(resolved,dismissed)"),
        db.from("runtime_events").select("id, event_type, severity").eq("factory_id", f.factoryId).order("occurred_at", { ascending: false }).limit(50),
      ]);
    }));
    // task generation — auto-generate over the seeded critical/high events
    report.results.push(await bench("task generation", 5, async () => {
      await autoGenerateTasks(db, { actor: V75_ACTOR });
    }));
  }
} catch (err) {
  console.error("\n❌ benchmark error:", err?.message ?? err);
  report.error = err?.message ?? String(err);
} finally {
  try { await benchCleanup(); } catch (err) { console.error("cleanup error:", err?.message ?? err); }
}

const outPath = new URL("../performance-baseline.json", import.meta.url).pathname;
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`\n📄 Baseline written: ${outPath}\n`);
process.exit(report.error ? 1 : 0);
