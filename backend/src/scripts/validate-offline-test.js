#!/usr/bin/env node

/**
 * Offline validation test — exercises every validation path
 * using synthetic data with known defects. No Supabase needed.
 *
 * Run: node src/scripts/validate-offline-test.js
 */

import { isValid, parseISO, differenceInCalendarDays, addDays } from "date-fns";
import { optimizeSchedule } from "../scheduler/optimizer.js";

const now = new Date();
let pass = 0;
let fail = 0;

function assert(cond, label) {
  if (cond) { pass++; }
  else { fail++; console.log(`  FAIL: ${label}`); }
}

// ── Synthetic data with known issues ────────────────────

const factories = [
  { id: "f1", code: "SZ01", name: "Shenzhen Alpha", status: "active", timezone: "Asia/Shanghai" },
  { id: "f2", code: "SU02", name: "Suzhou Beta", status: "active", timezone: "Asia/Shanghai" },
  { id: "f3", code: "", name: "", status: "active", timezone: null },          // BLOCK: missing code + name
  { id: "f4", code: "CD04", name: "Chengdu Gamma", status: "inactive", timezone: "Asia/Shanghai" },
  { id: "f5", code: "GZ05", name: "Guangzhou Delta", status: "bogus", timezone: "Asia/Shanghai" }, // WARN: bad status
];

const capabilities = [
  { id: "c1", factory_id: "f1", product_type: "widget-A", minutes_per_unit: 0.5, setup_minutes: 30, base_capacity_units_per_day: 960, quality_score: 90, cost_per_unit: 12 },
  { id: "c2", factory_id: "f1", product_type: "widget-B", minutes_per_unit: 0.8, setup_minutes: 45, base_capacity_units_per_day: 600, quality_score: 85, cost_per_unit: 15 },
  { id: "c3", factory_id: "f2", product_type: "widget-A", minutes_per_unit: 0.6, setup_minutes: 20, base_capacity_units_per_day: 800, quality_score: 82, cost_per_unit: 10 },
  { id: "c4", factory_id: "f2", product_type: "widget-C", minutes_per_unit: 0,   setup_minutes: 60, base_capacity_units_per_day: 0, quality_score: 78, cost_per_unit: 8 },   // BLOCK: minutes_per_unit = 0
  { id: "c5", factory_id: "f_nonexistent", product_type: "widget-X", minutes_per_unit: 1.0, setup_minutes: 10, base_capacity_units_per_day: 480, quality_score: 110, cost_per_unit: -5 }, // BLOCK: orphan factory, WARN: quality>100, cost<0
  { id: "c6", factory_id: "f4", product_type: "widget-B", minutes_per_unit: 0.7, setup_minutes: 25, base_capacity_units_per_day: 685, quality_score: 88, cost_per_unit: 11 },
  { id: "c7", factory_id: "f1", product_type: "", minutes_per_unit: 0.5, setup_minutes: 10, base_capacity_units_per_day: 960, quality_score: 50, cost_per_unit: 5 }, // BLOCK: empty product_type
];

const allocations = [
  // Valid planned
  { id: "a1", factory_id: "f1", product_type: "widget-A", quantity: 1200, start_at: now.toISOString(), end_at: addDays(now, 12).toISOString(), status: "planned", priority: 0 },
  { id: "a2", factory_id: "f2", product_type: "widget-A", quantity: 800, start_at: now.toISOString(), end_at: addDays(now, 8).toISOString(), status: "planned", priority: 2 },
  // Past-due planned
  { id: "a3", factory_id: "f1", product_type: "widget-B", quantity: 500, start_at: addDays(now, -10).toISOString(), end_at: addDays(now, -2).toISOString(), status: "planned", priority: 0 },
  // Invalid quantity
  { id: "a4", factory_id: "f1", product_type: "widget-A", quantity: 0, start_at: now.toISOString(), end_at: addDays(now, 5).toISOString(), status: "planned", priority: 0 },
  // Missing end_at
  { id: "a5", factory_id: "f1", product_type: "widget-A", quantity: 100, start_at: now.toISOString(), end_at: null, status: "planned", priority: 0 },
  // end_at <= start_at
  { id: "a6", factory_id: "f1", product_type: "widget-B", quantity: 200, start_at: addDays(now, 5).toISOString(), end_at: addDays(now, 3).toISOString(), status: "planned", priority: 0 },
  // Unsupported product type
  { id: "a7", factory_id: "f1", product_type: "widget-Z", quantity: 100, start_at: now.toISOString(), end_at: addDays(now, 10).toISOString(), status: "planned", priority: 0 },
  // Confirmed — allocated to inactive factory
  { id: "a8", factory_id: "f4", product_type: "widget-B", quantity: 300, start_at: now.toISOString(), end_at: addDays(now, 7).toISOString(), status: "confirmed", priority: 0 },
  // Confirmed — allocated to non-existent factory
  { id: "a9", factory_id: "f_gone", product_type: "widget-A", quantity: 100, start_at: now.toISOString(), end_at: addDays(now, 5).toISOString(), status: "in_progress", priority: 0 },
  // Completed — should not be deeply validated
  { id: "a10", factory_id: "f1", product_type: "widget-A", quantity: 500, start_at: addDays(now, -20).toISOString(), end_at: addDays(now, -10).toISOString(), status: "completed", priority: 0 },
];

// ── Run validations (inline, same logic as validate-data.js) ──

console.log("=== Offline Validation Test ===\n");

// Factory validation
const issues = [];
function issue(sev, table, id, field, msg) { issues.push({ severity: sev, table, id, field, message: msg }); }

for (const f of factories) {
  if (!f.name || f.name.trim() === "") issue("BLOCK", "factories", f.id, "name", "Missing name");
  if (!f.code || f.code.trim() === "") issue("BLOCK", "factories", f.id, "code", "Missing code");
  if (!["active", "inactive", "maintenance"].includes(f.status)) issue("WARN", "factories", f.id, "status", `Bad: ${f.status}`);
  if (!f.timezone) issue("WARN", "factories", f.id, "timezone", "Missing");
}

// Capability validation
const factoryIds = new Set(factories.map((f) => f.id));
for (const c of capabilities) {
  if (!factoryIds.has(c.factory_id)) issue("BLOCK", "capabilities", c.id, "factory_id", "Orphan");
  if (!Number(c.minutes_per_unit) || Number(c.minutes_per_unit) <= 0) issue("BLOCK", "capabilities", c.id, "minutes_per_unit", "Zero/missing");
  if (c.quality_score != null && (Number(c.quality_score) < 0 || Number(c.quality_score) > 100)) issue("WARN", "capabilities", c.id, "quality_score", "Out of range");
  if (c.cost_per_unit != null && Number(c.cost_per_unit) < 0) issue("WARN", "capabilities", c.id, "cost_per_unit", "Negative");
  if (!c.product_type || c.product_type.trim() === "") issue("BLOCK", "capabilities", c.id, "product_type", "Empty");
}

// Allocation validation
const capTypes = new Set(capabilities.map((c) => c.product_type).filter(Boolean));
for (const a of allocations) {
  if (!["planned", "confirmed", "in_progress"].includes(a.status)) continue;
  if (!a.product_type) issue("BLOCK", "allocations", a.id, "product_type", "Empty");
  if (!Number(a.quantity) || Number(a.quantity) <= 0) issue("BLOCK", "allocations", a.id, "quantity", "Invalid");
  if (!a.end_at) issue("BLOCK", "allocations", a.id, "end_at", "Missing");
  else if (a.start_at && new Date(a.end_at) <= new Date(a.start_at)) issue("BLOCK", "allocations", a.id, "end_at", "end <= start");
  if (a.product_type && !capTypes.has(a.product_type)) issue("WARN", "allocations", a.id, "product_type", `Unmatched: ${a.product_type}`);
}

// Cross-table
const activeFactoryIds = new Set(factories.filter((f) => f.status === "active").map((f) => f.id));
for (const a of allocations.filter((a) => ["planned", "confirmed", "in_progress"].includes(a.status))) {
  if (!factoryIds.has(a.factory_id)) issue("BLOCK", "allocations", a.id, "factory_id", "Missing factory");
  else if (!activeFactoryIds.has(a.factory_id)) issue("WARN", "allocations", a.id, "factory_id", "Inactive factory");
}

// ── Assertions ──────────────────────────────────────────

const blocking = issues.filter((i) => i.severity === "BLOCK");
const warnings = issues.filter((i) => i.severity === "WARN");

console.log(`Issues found: ${blocking.length} BLOCK, ${warnings.length} WARN\n`);

// f3 should trigger 2 BLOCK (name + code)
assert(blocking.some((i) => i.id === "f3" && i.field === "name"), "f3 missing name detected");
assert(blocking.some((i) => i.id === "f3" && i.field === "code"), "f3 missing code detected");

// f5 should trigger WARN for bad status
assert(warnings.some((i) => i.id === "f5" && i.field === "status"), "f5 bad status detected");

// c4 minutes_per_unit = 0 should BLOCK
assert(blocking.some((i) => i.id === "c4" && i.field === "minutes_per_unit"), "c4 zero minutes_per_unit detected");

// c5 orphan factory should BLOCK
assert(blocking.some((i) => i.id === "c5" && i.field === "factory_id"), "c5 orphan factory detected");

// c5 quality > 100 should WARN
assert(warnings.some((i) => i.id === "c5" && i.field === "quality_score"), "c5 quality > 100 detected");

// c5 negative cost should WARN
assert(warnings.some((i) => i.id === "c5" && i.field === "cost_per_unit"), "c5 negative cost detected");

// c7 empty product_type should BLOCK
assert(blocking.some((i) => i.id === "c7" && i.field === "product_type"), "c7 empty product_type detected");

// a4 quantity=0 should BLOCK
assert(blocking.some((i) => i.id === "a4" && i.field === "quantity"), "a4 invalid quantity detected");

// a5 missing end_at should BLOCK
assert(blocking.some((i) => i.id === "a5" && i.field === "end_at"), "a5 missing end_at detected");

// a6 end_at <= start_at should BLOCK
assert(blocking.some((i) => i.id === "a6" && i.field === "end_at"), "a6 end <= start detected");

// a7 widget-Z should WARN (unmatched product type)
assert(warnings.some((i) => i.id === "a7" && i.field === "product_type"), "a7 unmatched product_type detected");

// a8 inactive factory should WARN
assert(warnings.some((i) => i.id === "a8" && i.field === "factory_id"), "a8 inactive factory detected");

// a9 non-existent factory should BLOCK
assert(blocking.some((i) => i.id === "a9" && i.field === "factory_id"), "a9 missing factory detected");

// a10 (completed) should NOT be deeply validated
assert(!issues.some((i) => i.id === "a10"), "a10 completed order not validated (correct)");

// ── Optimizer preview on clean subset ───────────────────

console.log("\n-- Optimizer preview on valid data subset --");

const validOrders = [
  { id: "a1", product_type: "widget-A", quantity: 1200, due_date: addDays(now, 12).toISOString(), priority: 0 },
  { id: "a2", product_type: "widget-A", quantity: 800, due_date: addDays(now, 8).toISOString(), priority: 2 },
];

const validFactories = [
  {
    id: "f1", name: "Shenzhen Alpha",
    capabilities: [
      { product_type: "widget-A", setup_minutes: 30, minutes_per_unit: 0.5, quality_score: 90, cost_per_unit: 12 },
    ],
    capacity: { daily_capacity_minutes: 480 },
    load: { allocated_minutes_next_30d: 0, utilization_pct: 0 },
  },
  {
    id: "f2", name: "Suzhou Beta",
    capabilities: [
      { product_type: "widget-A", setup_minutes: 20, minutes_per_unit: 0.6, quality_score: 82, cost_per_unit: 10 },
    ],
    capacity: { daily_capacity_minutes: 480 },
    load: { allocated_minutes_next_30d: 0, utilization_pct: 0 },
  },
];

try {
  const result = optimizeSchedule({ orders: validOrders, factories: validFactories, options: { horizon_days: 30 } });

  console.log(`  Assigned: ${result.summary.assigned}/${result.summary.total_orders}`);
  console.log(`  Feasible: ${result.summary.feasible}`);
  console.log(`  Avg confidence: ${(result.summary.avg_confidence * 100).toFixed(1)}%`);

  assert(result.summary.assigned === 2, "All 2 valid orders assigned");
  assert(result.summary.feasible === 2, "All 2 orders feasible");
  assert(result.summary.unassigned === 0, "No unassigned orders");
  assert(result.summary.avg_confidence > 0.5, "Avg confidence > 50%");

  // Urgent order (a2, priority 2) should be assigned first
  assert(result.allocations[0]?.order_id === "a2", "Urgent order a2 assigned first");

} catch (err) {
  fail++;
  console.log(`  FAIL: Optimizer crashed: ${err.message}`);
}

// ── Final result ────────────────────────────────────────

console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
