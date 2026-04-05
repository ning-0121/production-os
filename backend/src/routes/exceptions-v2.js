/**
 * Exceptions V2 — Stable contract for AI production operations.
 *
 * Returns categorized exceptions:
 *   order_exceptions, factory_exceptions, resource_exceptions, incident_exceptions, ai_actions
 */

import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { runRiskPredictor } from "../agents/risk-predictor.js";

const router = Router();

// GET /api/exceptions/v2
router.get("/", asyncHandler(async (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  // Run all queries in parallel
  const [allocRes, corrRes, linesRes, factRes, reportsRes, schedRes] = await Promise.all([
    supabase
      .from("production_allocations")
      .select("id, order_id, factory_id, product_type, allocated_qty, planned_end_date, status, factories(id, name)")
      .not("status", "eq", "completed")
      .not("status", "eq", "cancelled"),

    supabase
      .from("order_corrections")
      .select("allocation_id, order_id, factory_id, risk_status, deviation_pct, estimated_end_date"),

    supabase
      .from("production_lines")
      .select("id, name, factory_id, front_capacity_per_day, back_capacity_per_day, status, factories(id, name)"),

    supabase
      .from("factories")
      .select("id, name, status, quality_score, delay_score, cooperation_score")
      .eq("status", "active"),

    supabase
      .from("daily_production_reports")
      .select("factory_id, is_abnormal, abnormal_reason, actual_output, order_id, date")
      .eq("date", today),

    supabase
      .from("line_schedules")
      .select("line_id, allocation_id, process, start_date, end_date"),
  ]);

  const allocations = allocRes.data ?? [];
  const corrections = corrRes.data ?? [];
  const lines = linesRes.data ?? [];
  const factories = factRes.data ?? [];
  const todayReports = reportsRes.data ?? [];
  const schedules = schedRes.data ?? [];

  // ── Order Exceptions ──────────────────────────────────
  const order_exceptions = [];

  for (const alloc of allocations) {
    const dueDate = (alloc.planned_end_date ?? "").slice(0, 10);
    if (!dueDate) continue;

    const daysLeft = Math.ceil((new Date(dueDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    const factoryName = alloc.factories?.name ?? "未知";

    if (daysLeft < 0) {
      order_exceptions.push({
        type: "delayed",
        severity: Math.abs(daysLeft) > 7 ? "high" : Math.abs(daysLeft) > 3 ? "medium" : "low",
        order_id: alloc.order_id,
        allocation_id: alloc.id,
        factory_id: alloc.factory_id,
        factory_name: factoryName,
        message: `订单 ${alloc.order_id ?? alloc.id.slice(0, 8)} 已延期 ${Math.abs(daysLeft)} 天`,
        data: { days_overdue: Math.abs(daysLeft), due_date: dueDate, qty: alloc.allocated_qty },
      });
    } else if (daysLeft <= 3) {
      order_exceptions.push({
        type: "at_risk",
        severity: "high",
        order_id: alloc.order_id,
        allocation_id: alloc.id,
        factory_id: alloc.factory_id,
        factory_name: factoryName,
        message: `订单 ${alloc.order_id ?? alloc.id.slice(0, 8)} 距交期仅 ${daysLeft} 天`,
        data: { days_left: daysLeft, due_date: dueDate, qty: alloc.allocated_qty },
      });
    }
  }

  // At-risk from corrections
  for (const corr of corrections) {
    if (corr.risk_status === "critical" || corr.risk_status === "falling_behind") {
      order_exceptions.push({
        type: "at_risk",
        severity: corr.risk_status === "critical" ? "high" : "medium",
        order_id: corr.order_id,
        allocation_id: corr.allocation_id,
        factory_id: corr.factory_id,
        factory_name: null,
        message: `订单 ${corr.order_id ?? corr.allocation_id?.slice(0, 8)} 进度偏差 ${corr.deviation_pct}%`,
        data: { deviation_pct: corr.deviation_pct, estimated_end: corr.estimated_end_date, risk_status: corr.risk_status },
      });
    }
  }

  // Unscheduled planned orders
  const scheduledAllocIds = new Set(schedules.map((s) => s.allocation_id));
  for (const alloc of allocations) {
    if (alloc.status === "planned" && !scheduledAllocIds.has(alloc.id)) {
      order_exceptions.push({
        type: "unscheduled",
        severity: "low",
        order_id: alloc.order_id,
        allocation_id: alloc.id,
        factory_name: alloc.factories?.name ?? "未知",
        message: `订单 ${alloc.order_id ?? alloc.id.slice(0, 8)} 尚未排产`,
        data: { qty: alloc.allocated_qty, product_type: alloc.product_type },
      });
    }
  }

  // ── Factory Exceptions ────────────────────────────────
  const factory_exceptions = [];

  // Unreported factories
  const reportedFactoryIds = new Set(todayReports.map((r) => r.factory_id));
  for (const fac of factories) {
    if (!reportedFactoryIds.has(fac.id)) {
      factory_exceptions.push({
        type: "unreported",
        severity: "medium",
        factory_id: fac.id,
        factory_name: fac.name,
        message: `${fac.name} 今日未提交日报`,
      });
    }
  }

  // Underperforming factories
  for (const fac of factories) {
    if ((fac.delay_score ?? 100) < 60) {
      factory_exceptions.push({
        type: "underperforming",
        severity: "high",
        factory_id: fac.id,
        factory_name: fac.name,
        message: `${fac.name} 延期评分 ${fac.delay_score}，持续表现不佳`,
        data: { delay_score: fac.delay_score, quality_score: fac.quality_score },
      });
    }
  }

  // ── Resource Exceptions ───────────────────────────────
  const resource_exceptions = [];

  // Overloaded lines: count active schedules per line
  const lineLoadMap = new Map();
  for (const s of schedules) {
    if (!lineLoadMap.has(s.line_id)) lineLoadMap.set(s.line_id, 0);
    lineLoadMap.set(s.line_id, lineLoadMap.get(s.line_id) + 1);
  }

  for (const line of lines) {
    const schedCount = lineLoadMap.get(line.id) ?? 0;
    if (schedCount > 6) {
      resource_exceptions.push({
        type: "overloaded",
        severity: schedCount > 10 ? "high" : "medium",
        line_id: line.id,
        line_name: line.name,
        factory_id: line.factory_id,
        factory_name: line.factories?.name ?? "未知",
        message: `产线 ${line.name} 当前排产 ${schedCount / 2} 个订单，负荷较高`,
        data: { schedule_count: schedCount, capacity_front: line.front_capacity_per_day, capacity_back: line.back_capacity_per_day },
      });
    }
  }

  // ── Incident Exceptions ───────────────────────────────
  const incident_exceptions = [];

  // Abnormal reports from today
  const abnormals = todayReports.filter((r) => r.is_abnormal);
  for (const report of abnormals) {
    incident_exceptions.push({
      type: "abnormal_report",
      severity: "high",
      factory_id: report.factory_id,
      order_id: report.order_id,
      message: `异常日报: ${report.abnormal_reason ?? "原因未填写"}`,
      data: { actual_output: report.actual_output, date: report.date },
    });
  }

  // ── AI Actions (from risk predictor agent) ────────────
  const agentResult = runRiskPredictor({
    allocations, corrections, lines, factories,
  });

  // Sort all exception arrays by severity
  const sevOrder = { high: 0, medium: 1, low: 2 };
  const sortBySev = (arr) => arr.sort((a, b) => (sevOrder[a.severity] ?? 3) - (sevOrder[b.severity] ?? 3));

  sortBySev(order_exceptions);
  sortBySev(factory_exceptions);
  sortBySev(resource_exceptions);
  sortBySev(incident_exceptions);

  res.json({
    timestamp: new Date().toISOString(),
    order_exceptions,
    factory_exceptions,
    resource_exceptions,
    incident_exceptions,
    ai_actions: agentResult.actions,
    _agent_reasoning: agentResult.reasoning,
  });
}));

export default router;
