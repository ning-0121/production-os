import { Router } from "express";
import { supabase } from "../supabase.js";
import { checkRisk } from "../scheduler/risk.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

const router = Router();

// GET /api/risks — fetch current risk alerts with optional filters
router.get("/", asyncHandler(async (req, res) => {
  let query = supabase
    .from("risk_alerts")
    .select("*, production_allocations(order_id, allocated_qty, factory_id, factories(id, name))")
    .order("created_at", { ascending: false });

  if (req.query.level) {
    query = query.eq("risk_level", req.query.level);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
}));

// GET /api/risks/summary — aggregate counts by level
router.get("/summary", asyncHandler(async (_req, res) => {
  const { data, error } = await supabase
    .from("risk_alerts")
    .select("risk_level");

  if (error) return res.status(500).json({ error: error.message });

  const summary = { HIGH: 0, MEDIUM: 0, SAFE: 0, total: 0 };
  for (const row of data ?? []) {
    summary[row.risk_level] = (summary[row.risk_level] ?? 0) + 1;
    summary.total++;
  }
  res.json(summary);
}));

// POST /api/risks/scan — analyze all active allocations and upsert risk_alerts
router.post("/scan", asyncHandler(async (_req, res) => {
  // 1. Load all non-terminal allocations with factory info
  const [allocRes, capRes, perfRes] = await Promise.all([
    supabase
      .from("production_allocations")
      .select("id, order_id, allocated_qty, planned_start_date, planned_end_date, status, factory_id")
      .in("status", ["planned", "confirmed", "in_progress"]),
    supabase
      .from("factory_capabilities")
      .select("factory_id, product_type, daily_capacity"),
    supabase
      .from("factory_performance_logs")
      .select("factory_id, delay_days, actual_daily_output, notes")
      .order("actual_end_date", { ascending: false })
      .limit(500),
  ]);

  const allocations = allocRes.data ?? [];
  if (allocRes.error) return res.status(500).json({ error: allocRes.error.message });
  if (allocations.length === 0) {
    return res.json({ scanned: 0, alerts: [] });
  }

  // Build factory quality map from factories table (quality_score is on factories)
  // For now use a default since we loaded capabilities, not factories
  const qualityMap = {};

  // Build factory on-time rate map from performance logs
  const factoryPerf = {};
  for (const log of perfRes.data ?? []) {
    if (!factoryPerf[log.factory_id]) factoryPerf[log.factory_id] = { total: 0, onTime: 0 };
    factoryPerf[log.factory_id].total++;
    if ((log.delay_days ?? 0) <= 0) factoryPerf[log.factory_id].onTime++;
  }
  const onTimeMap = {};
  for (const [fid, p] of Object.entries(factoryPerf)) {
    onTimeMap[fid] = p.total > 0 ? Math.round((p.onTime / p.total) * 100) : null;
  }

  // Compute factory utilization
  const loadMap = {};
  for (const a of allocations) {
    loadMap[a.factory_id] = (loadMap[a.factory_id] ?? 0) + Number(a.allocated_qty ?? 0);
  }

  // 2. Run enhanced risk check for each allocation
  const alerts = [];
  const today = new Date();
  for (const alloc of allocations) {
    const endDate = new Date(alloc.planned_end_date);
    const daysUntilEnd = Math.floor((endDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

    const result = checkRisk(
      { due_date: endDate },
      { planned_end_date: endDate },
      {
        quality_score: qualityMap[alloc.factory_id] ?? null,
        on_time_rate: onTimeMap[alloc.factory_id] ?? null,
      },
    );

    alerts.push({
      allocation_id: alloc.id,
      risk_level: result.level,
      buffer_days: daysUntilEnd,
      message: result.message ?? null,
    });
  }

  // 3. Delete old alerts and insert fresh ones (full refresh)
  const allocationIds = allocations.map((a) => a.id);
  await supabase
    .from("risk_alerts")
    .delete()
    .in("allocation_id", allocationIds);

  const { data: inserted, error: insertErr } = await supabase
    .from("risk_alerts")
    .insert(alerts)
    .select();

  if (insertErr) return res.status(500).json({ error: insertErr.message });

  const summary = { HIGH: 0, MEDIUM: 0, SAFE: 0 };
  for (const a of alerts) {
    summary[a.risk_level]++;
  }

  res.json({
    scanned: allocations.length,
    summary,
    alerts: inserted,
  });
}));

export default router;
