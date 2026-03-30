#!/usr/bin/env node

/**
 * Production Data Validation Script
 *
 * Connects to Supabase, loads all scheduling-relevant tables,
 * validates every record, cross-checks referential integrity,
 * and runs the optimizer in preview mode.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node src/scripts/validate-data.js
 *
 * Exit codes:
 *   0 = all clear, optimizer safe to run
 *   1 = blocking issues found (optimizer would fail or produce garbage)
 *   2 = connection / env error
 */

import { createClient } from "@supabase/supabase-js";
import { isValid, parseISO, differenceInCalendarDays } from "date-fns";
import { optimizeSchedule } from "../scheduler/optimizer.js";

// ── Bootstrap ───────────────────────────────────────────

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;

if (!url || !key) {
  console.error("ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.");
  console.error("  export SUPABASE_URL=https://xxx.supabase.co");
  console.error("  export SUPABASE_SERVICE_KEY=eyJ...");
  process.exit(2);
}

const supabase = createClient(url, key);

// ── Issue tracker ───────────────────────────────────────

const issues = [];
let blockingCount = 0;

function issue(severity, table, id, field, message) {
  const entry = { severity, table, id: id ?? "—", field: field ?? "—", message };
  issues.push(entry);
  if (severity === "BLOCK") blockingCount++;
}

// ── Main ────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  Production-OS Data Validation Report           ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  // 1. Load all data
  const data = await loadAllData();
  if (!data) return;

  // 2. Validate each table
  const factoryReport = validateFactories(data.factories);
  const capReport = validateCapabilities(data.capabilities, data.factories);
  const allocReport = validateAllocations(data.allocations, data.capabilities);
  const crossReport = crossTableChecks(data);

  // 3. Run optimizer preview (dry run on real data)
  const optimizerReport = await runOptimizerPreview(data);

  // 4. Print report
  printSection("1. FACTORIES", factoryReport);
  printSection("2. FACTORY CAPABILITIES", capReport);
  printSection("3. PRODUCTION ALLOCATIONS", allocReport);
  printSection("4. CROSS-TABLE INTEGRITY", crossReport);
  printSection("5. OPTIMIZER PREVIEW", optimizerReport);
  printIssuesSummary();
  printVerdict();
}

// ── Data loading ────────────────────────────────────────

async function loadAllData() {
  console.log("Loading data from Supabase...\n");

  const results = {};
  const tables = [
    { key: "factories", query: () => supabase.from("factories").select("*") },
    { key: "capabilities", query: () => supabase.from("factory_capabilities").select("*") },
    { key: "allocations", query: () => supabase.from("production_allocations").select("*, factories(id, name, code)") },
    { key: "risk_alerts", query: () => supabase.from("risk_alerts").select("*") },
  ];

  for (const t of tables) {
    const { data, error } = await t.query();
    if (error) {
      if (t.key === "risk_alerts") {
        console.log(`  ${t.key}: table not found or empty (optional, skipping)`);
        results[t.key] = [];
        continue;
      }
      console.error(`  FATAL: Failed to load ${t.key}: ${error.message}`);
      issue("BLOCK", t.key, null, null, `Table load failed: ${error.message}`);
      results[t.key] = [];
    } else {
      results[t.key] = data ?? [];
      console.log(`  ${t.key}: ${results[t.key].length} rows`);
    }
  }

  console.log("");
  return results;
}

// ── Factory validation ──────────────────────────────────

function validateFactories(factories) {
  const stats = { total: factories.length, active: 0, inactive: 0, maintenance: 0, issues: 0 };

  for (const f of factories) {
    if (f.status === "active") stats.active++;
    else if (f.status === "inactive") stats.inactive++;
    else if (f.status === "maintenance") stats.maintenance++;
    else {
      issue("WARN", "factories", f.id, "status", `Invalid status: "${f.status}"`);
      stats.issues++;
    }

    if (!f.name || f.name.trim() === "") {
      issue("BLOCK", "factories", f.id, "name", "Missing factory name");
      stats.issues++;
    }

    if (!f.code || f.code.trim() === "") {
      issue("BLOCK", "factories", f.id, "code", "Missing factory code");
      stats.issues++;
    }

    if (!f.timezone) {
      issue("WARN", "factories", f.id, "timezone", "Missing timezone (will default to UTC)");
    }
  }

  return {
    lines: [
      `Total: ${stats.total}`,
      `Active: ${stats.active} | Inactive: ${stats.inactive} | Maintenance: ${stats.maintenance}`,
      `Issues: ${stats.issues}`,
    ],
  };
}

// ── Capability validation ───────────────────────────────

function validateCapabilities(capabilities, factories) {
  const stats = { total: capabilities.length, valid: 0, issues: 0 };
  const factoryIds = new Set(factories.map((f) => f.id));
  const productTypes = new Set();
  const capsByFactory = {};

  for (const c of capabilities) {
    let hasIssue = false;
    productTypes.add(c.product_type);

    if (!capsByFactory[c.factory_id]) capsByFactory[c.factory_id] = [];
    capsByFactory[c.factory_id].push(c);

    if (!factoryIds.has(c.factory_id)) {
      issue("BLOCK", "factory_capabilities", c.id, "factory_id", `References non-existent factory ${c.factory_id}`);
      hasIssue = true;
    }

    const mpu = Number(c.minutes_per_unit);
    if (!mpu || mpu <= 0) {
      issue("BLOCK", "factory_capabilities", c.id, "minutes_per_unit", `Value is ${c.minutes_per_unit} — optimizer division by zero risk`);
      hasIssue = true;
    }

    const bcp = Number(c.base_capacity_units_per_day);
    if (!bcp || bcp <= 0) {
      issue("WARN", "factory_capabilities", c.id, "base_capacity_units_per_day", `Value is ${c.base_capacity_units_per_day} — scoring may be inaccurate`);
    }

    const qs = c.quality_score != null ? Number(c.quality_score) : null;
    if (qs !== null && (qs < 0 || qs > 100)) {
      issue("WARN", "factory_capabilities", c.id, "quality_score", `Out of range [0,100]: ${qs}`);
    }

    if (c.cost_per_unit != null && Number(c.cost_per_unit) < 0) {
      issue("WARN", "factory_capabilities", c.id, "cost_per_unit", `Negative cost: ${c.cost_per_unit}`);
    }

    if (!c.product_type || c.product_type.trim() === "") {
      issue("BLOCK", "factory_capabilities", c.id, "product_type", "Empty product_type");
      hasIssue = true;
    }

    if (!hasIssue) stats.valid++;
    else stats.issues++;
  }

  const activeFactories = factories.filter((f) => f.status === "active");
  for (const f of activeFactories) {
    if (!capsByFactory[f.id] || capsByFactory[f.id].length === 0) {
      issue("WARN", "factories", f.id, "capabilities", `Active factory "${f.name}" has no capabilities — optimizer will skip it`);
    }
  }

  return {
    lines: [
      `Total: ${stats.total} | Valid: ${stats.valid} | Issues: ${stats.issues}`,
      `Product types in system: ${[...productTypes].sort().join(", ") || "(none)"}`,
      `Active factories with capabilities: ${Object.keys(capsByFactory).length}/${activeFactories.length}`,
    ],
  };
}

// ── Allocation validation ───────────────────────────────

function validateAllocations(allocations, capabilities) {
  const now = new Date();
  const stats = {
    total: allocations.length,
    by_status: {},
    valid_planned: 0,
    issues: 0,
    past_due: 0,
    no_capability_match: 0,
  };

  const allProductTypes = new Set(capabilities.map((c) => c.product_type));

  for (const a of allocations) {
    stats.by_status[a.status] = (stats.by_status[a.status] ?? 0) + 1;

    const isActive = ["planned", "confirmed", "in_progress"].includes(a.status);
    if (!isActive) continue;

    let hasIssue = false;

    if (!a.product_type || a.product_type.trim() === "") {
      issue("BLOCK", "production_allocations", a.id, "product_type", "Empty product_type");
      hasIssue = true;
    }

    const qty = Number(a.quantity);
    if (!qty || qty <= 0 || isNaN(qty)) {
      issue("BLOCK", "production_allocations", a.id, "quantity", `Invalid quantity: ${a.quantity}`);
      hasIssue = true;
    }

    if (!a.start_at) {
      issue("BLOCK", "production_allocations", a.id, "start_at", "Missing start_at");
      hasIssue = true;
    } else if (!isValid(parseISO(a.start_at))) {
      issue("BLOCK", "production_allocations", a.id, "start_at", `Invalid date: ${a.start_at}`);
      hasIssue = true;
    }

    if (!a.end_at) {
      issue("BLOCK", "production_allocations", a.id, "end_at", "Missing end_at");
      hasIssue = true;
    } else if (!isValid(parseISO(a.end_at))) {
      issue("BLOCK", "production_allocations", a.id, "end_at", `Invalid date: ${a.end_at}`);
      hasIssue = true;
    }

    if (a.start_at && a.end_at) {
      const s = parseISO(a.start_at);
      const e = parseISO(a.end_at);
      if (isValid(s) && isValid(e) && e <= s) {
        issue("BLOCK", "production_allocations", a.id, "end_at", `end_at (${a.end_at}) <= start_at (${a.start_at})`);
        hasIssue = true;
      }

      if (a.status === "planned" && isValid(e)) {
        const daysLeft = differenceInCalendarDays(e, now);
        if (daysLeft < 0) {
          issue("WARN", "production_allocations", a.id, "end_at", `Planned order is already past due by ${Math.abs(daysLeft)} days`);
          stats.past_due++;
        }
      }
    }

    if (a.product_type && !allProductTypes.has(a.product_type)) {
      issue("WARN", "production_allocations", a.id, "product_type", `Product type "${a.product_type}" has no matching factory capability`);
      stats.no_capability_match++;
    }

    if (!hasIssue && a.status === "planned") stats.valid_planned++;
    if (hasIssue) stats.issues++;
  }

  const statusLine = Object.entries(stats.by_status)
    .map(([k, v]) => `${k}: ${v}`)
    .join(" | ");

  return {
    lines: [
      `Total: ${stats.total}`,
      `By status: ${statusLine || "(none)"}`,
      `Valid planned (optimizer input): ${stats.valid_planned}`,
      `Past-due planned orders: ${stats.past_due}`,
      `Unmatched product types: ${stats.no_capability_match}`,
      `Issues: ${stats.issues}`,
    ],
  };
}

// ── Cross-table checks ──────────────────────────────────

function crossTableChecks(data) {
  const { factories, capabilities, allocations } = data;
  const lines = [];
  const factoryIds = new Set(factories.map((f) => f.id));
  const activeFactoryIds = new Set(factories.filter((f) => f.status === "active").map((f) => f.id));
  const capProductTypes = new Set(capabilities.map((c) => c.product_type));

  const activeAllocs = allocations.filter((a) => ["planned", "confirmed", "in_progress"].includes(a.status));
  let inactiveRef = 0;
  let missingRef = 0;
  for (const a of activeAllocs) {
    if (!factoryIds.has(a.factory_id)) {
      issue("BLOCK", "production_allocations", a.id, "factory_id", `References non-existent factory ${a.factory_id}`);
      missingRef++;
    } else if (!activeFactoryIds.has(a.factory_id)) {
      issue("WARN", "production_allocations", a.id, "factory_id", `Allocated to inactive/maintenance factory ${a.factory_id}`);
      inactiveRef++;
    }
  }
  lines.push(`Active allocations → inactive factory: ${inactiveRef}`);
  lines.push(`Active allocations → missing factory: ${missingRef}`);

  const plannedTypes = new Set(
    allocations.filter((a) => a.status === "planned").map((a) => a.product_type),
  );
  const unsupportedTypes = [...plannedTypes].filter((pt) => !capProductTypes.has(pt));
  if (unsupportedTypes.length > 0) {
    for (const pt of unsupportedTypes) {
      issue("BLOCK", "cross_check", null, "product_type", `Planned orders require "${pt}" but no factory has this capability`);
    }
    lines.push(`Unsupported product types in planned orders: ${unsupportedTypes.join(", ")}`);
  } else {
    lines.push(`All planned product types have capable factories`);
  }

  const typeToFactories = {};
  for (const c of capabilities) {
    if (!activeFactoryIds.has(c.factory_id)) continue;
    if (!typeToFactories[c.product_type]) typeToFactories[c.product_type] = new Set();
    typeToFactories[c.product_type].add(c.factory_id);
  }
  const singleSource = Object.entries(typeToFactories)
    .filter(([, fids]) => fids.size === 1)
    .map(([pt]) => pt);
  if (singleSource.length > 0) {
    lines.push(`Single-source product types (no backup): ${singleSource.join(", ")}`);
    for (const pt of singleSource) {
      issue("WARN", "cross_check", null, "resilience", `"${pt}" has only 1 active factory — no backup if it goes offline`);
    }
  } else {
    lines.push("All product types have >= 2 capable factories (good resilience)");
  }

  return { lines };
}

// ── Optimizer preview ───────────────────────────────────

async function runOptimizerPreview(data) {
  const { factories, capabilities, allocations } = data;
  const lines = [];

  const planned = allocations.filter((a) => a.status === "planned");
  if (planned.length === 0) {
    lines.push("No planned orders to optimize.");
    lines.push("Optimizer would return empty result (safe).");
    return { lines };
  }

  const activeFactories = factories.filter((f) => f.status === "active");
  const capsByFactory = {};
  for (const c of capabilities) {
    if (!capsByFactory[c.factory_id]) capsByFactory[c.factory_id] = [];
    capsByFactory[c.factory_id].push(c);
  }

  const existing = allocations.filter((a) => ["confirmed", "in_progress"].includes(a.status));
  const loadByFactory = {};
  for (const ea of existing) {
    if (!loadByFactory[ea.factory_id]) loadByFactory[ea.factory_id] = 0;
    const caps = capsByFactory[ea.factory_id] ?? [];
    const cap = caps.find((c) => c.product_type === ea.product_type);
    if (cap) {
      loadByFactory[ea.factory_id] += (Number(cap.setup_minutes) || 0) + Number(ea.quantity) * (Number(cap.minutes_per_unit) || 0);
    }
  }

  const horizonDays = 30;
  const factoryInputs = activeFactories
    .filter((f) => (capsByFactory[f.id] ?? []).length > 0)
    .map((f) => {
      const dailyMinutes = 8 * 60;
      const capacityWindow = dailyMinutes * horizonDays;
      const allocated = loadByFactory[f.id] ?? 0;
      return {
        id: f.id,
        name: f.name,
        capabilities: (capsByFactory[f.id] ?? []).map((c) => ({
          product_type: c.product_type,
          setup_minutes: Number(c.setup_minutes),
          minutes_per_unit: Number(c.minutes_per_unit),
          base_capacity_units_per_day: Number(c.base_capacity_units_per_day),
          cost_per_unit: c.cost_per_unit != null ? Number(c.cost_per_unit) : null,
          quality_score: c.quality_score != null ? Number(c.quality_score) : null,
        })),
        capacity: { daily_capacity_minutes: dailyMinutes },
        load: {
          allocated_minutes_next_30d: allocated,
          utilization_pct: Math.min(100, (allocated / Math.max(1, capacityWindow)) * 100),
        },
      };
    });

  const orderInputs = planned.map((a) => ({
    id: a.id,
    product_type: a.product_type,
    quantity: Number(a.quantity),
    due_date: a.end_at,
    priority: a.priority ?? 0,
    order_external_id: a.order_external_id,
  }));

  lines.push(`Optimizer input: ${orderInputs.length} orders, ${factoryInputs.length} factories`);

  try {
    const result = optimizeSchedule({
      orders: orderInputs,
      factories: factoryInputs,
      options: { horizon_days: horizonDays },
    });

    lines.push(`Assigned: ${result.summary.assigned}/${result.summary.total_orders}`);
    lines.push(`Feasible: ${result.summary.feasible} | Infeasible: ${result.summary.infeasible}`);
    lines.push(`Splits: ${result.summary.splits}`);
    lines.push(`Warnings: ${result.summary.warnings_count}`);
    lines.push(`Avg confidence: ${(result.summary.avg_confidence * 100).toFixed(1)}%`);

    if (result.summary.unassigned > 0) {
      lines.push(`Unassigned: ${result.summary.unassigned}`);
      for (const u of result.unassigned) {
        lines.push(`  -> ${u.id?.slice(0, 8)}... ${u.product_type} x${u.quantity}: ${u.reason}`);
      }
    }

    const loadEntries = Object.entries(result.summary.factory_load);
    if (loadEntries.length > 0) {
      lines.push("Factory load after optimization:");
      for (const [, info] of loadEntries) {
        const pct = Math.round(info.utilization_pct);
        const filled = Math.round(pct / 5);
        const bar = "#".repeat(filled) + ".".repeat(20 - filled);
        lines.push(`  ${info.factory_name.padEnd(22)} [${bar}] ${pct}% (${info.orders} orders)`);
      }
    }

    if (result.warnings.length > 0) {
      lines.push("Optimizer warnings:");
      for (const w of result.warnings) {
        lines.push(`  [${w.type}] ${w.message}`);
      }
    }

    lines.push("");
    lines.push(result.summary.unassigned === 0
      ? "Optimizer can schedule all orders successfully."
      : `Optimizer can schedule ${result.summary.assigned}/${result.summary.total_orders} orders. ${result.summary.unassigned} need attention.`);

  } catch (err) {
    issue("BLOCK", "optimizer", null, null, `Optimizer crashed: ${err.message}`);
    lines.push(`OPTIMIZER CRASHED: ${err.message}`);
    lines.push("Fix data issues above before running optimizer.");
  }

  return { lines };
}

// ── Report printing ─────────────────────────────────────

function printSection(title, report) {
  console.log(`-- ${title} ${"─".repeat(Math.max(0, 48 - title.length))}`);
  for (const line of report.lines) {
    console.log(`  ${line}`);
  }
  console.log("");
}

function printIssuesSummary() {
  console.log("-- ISSUES DETAIL ──────────────────────────────────");

  if (issues.length === 0) {
    console.log("  No issues found.\n");
    return;
  }

  const blocking = issues.filter((i) => i.severity === "BLOCK");
  const warnings = issues.filter((i) => i.severity === "WARN");

  if (blocking.length > 0) {
    console.log(`\n  BLOCKING (${blocking.length}):`);
    for (const i of blocking.slice(0, 20)) {
      console.log(`    [${i.table}] ${i.id !== "—" ? i.id.slice(0, 8) + "... " : ""}${i.field}: ${i.message}`);
    }
    if (blocking.length > 20) console.log(`    ... and ${blocking.length - 20} more`);
  }

  if (warnings.length > 0) {
    console.log(`\n  WARNINGS (${warnings.length}):`);
    for (const i of warnings.slice(0, 20)) {
      console.log(`    [${i.table}] ${i.id !== "—" ? i.id.slice(0, 8) + "... " : ""}${i.field}: ${i.message}`);
    }
    if (warnings.length > 20) console.log(`    ... and ${warnings.length - 20} more`);
  }

  console.log("");
}

function printVerdict() {
  console.log("==================================================");
  const warnCount = issues.filter((i) => i.severity === "WARN").length;

  if (blockingCount > 0) {
    console.log(`  VERDICT: FAIL — ${blockingCount} blocking issues found.`);
    console.log("  Fix blocking issues before running optimizer on production data.");
    console.log("==================================================\n");
    process.exit(1);
  } else if (warnCount > 0) {
    console.log(`  VERDICT: PASS WITH WARNINGS — ${warnCount} non-blocking issues.`);
    console.log("  Optimizer can run safely. Review warnings to improve data quality.");
    console.log("==================================================\n");
    process.exit(0);
  } else {
    console.log("  VERDICT: PASS — All data valid. Optimizer safe to run.");
    console.log("==================================================\n");
    process.exit(0);
  }
}

// ── Run ─────────────────────────────────────────────────

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(2);
});
