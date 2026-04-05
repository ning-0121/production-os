/**
 * Progress Correction Agent
 *
 * Analyzes daily report data to detect deviations from plan,
 * generates corrective actions and schedule adjustments.
 *
 * Uses existing: correction.js
 */

import { createAction } from "./types.js";

/**
 * Run progress correction analysis.
 * @param {object} context - { reports, allocations, corrections }
 * @returns {{ actions: AIAction[], reasoning: string, stats: object }}
 */
export function runCorrector(context) {
  const { reports = [], allocations = [], corrections = [] } = context;
  const actions = [];
  const today = new Date().toISOString().slice(0, 10);

  // Build allocation lookup
  const allocMap = new Map();
  for (const a of allocations) allocMap.set(a.id, a);

  // Analyze corrections for active orders
  let onTrack = 0;
  let fallingBehind = 0;
  let critical = 0;

  for (const corr of corrections) {
    const alloc = allocMap.get(corr.allocation_id);
    if (!alloc || alloc.status === "completed" || alloc.status === "cancelled") continue;

    if (corr.risk_status === "on_track") {
      onTrack++;
    } else if (corr.risk_status === "falling_behind") {
      fallingBehind++;
      actions.push(createAction({
        agent: "corrector",
        action_type: "adjust_plan",
        target_type: "order",
        target_id: corr.allocation_id,
        summary: `订单 ${corr.order_id ?? corr.allocation_id.slice(0, 8)} 进度落后 ${Math.abs(corr.deviation_pct)}%，建议调整排期或加班`,
        urgency: "high",
        impact: `按当前进度预计完成日期延至 ${corr.estimated_end_date}`,
        confidence: 0.82,
        params: {
          allocation_id: corr.allocation_id,
          deviation_pct: corr.deviation_pct,
          estimated_end: corr.estimated_end_date,
          current_daily_rate: corr.actual_cumulative > 0
            ? Math.round(corr.actual_cumulative / Math.max(1, daysBetween(alloc.planned_start_date, today)))
            : 0,
        },
      }));
    } else if (corr.risk_status === "critical") {
      critical++;
      actions.push(createAction({
        agent: "corrector",
        action_type: "reschedule",
        target_type: "order",
        target_id: corr.allocation_id,
        summary: `订单 ${corr.order_id ?? corr.allocation_id.slice(0, 8)} 严重偏离计划 (${corr.deviation_pct}%)，需立即介入`,
        urgency: "critical",
        impact: `延期风险极高，建议拆单或转厂处理`,
        confidence: 0.9,
        params: {
          allocation_id: corr.allocation_id,
          deviation_pct: corr.deviation_pct,
          estimated_end: corr.estimated_end_date,
        },
      }));
    }
  }

  // Check for orders with no reports at all
  const reportedAllocIds = new Set(reports.map((r) => r.allocation_id).filter(Boolean));
  for (const alloc of allocations) {
    if (alloc.status === "in_progress" && !reportedAllocIds.has(alloc.id)) {
      actions.push(createAction({
        agent: "corrector",
        action_type: "alert",
        target_type: "order",
        target_id: alloc.id,
        summary: `订单 ${alloc.order_id ?? alloc.id.slice(0, 8)} 处于生产中但无日报数据`,
        urgency: "medium",
        impact: `无法评估进度偏差，存在隐性延期风险`,
        confidence: 0.6,
        params: { allocation_id: alloc.id, order_id: alloc.order_id },
      }));
    }
  }

  // Abnormal report analysis
  const todayAbnormals = reports.filter((r) => r.is_abnormal && r.date === today);
  for (const report of todayAbnormals) {
    actions.push(createAction({
      agent: "corrector",
      action_type: "investigate",
      target_type: "order",
      target_id: report.allocation_id ?? report.order_id ?? "unknown",
      summary: `今日异常日报：${report.abnormal_reason ?? "原因未填写"}（产出 ${report.actual_output}）`,
      urgency: "high",
      impact: `异常可能导致后续排产计划连锁延期`,
      confidence: 0.75,
      params: {
        factory_id: report.factory_id,
        actual_output: report.actual_output,
        abnormal_reason: report.abnormal_reason,
      },
    }));
  }

  // Sort by urgency
  const urgencyOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  actions.sort((a, b) => (urgencyOrder[a.urgency] ?? 4) - (urgencyOrder[b.urgency] ?? 4));

  return {
    actions,
    reasoning: `分析了 ${corrections.length} 条偏差记录、${reports.length} 条日报，生成 ${actions.length} 条校正建议`,
    stats: { on_track: onTrack, falling_behind: fallingBehind, critical, total: corrections.length },
  };
}

function daysBetween(dateA, dateB) {
  if (!dateA || !dateB) return 1;
  const a = new Date(dateA).getTime();
  const b = new Date(dateB).getTime();
  return Math.max(1, Math.ceil(Math.abs(b - a) / (1000 * 60 * 60 * 24)));
}
