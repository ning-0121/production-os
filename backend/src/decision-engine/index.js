/**
 * Decision Engine — pure assembly of a DecisionAssessment.
 *
 * (subject, decision_type, context) → full DecisionAssessment:
 *   current_state + scored options + recommendation + if_no_action.
 *
 * No I/O, no LLM. Deterministic: same context → same assessment (modulo the
 * computed_at timestamp, which the caller can stamp).
 */

import { generateOptions } from "./options.js";
import { scoreAll, pickRecommendation } from "./scoring.js";

export const DECISION_TYPES = [
  "delay_resolution", "material_shortage_resolution", "qc_rework_resolution",
  "vip_insertion", "line_disruption_resolution",
];

/**
 * @param {object} ctx  normalized context from io.js. Must include
 *   { subject:{type,id}, decision_type, urgency, expected_delay_days, ... }
 * @param {object} [opts] { now?: Date, id?: string, adjustmentMap?: Map }
 *   adjustmentMap: optional learned bounded nudges (learning loop). Omit → pure deterministic.
 * @returns {DecisionAssessment}
 */
export function assembleDecision(ctx, opts = {}) {
  const decisionType = ctx.decision_type;
  const now = opts.now ?? new Date();

  const rawOptions = generateOptions(decisionType, ctx);
  const scored = scoreAll(rawOptions, ctx, opts.adjustmentMap);
  const rec = pickRecommendation(scored);

  // if_no_action = the keep_current baseline's outcome.
  const keep = scored.find((o) => o.option_type === "keep_current") ?? null;
  const ifNoAction = buildIfNoAction(ctx, keep);

  return {
    id: opts.id ?? null,
    subject: { type: ctx.subject?.type ?? null, id: ctx.subject?.id ?? null },
    decision_type: decisionType,
    urgency: ctx.urgency ?? "medium",
    current_state: buildCurrentState(ctx),
    options: scored,
    recommended_option_id: rec.recommended_option_id,
    recommendation_reason: rec.recommendation_reason,
    confidence_score: rec.confidence_score,
    if_no_action: ifNoAction,
    computed_at: now.toISOString(),
  };
}

function buildCurrentState(ctx) {
  const delay = Math.max(0, num(ctx.expected_delay_days));
  return {
    summary: ctx.summary ?? defaultSummary(ctx, delay),
    risk_score: num(ctx.risk_score),
    expected_delay_days: delay,
    affected_orders: ctx.affected_orders ?? [],
    affected_lines: ctx.affected_lines ?? [],
    affected_factories: ctx.affected_factories ?? [],
    estimated_margin_impact: num(ctx.estimated_margin_impact),
  };
}

function buildIfNoAction(ctx, keepOption) {
  const delay = Math.max(0, num(ctx.expected_delay_days));
  const marginLoss = keepOption ? Math.abs(num(keepOption.impact?.margin_delta)) : 0;
  return {
    expected_delay_days: delay,
    affected_orders: ctx.affected_orders ?? [],
    margin_loss: marginLoss,
    customer_risk: delay >= 3 ? "high" : delay > 0 ? "medium" : "low",
    escalation_risk: ctx.urgency === "critical" || delay >= 5 ? "high" : delay > 0 ? "medium" : "low",
  };
}

function defaultSummary(ctx, delay) {
  const subj = `${ctx.subject?.type ?? "对象"} ${String(ctx.subject?.id ?? "").slice(0, 10)}`;
  switch (ctx.decision_type) {
    case "delay_resolution": return `${subj} 预计延期 ${delay} 天，需要决策如何处置。`;
    case "material_shortage_resolution": return `${subj} 物料未齐套，影响开工。`;
    case "qc_rework_resolution": return `${subj} 验货异常，需决定返工策略。`;
    case "vip_insertion": return `紧急订单需要插入排程。`;
    case "line_disruption_resolution": return `${subj} 发生产线/工厂中断。`;
    default: return `${subj} 需要生产决策。`;
  }
}

function num(x, fallback = 0) { const n = Number(x); return Number.isFinite(n) ? n : fallback; }
