import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

const router = Router();

// GET /api/exceptions — returns categorized exceptions
router.get("/", asyncHandler(async (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  // Run all queries in parallel
  const [allocRes, corrRes, linesRes, factRes, reportsRes] = await Promise.all([
    // Delayed: allocations past planned_end_date and not completed
    supabase
      .from("production_allocations")
      .select("id, order_id, factory_id, planned_end_date, status, allocated_qty, factories(id, name)")
      .lt("planned_end_date", today)
      .not("status", "eq", "completed")
      .not("status", "eq", "cancelled"),

    // At-risk: order_corrections with falling_behind or critical
    supabase
      .from("order_corrections")
      .select("allocation_id, order_id, factory_id, risk_status, deviation_pct, estimated_end_date")
      .in("risk_status", ["falling_behind", "critical"]),

    // Production lines with capacity data
    supabase
      .from("production_lines")
      .select("id, name, factory_id, capacity, factories(id, name)"),

    // Active factories
    supabase
      .from("factories")
      .select("id, name, status")
      .eq("status", "active"),

    // Today's reports
    supabase
      .from("daily_production_reports")
      .select("factory_id")
      .eq("date", today),
  ]);

  const exceptions = [];

  // ── Delayed allocations ──────────────────────────────────
  for (const alloc of allocRes.data ?? []) {
    const daysLate = Math.ceil((new Date(today) - new Date(alloc.planned_end_date)) / 86400000);
    exceptions.push({
      type: "delayed",
      severity: daysLate > 7 ? "high" : daysLate > 3 ? "medium" : "low",
      order_id: alloc.order_id,
      factory_name: alloc.factories?.name ?? "Unknown",
      message: `Allocation ${alloc.id} is ${daysLate} day(s) past planned end date (${alloc.planned_end_date})`,
      allocation_id: alloc.id,
      factory_id: alloc.factory_id,
    });
  }

  // ── At-risk from corrections ─────────────────────────────
  for (const corr of corrRes.data ?? []) {
    exceptions.push({
      type: "at_risk",
      severity: corr.risk_status === "critical" ? "high" : "medium",
      order_id: corr.order_id,
      factory_name: null, // factory_name not joined here
      message: `Order ${corr.order_id ?? corr.allocation_id} is ${corr.risk_status} — deviation ${corr.deviation_pct}%`,
      allocation_id: corr.allocation_id,
      factory_id: corr.factory_id,
      risk_status: corr.risk_status,
      deviation_pct: corr.deviation_pct,
    });
  }

  // ── Overloaded lines ─────────────────────────────────────
  // Check allocations assigned to each line's factory and compare to capacity
  const activeAllocRes = await supabase
    .from("production_allocations")
    .select("factory_id, allocated_qty")
    .in("status", ["confirmed", "in_progress"]);

  const loadByFactory = {};
  for (const a of activeAllocRes.data ?? []) {
    if (!loadByFactory[a.factory_id]) loadByFactory[a.factory_id] = 0;
    loadByFactory[a.factory_id] += Number(a.allocated_qty ?? 0);
  }

  for (const line of linesRes.data ?? []) {
    const capacity = Number(line.capacity ?? 0);
    if (capacity <= 0) continue;
    const factoryLoad = loadByFactory[line.factory_id] ?? 0;
    const utilizationPct = (factoryLoad / capacity) * 100;
    if (utilizationPct > 90) {
      exceptions.push({
        type: "overloaded",
        severity: utilizationPct > 100 ? "high" : "medium",
        order_id: null,
        factory_name: line.factories?.name ?? "Unknown",
        message: `Line "${line.name}" at ${Math.round(utilizationPct)}% capacity (${factoryLoad}/${capacity})`,
        line_id: line.id,
        factory_id: line.factory_id,
        utilization_pct: Math.round(utilizationPct),
      });
    }
  }

  // ── Unreported factories ─────────────────────────────────
  const reportedIds = new Set((reportsRes.data ?? []).map((r) => r.factory_id));
  for (const fac of factRes.data ?? []) {
    if (!reportedIds.has(fac.id)) {
      exceptions.push({
        type: "unreported",
        severity: "low",
        order_id: null,
        factory_name: fac.name,
        message: `Factory "${fac.name}" has not submitted a report for ${today}`,
        factory_id: fac.id,
      });
    }
  }

  // Sort by severity: high > medium > low
  const severityOrder = { high: 0, medium: 1, low: 2 };
  exceptions.sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3));

  res.json({ date: today, total: exceptions.length, exceptions });
}));

export default router;
