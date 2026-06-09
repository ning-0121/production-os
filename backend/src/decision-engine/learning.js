/**
 * Decision Learning — pure, deterministic, bounded.
 *
 * Converts historical decision outcomes into a per-(decision_type, option_type)
 * "effectiveness" and a BOUNDED score adjustment the scorer can apply. No LLM,
 * no randomness. Same history → same numbers.
 *
 * Guardrails:
 *   - adjustment capped to ±MAX_NUDGE so learning can never flip the
 *     deterministic ordering wildly.
 *   - below MIN_SAMPLES selections, adjustment = 0 (cold start = pure base).
 *   - every adjustment carries a human-readable reason.
 */

export const MAX_NUDGE = 12;       // max points learning can add/subtract
export const MIN_SAMPLES = 3;      // need ≥3 selections before any nudge
const EXEC_WEIGHT = 0.6;           // execution success vs feedback blend
const FEEDBACK_WEIGHT = 0.4;

/**
 * @typedef {Object} DecisionLogRow
 * @property {string} decision_id
 * @property {string} selected_option_id
 * @property {string} action_status   applied|partial|failed|dismissed|approval_requested
 * @property {string|null} override_reason
 * @property {object} result_summary  { option_type, ... }
 */

/**
 * Aggregate raw logs + feedback into per-(decision_type, option_type) stats.
 *
 * @param {Array} logs       decision_logs joined with assessment.decision_type
 *                           (each row should carry decision_type + option_type)
 * @param {Array} feedback   decision_option_feedback rows (decision_type + option_type)
 * @returns {Array} learning rows (one per decision_type+option_type)
 */
export function computeEffectiveness(logs, feedback) {
  const map = new Map();   // key `${decision_type}|${option_type}` → acc

  const keyOf = (dt, ot) => `${dt}|${ot}`;
  const ensure = (dt, ot) => {
    const k = keyOf(dt, ot);
    if (!map.has(k)) {
      map.set(k, {
        decision_type: dt, option_type: ot,
        selected_count: 0, applied_count: 0, failed_count: 0, dismissed_count: 0,
        helpful_count: 0, not_helpful_count: 0,
        override_in_count: 0, override_out_count: 0,
      });
    }
    return map.get(k);
  };

  for (const log of logs ?? []) {
    const dt = log.decision_type ?? "unknown";
    const ot = log.option_type ?? log.result_summary?.option_type;
    if (!ot) continue;
    const acc = ensure(dt, ot);
    acc.selected_count++;
    const status = log.action_status;
    if (status === "applied" || status === "partial") acc.applied_count++;
    else if (status === "failed") acc.failed_count++;
    else if (status === "dismissed") acc.dismissed_count++;
    if (log.override_reason) acc.override_in_count++;
  }

  for (const fb of feedback ?? []) {
    const dt = fb.decision_type ?? "unknown";
    const ot = fb.option_type;
    if (!ot) continue;
    const acc = ensure(dt, ot);
    if (fb.feedback_type === "helpful") acc.helpful_count++;
    else if (fb.feedback_type === "not_helpful" || fb.feedback_type === "wrong_recommendation") acc.not_helpful_count++;
  }

  return [...map.values()].map(finalize);
}

/** Derive rates + bounded adjustment + reason for one accumulator. */
function finalize(acc) {
  const execDenom = acc.applied_count + acc.failed_count;
  const exec_success_rate = execDenom > 0 ? acc.applied_count / execDenom : 0.5;

  const fbDenom = acc.helpful_count + acc.not_helpful_count;
  const feedback_ratio = fbDenom > 0 ? acc.helpful_count / fbDenom : 0.5;

  const effectiveness = round3(EXEC_WEIGHT * exec_success_rate + FEEDBACK_WEIGHT * feedback_ratio);
  const sample_size = acc.selected_count;

  let adjustment = 0;
  let reason;
  if (sample_size < MIN_SAMPLES) {
    reason = `样本不足（${sample_size}<${MIN_SAMPLES}），不调整`;
  } else {
    adjustment = clamp(Math.round((effectiveness - 0.5) * 2 * MAX_NUDGE), -MAX_NUDGE, MAX_NUDGE);
    if (adjustment > 0) reason = `历史采纳 ${sample_size} 次，执行成功率 ${pct(exec_success_rate)}%，正向反馈 ${pct(feedback_ratio)}% → +${adjustment}`;
    else if (adjustment < 0) reason = `历史采纳 ${sample_size} 次，成功率偏低 ${pct(exec_success_rate)}%，反馈 ${pct(feedback_ratio)}% → ${adjustment}`;
    else reason = `历史表现中性（成功率 ${pct(exec_success_rate)}%），不调整`;
  }

  return {
    ...acc,
    exec_success_rate: round3(exec_success_rate),
    feedback_ratio: round3(feedback_ratio),
    effectiveness,
    sample_size,
    adjustment,
    reason,
  };
}

/**
 * Build a fast lookup adjustment map from learning rows.
 * @param {Array} learningRows  rows from decision_learning table (or computeEffectiveness)
 * @returns {Map<string, {adjustment:number, reason:string, sample_size:number, effectiveness:number}>}
 *          keyed by `${decision_type}|${option_type}`
 */
export function buildAdjustmentMap(learningRows) {
  const m = new Map();
  for (const r of learningRows ?? []) {
    m.set(`${r.decision_type}|${r.option_type}`, {
      adjustment: Number(r.adjustment) || 0,
      reason: r.reason ?? null,
      sample_size: Number(r.sample_size) || 0,
      effectiveness: Number(r.effectiveness) || 0.5,
    });
  }
  return m;
}

/**
 * Look up the learned adjustment for an option, falling back to zero.
 * @returns {{ adjustment:number, reason:string|null, sample_size:number }}
 */
export function lookupAdjustment(adjustmentMap, decisionType, optionType) {
  if (!adjustmentMap) return { adjustment: 0, reason: null, sample_size: 0 };
  return adjustmentMap.get(`${decisionType}|${optionType}`) ?? { adjustment: 0, reason: null, sample_size: 0 };
}

// ── helpers ──
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function round3(x) { return Math.round(x * 1000) / 1000; }
function pct(x) { return Math.round(x * 100); }
