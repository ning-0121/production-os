/**
 * Today Operations — action-first briefing endpoint.
 *
 * GET /api/today/briefing
 * Returns everything a production manager needs to know this morning.
 */

import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { runRiskPredictor } from "../agents/risk-predictor.js";
import { runAnomalyDetector } from "../agents/anomaly-detector.js";
import { auditLog } from "../governance/audit.js";

const router = Router();

router.get("/briefing", asyncHandler(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  const [allocRes, corrRes, factRes, linesRes, reportsRes, trendRes, schedRes, anomalyReportsRes, reviewsRes] = await Promise.all([
    supabase
      .from("production_allocations")
      .select("id, order_id, factory_id, product_type, allocated_qty, planned_end_date, status, factories(id, name)")
      .not("status", "eq", "completed")
      .not("status", "eq", "cancelled"),

    supabase
      .from("order_corrections")
      .select("allocation_id, order_id, factory_id, risk_status, deviation_pct, estimated_end_date"),

    supabase
      .from("factories")
      .select("id, name, status, quality_score, delay_score, cooperation_score")
      .eq("status", "active"),

    supabase
      .from("production_lines")
      .select("id, name, factory_id, front_capacity_per_day, back_capacity_per_day, status, factories(id, name)")
      .eq("status", "active"),

    supabase
      .from("daily_production_reports")
      .select("factory_id, actual_output, is_abnormal, abnormal_reason, date")
      .eq("date", today),

    supabase
      .from("daily_production_reports")
      .select("date, actual_output")
      .gte("date", sevenDaysAgo)
      .order("date"),

    supabase
      .from("line_schedules")
      .select("line_id, allocation_id"),

    // Wider window for anomaly detection — needs ≥5 daily samples per allocation
    supabase
      .from("daily_production_reports")
      .select("factory_id, allocation_id, order_id, actual_output, is_abnormal, abnormal_reason, date")
      .gte("date", thirtyDaysAgo),

    // Already-reviewed anomalies — suppress from the briefing
    supabase
      .from("anomaly_reviews")
      .select("anomaly_id"),
  ]);

  const allocations = allocRes.data ?? [];
  const corrections = corrRes.data ?? [];
  const factories = factRes.data ?? [];
  const lines = linesRes.data ?? [];
  const todayReports = reportsRes.data ?? [];
  const trendReports = trendRes.data ?? [];
  const schedules = schedRes.data ?? [];

  // ── KPI ────────────────────────────────────────────────
  const activeOrders = allocations.filter((a) => ["confirmed", "in_progress"].includes(a.status));
  const todayOutput = todayReports.reduce((sum, r) => sum + Number(r.actual_output ?? 0), 0);
  const abnormalCount = todayReports.filter((r) => r.is_abnormal).length;
  const onTrack = corrections.filter((c) => c.risk_status === "on_track").length;
  const onTimePct = corrections.length > 0 ? Math.round((onTrack / corrections.length) * 100) : 100;

  // ── Risky orders ──────────────────────────────────────
  const risky_orders = [];
  for (const alloc of allocations) {
    const dueDate = (alloc.planned_end_date ?? "").slice(0, 10);
    if (!dueDate) continue;
    const daysLeft = Math.ceil((new Date(dueDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    if (daysLeft <= 7) {
      risky_orders.push({
        allocation_id: alloc.id,
        order_id: alloc.order_id,
        factory_name: alloc.factories?.name ?? "未知",
        product_type: alloc.product_type,
        qty: alloc.allocated_qty,
        due_date: dueDate,
        days_left: daysLeft,
        status: alloc.status,
        risk: daysLeft < 0 ? "overdue" : daysLeft <= 3 ? "critical" : "warning",
      });
    }
  }
  risky_orders.sort((a, b) => a.days_left - b.days_left);

  // ── Risky factories ───────────────────────────────────
  const risky_factories = factories
    .filter((f) => (f.delay_score ?? 100) < 70 || (f.quality_score ?? 100) < 70)
    .map((f) => ({
      factory_id: f.id,
      name: f.name,
      delay_score: f.delay_score,
      quality_score: f.quality_score,
      active_orders: allocations.filter((a) => a.factory_id === f.id && ["confirmed", "in_progress"].includes(a.status)).length,
    }));

  // ── Available capacity ────────────────────────────────
  const scheduledAllocIds = new Set(schedules.map((s) => s.allocation_id));
  const lineLoadMap = new Map();
  for (const s of schedules) {
    lineLoadMap.set(s.line_id, (lineLoadMap.get(s.line_id) ?? 0) + 1);
  }

  const available_lines = lines.map((l) => {
    const schedCount = lineLoadMap.get(l.id) ?? 0;
    return {
      line_id: l.id,
      name: l.name,
      factory_name: l.factories?.name ?? "未知",
      factory_id: l.factory_id,
      scheduled_orders: Math.floor(schedCount / 2),
      front_capacity: l.front_capacity_per_day,
      back_capacity: l.back_capacity_per_day,
      load_level: schedCount > 10 ? "high" : schedCount > 4 ? "medium" : "low",
    };
  });

  // ── Missing reports ───────────────────────────────────
  const reportedFactoryIds = new Set(todayReports.map((r) => r.factory_id));
  const missing_reports = factories
    .filter((f) => !reportedFactoryIds.has(f.id))
    .map((f) => ({ factory_id: f.id, name: f.name }));

  // ── Unscheduled orders ────────────────────────────────
  const unscheduled_orders = allocations
    .filter((a) => a.status === "planned" && !scheduledAllocIds.has(a.id))
    .map((a) => ({
      allocation_id: a.id,
      order_id: a.order_id,
      product_type: a.product_type,
      qty: a.allocated_qty,
      due_date: (a.planned_end_date ?? "").slice(0, 10),
      factory_name: a.factories?.name ?? "未分配",
    }));

  // ── 7-day trend ───────────────────────────────────────
  const dailyTotals = {};
  for (const r of trendReports) {
    if (!dailyTotals[r.date]) dailyTotals[r.date] = 0;
    dailyTotals[r.date] += Number(r.actual_output ?? 0);
  }
  const trend = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    trend.push({ date: d, output: dailyTotals[d] ?? 0 });
  }

  // ── Anomaly detection ─────────────────────────────────
  const reviewedIds = new Set((reviewsRes.data ?? []).map((r) => r.anomaly_id));
  const anomalyReports = anomalyReportsRes.data ?? [];
  const anomalyResult = runAnomalyDetector({ reports: anomalyReports });
  const anomalies = anomalyResult.anomalies.filter((a) => !reviewedIds.has(a.id));
  const anomalyActions = anomalyResult.actions.filter((a) => !reviewedIds.has(a.params?.anomaly_id));

  // Enrich anomalies with order/factory display names for the UI
  const factoryNameById = new Map(factories.map((f) => [f.id, f.name]));
  const allocById = new Map(allocations.map((a) => [a.id, a]));
  const anomaly_alerts = anomalies.map((a) => {
    const alloc = a.allocation_id ? allocById.get(a.allocation_id) : null;
    const matchedAction = anomalyActions.find((act) => act.params?.anomaly_id === a.id);
    return {
      ...a,
      order_id: a.order_id ?? alloc?.order_id ?? null,
      factory_name: factoryNameById.get(a.factory_id) ?? alloc?.factories?.name ?? null,
      product_type: alloc?.product_type ?? null,
      // Resolved suggested action for the UI ("watchlist_and_recalc" etc.)
      suggested_action: a.routing?.suggested_action ?? null,
      action_summary: matchedAction?.summary ?? null,
      action_impact: matchedAction?.impact ?? null,
    };
  });

  // Audit the detector run so we can track frequency + result over time
  auditLog({
    action: "anomaly.detect",
    category: "system",
    result_status: "success",
    req,
    detail: {
      reports_scanned: anomalyResult.stats.reports_scanned,
      groups_with_stats: anomalyResult.stats.groups_with_stats,
      anomalies_found: anomalyResult.anomalies.length,
      after_review_filter: anomaly_alerts.length,
      suppressed_by_review: anomalyResult.anomalies.length - anomaly_alerts.length,
      by_type: anomaly_alerts.reduce((acc, a) => { acc[a.type] = (acc[a.type] ?? 0) + 1; return acc; }, {}),
    },
  });

  // ── AI suggestions ────────────────────────────────────
  const agentResult = runRiskPredictor({ allocations, corrections, lines, factories });

  res.json({
    timestamp: new Date().toISOString(),
    kpi: {
      active_orders: activeOrders.length,
      today_output: todayOutput,
      on_time_pct: onTimePct,
      abnormal_count: abnormalCount,
      total_lines: lines.length,
      reported_factories: reportedFactoryIds.size,
      total_factories: factories.length,
      unscheduled_count: unscheduled_orders.length,
    },
    risky_orders,
    risky_factories,
    available_lines,
    missing_reports,
    unscheduled_orders,
    trend,
    ai_suggestions: agentResult.actions.slice(0, 10),
    anomaly_alerts,
    anomaly_stats: {
      ...anomalyResult.stats,
      after_review_filter: anomaly_alerts.length,
      suppressed_by_review: anomalyResult.anomalies.length - anomaly_alerts.length,
    },
    _agent_reasoning: agentResult.reasoning,
  });
}));

export default router;
