/**
 * Scenario Generator — 为高风险订单生成多个排产方案
 *
 * 策略：用不同的权重组合跑推荐引擎，输出 3-4 个方案供人选择。
 *
 * 复用：recommend.js (工厂推荐), risk.js (风险评估), scoring.js (评分)
 */

import { recommendFactories } from "./recommend.js";
import { checkRisk } from "./risk.js";

/** 权重组合定义 */
const WEIGHT_PROFILES = [
  {
    type: "balanced",
    label: "均衡方案",
    weights: { feasibility: 0.30, utilization: 0.35, quality: 0.20, cost: 0.15 },
    bufferDays: 0,
    description: "综合考虑交期、产能、质量和成本",
  },
  {
    type: "speed",
    label: "最快交付",
    weights: { feasibility: 0.50, utilization: 0.20, quality: 0.15, cost: 0.15 },
    bufferDays: 0,
    description: "优先保证交期，可能增加成本",
  },
  {
    type: "cost",
    label: "最低成本",
    weights: { feasibility: 0.25, utilization: 0.30, quality: 0.15, cost: 0.30 },
    bufferDays: 0,
    description: "优先控制成本，可能牺牲交期",
  },
  {
    type: "quality",
    label: "最稳妥",
    weights: { feasibility: 0.25, utilization: 0.25, quality: 0.35, cost: 0.15 },
    bufferDays: 2,
    description: "优先选择高质量工厂，增加缓冲时间",
  },
];

/**
 * 为一个订单生成多个排产方案
 *
 * @param {Object} order - { product_type, quantity, due_date, order_id }
 * @param {Array} factories - 工厂列表（含 capabilities, load）
 * @param {Array} existingAllocations - 现有排产（用于影响分析）
 * @returns {Array<Scenario>}
 */
export function generateScenarios(order, factories, existingAllocations = []) {
  const scenarios = [];

  for (const profile of WEIGHT_PROFILES) {
    // 用该权重组合跑推荐引擎
    const recs = recommendFactories(order, factories, { weights: profile.weights });

    // 取最佳推荐
    const best = recs[0];
    if (!best) continue;

    // 计算风险
    const dueDate = order.due_date;
    const productionDays = Math.ceil(best.timing.total_minutes / (8 * 60));
    const finishDate = addDaysToToday(productionDays + profile.bufferDays);
    const riskResult = checkRisk(
      { due_date: dueDate },
      { planned_end_date: finishDate },
      { quality_score: best.score_breakdown?.quality ?? 80, utilization_pct: best.load?.utilization_pct ?? 50 },
    );

    // 计算成本变化（相对于第一个方案的基准）
    const baseCost = recs[0]?.timing?.total_minutes ?? 1;
    const thisCost = best.timing.total_minutes;
    const costChangePct = Math.round(((thisCost - baseCost) / baseCost) * 100);

    // 计算对其他订单的影响
    const impacts = computeImpacts(best, existingAllocations, factories);

    scenarios.push({
      scenario_type: profile.type,
      scenario_label: profile.label,
      description: profile.description,

      target_factory_id: best.factory_id,
      target_factory_name: best.factory_name,

      expected_finish_date: finishDate,
      risk_level: riskResult.level,
      buffer_days: riskResult.buffer_days,
      cost_change_pct: costChangePct,

      impact_summary: impacts.summary,
      impacted_orders: impacts.orders,

      recommendation_score: Math.round(best.score * 100),
      recommendation_reason: buildReason(profile, best, riskResult),
      score_breakdown: best.score_breakdown ?? {},

      payload: {
        factory: { id: best.factory_id, name: best.factory_name },
        timing: best.timing,
        load: best.load,
        feasible: best.feasible,
        weights_used: profile.weights,
        buffer_days_added: profile.bufferDays,
      },
    });
  }

  // 追加一个"不动方案"（维持现状）
  scenarios.push({
    scenario_type: "hold",
    scenario_label: "维持现状",
    description: "不做调整，接受当前风险",
    target_factory_id: null,
    target_factory_name: null,
    expected_finish_date: null,
    risk_level: "HIGH",
    buffer_days: 0,
    cost_change_pct: 0,
    impact_summary: "无变化",
    impacted_orders: [],
    recommendation_score: 20,
    recommendation_reason: "不做任何调整，风险继续累积",
    score_breakdown: {},
    payload: {},
  });

  // 按推荐指数排序
  scenarios.sort((a, b) => b.recommendation_score - a.recommendation_score);

  return scenarios;
}

// ── Helpers ──────────────────────────────────────────────

function addDaysToToday(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function computeImpacts(recommendation, existingAllocations, factories) {
  // 找到同工厂的现有订单
  const sameFactory = existingAllocations.filter(
    (a) => a.factory_id === recommendation.factory_id &&
      ["confirmed", "in_progress"].includes(a.status),
  );

  if (sameFactory.length === 0) {
    return { summary: "不影响其他订单", orders: [] };
  }

  // 简单影响分析：如果该工厂利用率已经很高，新订单会挤压现有订单
  const utilization = recommendation.load?.utilization_pct ?? 0;
  const orders = [];

  if (utilization > 80) {
    // 高负载工厂，可能影响最后一个订单
    const lastOrder = sameFactory[sameFactory.length - 1];
    if (lastOrder) {
      const delayDays = utilization > 90 ? 2 : 1;
      orders.push({
        order_id: lastOrder.order_id ?? lastOrder.id?.slice(0, 8),
        impact_type: "delay",
        estimated_delay_days: delayDays,
      });
    }
  }

  const summary = orders.length > 0
    ? orders.map((o) => `${o.order_id} 可能延后${o.estimated_delay_days}天`).join("；")
    : "不影响其他订单";

  return { summary, orders };
}

function buildReason(profile, recommendation, riskResult) {
  const parts = [];

  if (recommendation.feasible) {
    parts.push("可按时交付");
  } else {
    parts.push("交期紧张");
  }

  if (riskResult.level === "SAFE") {
    parts.push(`缓冲${riskResult.buffer_days}天`);
  } else if (riskResult.level === "HIGH") {
    parts.push("高风险");
  }

  const util = recommendation.load?.utilization_pct ?? 0;
  if (util < 50) {
    parts.push("工厂产能充裕");
  } else if (util > 80) {
    parts.push("工厂负荷较高");
  }

  return `${profile.label}：${parts.join("，")}`;
}
