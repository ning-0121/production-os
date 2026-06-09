/**
 * Decision Option Scoring — pure, deterministic.
 *
 * Turns each option's impact into four 0–100 sub-scores and one total. The
 * recommendation is the highest-total FEASIBLE option. Weights make delivery
 * (delay reduction) the dominant factor, with cost + risk as penalties — i.e.
 * the engine prefers fixing the delay unless the cost is unreasonable.
 *
 * Calibrated so that, for a 5-day delay:
 *   reassign_factory (delay→0)  scores highest
 *   overtime (delay→~1)         close behind
 *   split_order (delay→~1, complex) a bit lower
 *   keep_current (delay 5)      lowest
 */

const WEIGHTS = { delivery: 0.45, cost: 0.2, risk: 0.25, feasibility: 0.1 };

// Normalization ceilings (impacts beyond these saturate the score).
const MAX_DELAY_FIX_DAYS = 7;     // fixing ≥7 days = full delivery credit
const MAX_REASONABLE_COST = 3000; // cost ≥ this = worst cost score
const MAX_RISK_REDUCTION = 60;    // risk_delta ≤ -60 = full risk credit

// Feasibility priors per option type (operational complexity / dependency).
const FEASIBILITY_PRIOR = {
  keep_current: 100,
  overtime: 85,
  add_qc_check: 90,
  partial_start: 75,
  create_rework_plan: 80,
  expedite_material: 70,
  substitute_material: 60,     // needs approval
  reassign_line: 72,
  split_order: 55,             // high coordination complexity
  reassign_factory: 50,        // transfer + collateral + approval
  delay_customer: 65,
};

/**
 * Score one option (pure). Returns a NEW option object with scores filled.
 * @param {DecisionOption} opt
 * @param {object} ctx
 * @param {{adjustment:number, reason:string|null, sample_size:number}} [learned]
 *        Optional BOUNDED learning nudge (from the learning loop). Applied on
 *        top of the deterministic base score; recorded on the option for
 *        transparency. Pass nothing → pure deterministic behavior.
 */
export function scoreOption(opt, ctx, learned) {
  const imp = opt.impact ?? {};

  // Delivery: reward delay reduction. delay_days_delta negative = good.
  const delayFixed = Math.max(0, -num(imp.delay_days_delta));
  const delivery = clamp100((delayFixed / MAX_DELAY_FIX_DAYS) * 100);

  // Cost: lower cost = higher score. cost_delta 0 → 100.
  const cost_score = clamp100(100 - (num(imp.cost_delta) / MAX_REASONABLE_COST) * 100);

  // Risk: reward risk reduction. risk_delta negative = good.
  const riskReduced = Math.max(0, -num(imp.risk_delta));
  const risk_score = clamp100((riskReduced / MAX_RISK_REDUCTION) * 100);

  // Feasibility: prior, minus a penalty for wide collateral impact.
  const collateral = (imp.affected_orders?.length ?? 0) + (imp.affected_lines?.length ?? 0);
  const feasibility_score = clamp100((FEASIBILITY_PRIOR[opt.option_type] ?? 60) - collateral * 5);

  let total = WEIGHTS.delivery * delivery
    + WEIGHTS.cost * cost_score
    + WEIGHTS.risk * risk_score
    + WEIGHTS.feasibility * feasibility_score;

  // keep_current is penalized when there is real delay to fix (doing nothing
  // shouldn't win just by being free + feasible).
  if (opt.option_type === "keep_current" && num(ctx.expected_delay_days) > 0) {
    total *= 0.55;
  }
  // Heavy customer-impact options carry a small penalty (goodwill cost).
  if (imp.customer_impact === "high") total -= 6;

  const base_score = Math.round(clamp100(total));

  // Learning nudge — BOUNDED, applied on top of the deterministic base. Never
  // flips ordering wildly (capped ±MAX_NUDGE upstream). Recorded for audit.
  const nudge = Number(learned?.adjustment) || 0;
  const total_score = Math.round(clamp100(base_score + nudge));

  // Confidence: how sure we are about this option's estimate. Lower when the
  // option depends on external availability (alt factory/line/material).
  const dependsExternal = ["reassign_factory", "reassign_line", "expedite_material", "substitute_material"].includes(opt.option_type);
  const confidence_score = round2(clamp01(
    0.85 - (dependsExternal ? 0.2 : 0) - (collateral > 0 ? 0.1 : 0),
  ));

  return {
    ...opt,
    feasibility_score,
    risk_score,
    cost_score,
    confidence_score,
    base_score,
    total_score,
    // Transparency: what the learning loop did to this option (if anything).
    learning: nudge !== 0
      ? { delta: nudge, reason: learned?.reason ?? null, sample_size: learned?.sample_size ?? 0 }
      : null,
  };
}

/**
 * Score all options + sort by total_score desc.
 * @param {Array} options
 * @param {object} ctx
 * @param {Map} [adjustmentMap]  optional learned-adjustment map keyed by
 *        `${decision_type}|${option_type}` (from learning.buildAdjustmentMap)
 */
export function scoreAll(options, ctx, adjustmentMap) {
  const dt = ctx?.decision_type;
  return (options ?? [])
    .map((o) => scoreOption(o, ctx, adjustmentMap?.get(`${dt}|${o.option_type}`)))
    .sort((a, b) => b.total_score - a.total_score);
}

/**
 * Pick the recommended option id + reason from already-scored options.
 * @returns {{ recommended_option_id: string|null, recommendation_reason: string, confidence_score: number }}
 */
export function pickRecommendation(scoredOptions) {
  const opts = scoredOptions ?? [];
  if (opts.length === 0) return { recommended_option_id: null, recommendation_reason: "无可用选项", confidence_score: 0 };

  // Highest total wins. Prefer non-keep_current on ties so the system is biased
  // toward action when scores are equal.
  const best = [...opts].sort((a, b) => b.total_score - a.total_score || (a.option_type === "keep_current" ? 1 : -1))[0];

  const imp = best.impact ?? {};
  const reasonParts = [`综合评分 ${best.total_score}/100`];
  if (num(imp.delay_days_delta) < 0) reasonParts.push(`减少延期 ${Math.abs(num(imp.delay_days_delta))} 天`);
  if (num(imp.cost_delta) > 0) reasonParts.push(`成本 ¥${num(imp.cost_delta)}`);
  if (num(imp.risk_delta) < 0) reasonParts.push(`风险下降 ${Math.abs(num(imp.risk_delta))}`);

  return {
    recommended_option_id: best.id,
    recommendation_reason: `推荐「${best.title}」：${reasonParts.join("，")}`,
    confidence_score: best.confidence_score,
  };
}

// ── Helpers ──
function num(x, fallback = 0) { const n = Number(x); return Number.isFinite(n) ? n : fallback; }
function clamp100(x) { return Math.max(0, Math.min(100, x)); }
function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function round2(x) { return Math.round(x * 100) / 100; }
