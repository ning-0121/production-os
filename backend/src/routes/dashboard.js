import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

const router = Router();

// GET /api/dashboard/stats — aggregated dashboard statistics
router.get("/stats", asyncHandler(async (_req, res) => {
  // Run all queries in parallel
  const [allocRes, riskRes, perfRes, factRes] = await Promise.all([
    supabase.from("production_allocations")
      .select("id, status, quantity, start_at, end_at, factory_id, product_type, created_at"),
    supabase.from("risk_alerts")
      .select("risk_level"),
    supabase.from("factory_performance_logs")
      .select("metric_type, metric_value, occurred_at, factory_id, context")
      .eq("metric_type", "order_completion")
      .order("occurred_at", { ascending: false })
      .limit(200),
    supabase.from("factories")
      .select("id, name, factory_capabilities(base_capacity_units_per_day, minutes_per_unit)")
      .eq("status", "active"),
  ]);

  const allocs = allocRes.data ?? [];
  const risks = riskRes.data ?? [];
  const perfLogs = perfRes.data ?? [];
  const factories = factRes.data ?? [];

  // ── Order status distribution ─────────────────────────
  const statusCounts = { planned: 0, confirmed: 0, in_progress: 0, completed: 0, cancelled: 0 };
  let totalQty = 0;
  for (const a of allocs) {
    statusCounts[a.status] = (statusCounts[a.status] ?? 0) + 1;
    totalQty += Number(a.quantity ?? 0);
  }

  // ── Risk distribution ─────────────────────────────────
  const riskCounts = { HIGH: 0, MEDIUM: 0, SAFE: 0 };
  for (const r of risks) {
    riskCounts[r.risk_level] = (riskCounts[r.risk_level] ?? 0) + 1;
  }

  // ── On-time delivery rate ─────────────────────────────
  let onTimeCount = 0;
  let completedCount = 0;
  for (const log of perfLogs) {
    completedCount++;
    if (log.context?.on_time) onTimeCount++;
  }
  const onTimeRate = completedCount > 0 ? Math.round((onTimeCount / completedCount) * 100) : 0;

  // ── Average delay ─────────────────────────────────────
  let totalDelay = 0;
  let delayCount = 0;
  for (const log of perfLogs) {
    if (log.context?.delay_days != null) {
      totalDelay += Number(log.context.delay_days);
      delayCount++;
    }
  }
  const avgDelay = delayCount > 0 ? Math.round((totalDelay / delayCount) * 10) / 10 : 0;

  // ── Factory utilization ───────────────────────────────
  const activeAllocs = allocs.filter((a) => ["confirmed", "in_progress"].includes(a.status));
  const factoryLoad = {};
  for (const a of activeAllocs) {
    if (!factoryLoad[a.factory_id]) factoryLoad[a.factory_id] = 0;
    factoryLoad[a.factory_id] += Number(a.quantity ?? 0);
  }

  const factoryUtilization = factories.map((f) => {
    const caps = f.factory_capabilities ?? [];
    const dailyCap = caps.reduce((sum, c) => sum + Number(c.base_capacity_units_per_day ?? 0), 0);
    const load = factoryLoad[f.id] ?? 0;
    const utilPct = dailyCap > 0 ? Math.min(100, Math.round((load / (dailyCap * 30)) * 100)) : 0;
    return { factory_id: f.id, name: f.name, daily_capacity: dailyCap, current_load: load, utilization_pct: utilPct };
  });

  // ── Daily completion trend (last 30 days) ─────────────
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
  const dailyCompletions = {};
  for (const log of perfLogs) {
    const d = new Date(log.occurred_at);
    if (d >= thirtyDaysAgo) {
      const key = d.toISOString().slice(0, 10);
      dailyCompletions[key] = (dailyCompletions[key] ?? 0) + 1;
    }
  }

  // Fill in missing days
  const trend = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    trend.push({ date: key, count: dailyCompletions[key] ?? 0 });
  }

  // ── Product type breakdown ────────────────────────────
  const productCounts = {};
  for (const a of allocs) {
    productCounts[a.product_type] = (productCounts[a.product_type] ?? 0) + Number(a.quantity ?? 0);
  }

  res.json({
    kpi: {
      total_orders: allocs.length,
      total_quantity: totalQty,
      in_production: statusCounts.in_progress,
      completed: statusCounts.completed,
      completion_rate: allocs.length > 0 ? Math.round((statusCounts.completed / allocs.length) * 100) : 0,
      on_time_rate: onTimeRate,
      avg_delay_days: avgDelay,
    },
    status_distribution: statusCounts,
    risk_distribution: riskCounts,
    factory_utilization: factoryUtilization,
    completion_trend: trend,
    product_breakdown: Object.entries(productCounts)
      .map(([type, qty]) => ({ product_type: type, quantity: qty }))
      .sort((a, b) => Number(b.quantity) - Number(a.quantity)),
  });
}));

// GET /api/dashboard/accuracy — planned vs actual comparison
router.get("/accuracy", asyncHandler(async (_req, res) => {
  // Get completed allocations with performance logs
  const { data: completedAllocs } = await supabase
    .from("production_allocations")
    .select("id, factory_id, product_type, quantity, start_at, end_at, status, factories(id, name)")
    .eq("status", "completed")
    .order("end_at", { ascending: false })
    .limit(100);

  const { data: perfLogs } = await supabase
    .from("factory_performance_logs")
    .select("factory_id, metric_type, metric_value, context, occurred_at")
    .in("metric_type", ["order_completion", "delay_days", "efficiency_rate"])
    .order("occurred_at", { ascending: false })
    .limit(500);

  // Group perf logs by factory
  const factoryStats = {};
  for (const log of perfLogs ?? []) {
    if (!factoryStats[log.factory_id]) {
      factoryStats[log.factory_id] = {
        completions: 0,
        total_output: 0,
        total_delay: 0,
        total_efficiency: 0,
        on_time: 0,
      };
    }
    const s = factoryStats[log.factory_id];
    if (log.metric_type === "order_completion") {
      s.completions++;
      s.total_output += Number(log.metric_value ?? 0);
      if (log.context?.on_time) s.on_time++;
    }
    if (log.metric_type === "delay_days") {
      s.total_delay += Number(log.metric_value ?? 0);
    }
    if (log.metric_type === "efficiency_rate") {
      s.total_efficiency += Number(log.metric_value ?? 0);
    }
  }

  // Build accuracy rows per factory
  const rows = Object.entries(factoryStats).map(([factoryId, stats]) => {
    const s = stats;
    const n = s.completions || 1;
    const factory = (completedAllocs ?? []).find((a) => a.factory_id === factoryId);
    return {
      factory_id: factoryId,
      factory_name: factory?.factories?.name ?? "Unknown",
      completions: s.completions,
      avg_daily_output: Math.round((s.total_output / n) * 10) / 10,
      avg_delay_days: Math.round((s.total_delay / n) * 10) / 10,
      avg_efficiency: Math.round((s.total_efficiency / n) * 100),
      on_time_rate: Math.round((s.on_time / n) * 100),
    };
  });

  res.json({ factories: rows, total_completed: (completedAllocs ?? []).length });
}));

export default router;
