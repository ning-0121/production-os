import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

const router = Router();

// GET /api/command/overview — all-in-one command center dashboard data
router.get("/overview", asyncHandler(async (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

  // Run all queries in parallel
  const [allocRes, todayReportsRes, trendRes, factRes, corrRes] = await Promise.all([
    // Active allocations
    supabase
      .from("production_allocations")
      .select("id, order_id, status, planned_end_date")
      .in("status", ["confirmed", "in_progress"]),

    // Today's reports
    supabase
      .from("daily_production_reports")
      .select("actual_output, is_abnormal, factory_id")
      .eq("date", today),

    // Last 7 days reports for trend
    supabase
      .from("daily_production_reports")
      .select("date, actual_output")
      .gte("date", sevenDaysAgo)
      .order("date"),

    // Active factories
    supabase
      .from("factories")
      .select("id, name, status")
      .eq("status", "active"),

    // Corrections for on-time calculation
    supabase
      .from("order_corrections")
      .select("allocation_id, risk_status, deviation_pct, estimated_end_date, factory_id"),
  ]);

  const activeAllocs = allocRes.data ?? [];
  const todayReports = todayReportsRes.data ?? [];
  const trendReports = trendRes.data ?? [];
  const factories = factRes.data ?? [];
  const corrections = corrRes.data ?? [];

  // ── KPI ────────────────────────────────────────────────
  const today_output = todayReports.reduce((sum, r) => sum + Number(r.actual_output ?? 0), 0);
  const abnormal_count = todayReports.filter((r) => r.is_abnormal).length;
  const reportedFactoryIds = new Set(todayReports.map((r) => r.factory_id));

  // On-time percentage from corrections
  const onTrack = corrections.filter((c) => c.risk_status === "on_track").length;
  const on_time_pct = corrections.length > 0 ? Math.round((onTrack / corrections.length) * 100) : 100;

  // Total production lines
  const { count: totalLines } = await supabase
    .from("production_lines")
    .select("id", { count: "exact", head: true });

  const kpi = {
    active_orders: activeAllocs.length,
    today_output,
    on_time_pct,
    abnormal_count,
    total_lines: totalLines ?? 0,
    reported_factories: reportedFactoryIds.size,
  };

  // ── Top exceptions (top 5 most severe) ───────────────
  const topExceptions = [];

  // Delayed
  for (const alloc of activeAllocs) {
    if (alloc.planned_end_date && alloc.planned_end_date < today) {
      const daysLate = Math.ceil((new Date(today) - new Date(alloc.planned_end_date)) / 86400000);
      topExceptions.push({
        type: "delayed",
        severity: daysLate > 7 ? "high" : daysLate > 3 ? "medium" : "low",
        order_id: alloc.order_id,
        message: `Order ${alloc.order_id ?? alloc.id} is ${daysLate} day(s) overdue`,
      });
    }
  }

  // At-risk from corrections
  for (const corr of corrections) {
    if (corr.risk_status === "critical" || corr.risk_status === "falling_behind") {
      topExceptions.push({
        type: "at_risk",
        severity: corr.risk_status === "critical" ? "high" : "medium",
        order_id: corr.allocation_id,
        message: `Allocation ${corr.allocation_id} is ${corr.risk_status} (${corr.deviation_pct}% of plan)`,
      });
    }
  }

  // Sort and take top 5
  const severityOrder = { high: 0, medium: 1, low: 2 };
  topExceptions.sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3));
  const top_exceptions = topExceptions.slice(0, 5);

  // ── Factory report status ────────────────────────────
  const factory_report_status = factories.map((f) => ({
    factory_id: f.id,
    name: f.name,
    reported: reportedFactoryIds.has(f.id),
  }));

  // ── Recent trend (last 7 days daily output) ──────────
  const dailyTotals = {};
  for (const r of trendReports) {
    if (!dailyTotals[r.date]) dailyTotals[r.date] = 0;
    dailyTotals[r.date] += Number(r.actual_output ?? 0);
  }

  const recent_trend = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    recent_trend.push({ date: d, output: dailyTotals[d] ?? 0 });
  }

  res.json({ kpi, top_exceptions, factory_report_status, recent_trend });
}));

export default router;
