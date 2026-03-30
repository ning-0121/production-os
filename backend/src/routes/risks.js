import { Router } from "express";
import { supabase } from "../supabase.js";
import { checkRisk } from "../scheduler/risk.js";

const router = Router();

// GET /api/risks — fetch current risk alerts with optional filters
router.get("/", async (req, res) => {
  let query = supabase
    .from("risk_alerts")
    .select("*, production_allocations(product_type, quantity, factory_id, factories(id, name, code))")
    .order("created_at", { ascending: false });

  if (req.query.level) {
    query = query.eq("risk_level", req.query.level);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/risks/summary — aggregate counts by level
router.get("/summary", async (_req, res) => {
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
});

// POST /api/risks/scan — analyze all active allocations and upsert risk_alerts
router.post("/scan", async (_req, res) => {
  // 1. Load all non-terminal allocations
  const { data: allocations, error: allocErr } = await supabase
    .from("production_allocations")
    .select("id, product_type, quantity, start_at, end_at, status, factory_id")
    .in("status", ["planned", "confirmed", "in_progress"]);

  if (allocErr) return res.status(500).json({ error: allocErr.message });
  if (!allocations || allocations.length === 0) {
    return res.json({ scanned: 0, alerts: [] });
  }

  // 2. Run risk check for each allocation
  const alerts = [];
  for (const alloc of allocations) {
    // Use end_at as both due_date and planned_end_date
    // (end_at is the scheduled completion; it doubles as the delivery target)
    const result = checkRisk(
      { due_date: alloc.end_at },
      { planned_end_date: alloc.end_at },
    );

    // For allocations that have a real due date stored in end_at,
    // the risk is computed against today → end_at gap.
    // More useful: compare against *today* to see how much buffer is left.
    const today = new Date();
    const endDate = new Date(alloc.end_at);
    const daysUntilEnd = Math.floor((endDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

    let level = "SAFE";
    let message = null;
    if (daysUntilEnd < 0) {
      level = "HIGH";
      message = `已超出交期 ${Math.abs(daysUntilEnd)} 天，需立即处理`;
    } else if (daysUntilEnd < 2) {
      level = "HIGH";
      message = `交期紧迫，仅剩 ${daysUntilEnd} 天缓冲`;
    } else if (daysUntilEnd < 5) {
      level = "MEDIUM";
      message = `交期风险，剩余 ${daysUntilEnd} 天，建议提前沟通`;
    }

    alerts.push({
      allocation_id: alloc.id,
      risk_level: level,
      buffer_days: daysUntilEnd,
      message,
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
});

export default router;
