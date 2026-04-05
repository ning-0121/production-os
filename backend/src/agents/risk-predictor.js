/**
 * Risk Prediction Agent
 *
 * Analyzes all active orders and factories to predict risks
 * before they become incidents. Generates actionable AIActions.
 *
 * Uses existing: risk.js, correction.js, scoring.js
 */

import { createAction } from "./types.js";

/**
 * Run risk prediction across all active allocations.
 * @param {object} context - { allocations, corrections, lines, schedules, factories }
 * @returns {{ actions: AIAction[], reasoning: string }}
 */
export function runRiskPredictor(context) {
  const { allocations = [], corrections = [], lines = [], factories = [] } = context;
  const actions = [];
  const today = new Date().toISOString().slice(0, 10);

  // Build factory lookup
  const factoryMap = new Map();
  for (const f of factories) factoryMap.set(f.id, f);

  // ── 1. Delivery risk: orders approaching or past due date ──
  for (const alloc of allocations) {
    if (alloc.status === "completed" || alloc.status === "cancelled") continue;

    const dueDate = (alloc.planned_end_date ?? alloc.end_at ?? "").slice(0, 10);
    if (!dueDate) continue;

    const daysLeft = Math.ceil((new Date(dueDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    const factory = factoryMap.get(alloc.factory_id);
    const factoryName = factory?.name ?? "未知工厂";

    if (daysLeft < 0) {
      // Already overdue
      actions.push(createAction({
        agent: "risk-predictor",
        action_type: "escalate",
        target_type: "order",
        target_id: alloc.id,
        summary: `订单 ${alloc.order_id ?? alloc.id.slice(0, 8)} 已逾期 ${Math.abs(daysLeft)} 天，需立即处理`,
        urgency: "critical",
        impact: `继续延误将影响客户关系，可能产生违约金`,
        confidence: 0.95,
        params: { order_id: alloc.order_id, days_overdue: Math.abs(daysLeft), factory_name: factoryName },
      }));
    } else if (daysLeft <= 3) {
      // At immediate risk
      actions.push(createAction({
        agent: "risk-predictor",
        action_type: "add_overtime",
        target_type: "order",
        target_id: alloc.id,
        summary: `订单 ${alloc.order_id ?? alloc.id.slice(0, 8)} 距交期仅 ${daysLeft} 天，建议加班赶工`,
        urgency: "high",
        impact: `不加班可能延期 ${3 - daysLeft} 天以上`,
        confidence: 0.85,
        params: { order_id: alloc.order_id, days_left: daysLeft, factory_id: alloc.factory_id },
      }));
    } else if (daysLeft <= 7) {
      actions.push(createAction({
        agent: "risk-predictor",
        action_type: "alert",
        target_type: "order",
        target_id: alloc.id,
        summary: `订单 ${alloc.order_id ?? alloc.id.slice(0, 8)} 距交期 ${daysLeft} 天，需密切关注进度`,
        urgency: "medium",
        impact: `如出现异常将无缓冲时间应对`,
        confidence: 0.7,
        params: { order_id: alloc.order_id, days_left: daysLeft },
      }));
    }
  }

  // ── 2. Deviation risk: orders falling behind from corrections ──
  for (const corr of corrections) {
    if (corr.risk_status === "critical") {
      actions.push(createAction({
        agent: "risk-predictor",
        action_type: "reschedule",
        target_type: "order",
        target_id: corr.allocation_id,
        summary: `订单 ${corr.order_id ?? corr.allocation_id.slice(0, 8)} 进度严重偏离 (${corr.deviation_pct}%)，建议重新排产`,
        urgency: "critical",
        impact: `按当前速度预计延期至 ${corr.estimated_end_date}`,
        confidence: 0.9,
        params: { allocation_id: corr.allocation_id, deviation_pct: corr.deviation_pct, estimated_end: corr.estimated_end_date },
      }));
    } else if (corr.risk_status === "falling_behind") {
      actions.push(createAction({
        agent: "risk-predictor",
        action_type: "alert",
        target_type: "order",
        target_id: corr.allocation_id,
        summary: `订单 ${corr.order_id ?? corr.allocation_id.slice(0, 8)} 进度落后 ${Math.abs(corr.deviation_pct)}%，需跟进`,
        urgency: "high",
        impact: `持续偏差将导致延期`,
        confidence: 0.8,
        params: { allocation_id: corr.allocation_id, deviation_pct: corr.deviation_pct },
      }));
    }
  }

  // ── 3. Factory risk: low-performing factories with active orders ──
  for (const factory of factories) {
    const delayScore = factory.delay_score ?? 100;
    const qualityScore = factory.quality_score ?? 100;
    const activeOrders = allocations.filter(
      (a) => a.factory_id === factory.id && ["confirmed", "in_progress"].includes(a.status),
    );

    if (activeOrders.length > 0 && delayScore < 60) {
      actions.push(createAction({
        agent: "risk-predictor",
        action_type: "reassign",
        target_type: "factory",
        target_id: factory.id,
        summary: `${factory.name} 延期评分仅 ${delayScore}，有 ${activeOrders.length} 个在产订单，建议转移部分订单`,
        urgency: "high",
        impact: `该工厂历史延期率高，${activeOrders.length} 个订单均有延期风险`,
        confidence: 0.75,
        params: { factory_name: factory.name, delay_score: delayScore, active_count: activeOrders.length },
      }));
    }

    if (activeOrders.length > 0 && qualityScore < 60) {
      actions.push(createAction({
        agent: "risk-predictor",
        action_type: "alert",
        target_type: "factory",
        target_id: factory.id,
        summary: `${factory.name} 质量评分仅 ${qualityScore}，建议加强巡检`,
        urgency: "medium",
        impact: `质量问题可能导致返工，进一步延期`,
        confidence: 0.7,
        params: { factory_name: factory.name, quality_score: qualityScore },
      }));
    }
  }

  // Sort by urgency
  const urgencyOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  actions.sort((a, b) => (urgencyOrder[a.urgency] ?? 4) - (urgencyOrder[b.urgency] ?? 4));

  return {
    actions,
    reasoning: `分析了 ${allocations.length} 个订单、${corrections.length} 条偏差记录、${factories.length} 个工厂，生成 ${actions.length} 条建议`,
  };
}
