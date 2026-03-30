/**
 * Standalone test for the multi-order optimizer.
 * Run: node src/scheduler/optimizer-test.js
 */

import { optimizeSchedule } from "./optimizer.js";
import { addDays, format } from "date-fns";

const now = new Date();

// ── Test factories ──────────────────────────────────────

const factories = [
  {
    id: "f1",
    name: "Shenzhen Alpha",
    capabilities: [
      { product_type: "widget-A", setup_minutes: 30, minutes_per_unit: 0.5, quality_score: 90, cost_per_unit: 12 },
      { product_type: "widget-B", setup_minutes: 45, minutes_per_unit: 0.8, quality_score: 85, cost_per_unit: 15 },
    ],
    capacity: { daily_capacity_minutes: 480 },
    load: { allocated_minutes_next_30d: 2000, utilization_pct: 14 },
  },
  {
    id: "f2",
    name: "Suzhou Beta",
    capabilities: [
      { product_type: "widget-A", setup_minutes: 20, minutes_per_unit: 0.6, quality_score: 82, cost_per_unit: 10 },
      { product_type: "widget-C", setup_minutes: 60, minutes_per_unit: 1.2, quality_score: 78, cost_per_unit: 8 },
    ],
    capacity: { daily_capacity_minutes: 480 },
    load: { allocated_minutes_next_30d: 8000, utilization_pct: 56 },
  },
  {
    id: "f3",
    name: "Chengdu Gamma",
    capabilities: [
      { product_type: "widget-B", setup_minutes: 25, minutes_per_unit: 0.7, quality_score: 88, cost_per_unit: 11 },
      { product_type: "widget-C", setup_minutes: 40, minutes_per_unit: 1.0, quality_score: 80, cost_per_unit: 9 },
    ],
    capacity: { daily_capacity_minutes: 480 },
    load: { allocated_minutes_next_30d: 1000, utilization_pct: 7 },
  },
];

// ── Test orders ─────────────────────────────────────────

const orders = [
  { id: "ord-1", product_type: "widget-A", quantity: 1200, due_date: addDays(now, 12).toISOString(), priority: 0 },
  { id: "ord-2", product_type: "widget-B", quantity: 800, due_date: addDays(now, 8).toISOString(), priority: 2 }, // URGENT
  { id: "ord-3", product_type: "widget-C", quantity: 500, due_date: addDays(now, 20).toISOString(), priority: 0 },
  { id: "ord-4", product_type: "widget-A", quantity: 3000, due_date: addDays(now, 15).toISOString(), priority: 1 },
  { id: "ord-5", product_type: "widget-B", quantity: 600, due_date: addDays(now, 5).toISOString(), priority: 3 }, // EMERGENCY
  { id: "ord-6", product_type: "widget-D", quantity: 200, due_date: addDays(now, 10).toISOString(), priority: 0 }, // No factory can make this
];

// ── Run optimizer ───────────────────────────────────────

console.log("=== Multi-Order Scheduling Optimizer Test ===\n");
console.log(`Orders: ${orders.length}`);
console.log(`Factories: ${factories.length}\n`);

const result = optimizeSchedule({ orders, factories, options: { horizon_days: 30 } });

console.log("── Summary ────────────────────────────────");
console.log(JSON.stringify(result.summary, null, 2));

console.log("\n── Allocations ────────────────────────────");
for (const a of result.allocations) {
  const start = format(new Date(a.planned_start_date), "MMM d");
  const end = format(new Date(a.planned_end_date), "MMM d");
  console.log(
    `  ${a.order_id} → ${a.factory_name} | ` +
    `${a.product_type} x${a.allocated_qty} | ` +
    `${start}–${end} | ` +
    `buffer: ${a.buffer_days}d | ` +
    `score: ${(a.confidence_score * 100).toFixed(0)} | ` +
    `util: ${a.new_utilization_pct}%` +
    (a.split_index ? ` [SPLIT ${a.split_index}]` : ""),
  );
}

console.log("\n── Warnings ───────────────────────────────");
for (const w of result.warnings) {
  console.log(`  [${w.type}] ${w.message}`);
  console.log(`    → Suggestion: ${w.suggestion}`);
}

console.log("\n── Unassigned ─────────────────────────────");
for (const u of result.unassigned) {
  console.log(`  ${u.id}: ${u.product_type} x${u.quantity} — ${u.reason}`);
}

// ── Assertions ──────────────────────────────────────────

const errors = [];

// ord-5 (EMERGENCY, priority 3) should be assigned first
const ord5 = result.allocations.find((a) => a.order_id === "ord-5");
if (!ord5) errors.push("FAIL: Emergency order ord-5 not assigned");

// ord-6 (widget-D) should be unassigned — no factory makes it
const ord6Unassigned = result.unassigned.find((u) => u.id === "ord-6");
if (!ord6Unassigned) errors.push("FAIL: ord-6 (widget-D) should be unassigned");
else if (ord6Unassigned.reason !== "no_capable_factory") errors.push(`FAIL: ord-6 reason should be no_capable_factory, got: ${ord6Unassigned.reason}`);

// Should have a warning about widget-D sourcing
const sourcingWarning = result.warnings.find((w) => w.suggestion === "source_new_factory" && w.order_id === "ord-6");
if (!sourcingWarning) errors.push("FAIL: Missing source_new_factory warning for ord-6");

// At least some orders should be feasible
if (result.summary.feasible === 0 && result.summary.assigned > 0) errors.push("FAIL: No feasible assignments");

// Summary should be coherent
if (result.summary.assigned + result.summary.unassigned !== result.summary.total_orders) {
  errors.push(`FAIL: assigned(${result.summary.assigned}) + unassigned(${result.summary.unassigned}) != total(${result.summary.total_orders})`);
}

console.log("\n── Test Results ───────────────────────────");
if (errors.length === 0) {
  console.log("  ALL TESTS PASSED ✓");
} else {
  for (const e of errors) console.log(`  ${e}`);
  process.exit(1);
}
