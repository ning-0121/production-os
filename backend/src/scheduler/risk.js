import { differenceInCalendarDays, parseISO, isValid } from "date-fns";

/**
 * @typedef {'SAFE' | 'MEDIUM' | 'HIGH'} RiskLevel
 * @typedef {{ level: RiskLevel, buffer_days: number, risk_score: number, factors: object, message?: string }} RiskResult
 */

/**
 * Enhanced multi-factor risk model.
 *
 * Factors:
 *   1. Time buffer (days until due) — primary factor
 *   2. Factory quality score — low quality = higher risk
 *   3. Factory utilization — high load = higher risk
 *   4. Historical on-time rate — poor track record = higher risk
 *
 * @param {{ due_date: string | Date }} order
 * @param {{ planned_end_date: string | Date }} allocation
 * @param {{ safe_threshold?: number, medium_threshold?: number, quality_score?: number, utilization_pct?: number, on_time_rate?: number }} [opts]
 * @returns {RiskResult}
 */
export function checkRisk(order, allocation, opts = {}) {
  const safeThreshold = Number(opts.safe_threshold ?? 5);
  const mediumThreshold = Number(opts.medium_threshold ?? 2);

  const due = toDate(order.due_date);
  const end = toDate(allocation.planned_end_date);
  const bufferDays = differenceInCalendarDays(due, end);

  // ── Factor 1: Time buffer (0-100, higher = safer) ─────
  let timeFactor;
  if (bufferDays < 0) timeFactor = 0;
  else if (bufferDays < mediumThreshold) timeFactor = 15;
  else if (bufferDays < safeThreshold) timeFactor = 50;
  else timeFactor = Math.min(100, 60 + bufferDays * 4);

  // ── Factor 2: Factory quality (0-100) ─────────────────
  const qualityScore = opts.quality_score ?? null;
  const qualityFactor = qualityScore != null ? qualityScore : 70; // default neutral

  // ── Factor 3: Utilization risk (0-100, higher = safer) ─
  const utilPct = opts.utilization_pct ?? null;
  let utilFactor = 70; // default neutral
  if (utilPct != null) {
    if (utilPct > 90) utilFactor = 10;
    else if (utilPct > 80) utilFactor = 30;
    else if (utilPct > 60) utilFactor = 60;
    else utilFactor = 90;
  }

  // ── Factor 4: Historical on-time rate (0-100) ─────────
  const onTimeRate = opts.on_time_rate ?? null;
  const historyFactor = onTimeRate != null ? onTimeRate : 70;

  // ── Weighted composite score ──────────────────────────
  const weights = { time: 0.50, quality: 0.15, utilization: 0.20, history: 0.15 };
  const riskScore = Math.round(
    timeFactor * weights.time +
    qualityFactor * weights.quality +
    utilFactor * weights.utilization +
    historyFactor * weights.history
  );

  // ── Level determination ───────────────────────────────
  let level;
  let message;

  if (bufferDays < 0) {
    level = "HIGH";
    message = `已超出交期 ${Math.abs(bufferDays)} 天，需立即处理`;
  } else if (riskScore < 30) {
    level = "HIGH";
    message = bufferDays < mediumThreshold
      ? `交期紧迫，仅剩 ${bufferDays} 天缓冲`
      : `综合风险高 (评分${riskScore})，建议关注`;
  } else if (riskScore < 60) {
    level = "MEDIUM";
    message = `交期风险 (评分${riskScore})，剩余 ${bufferDays} 天，建议提前沟通`;
  } else {
    level = "SAFE";
    message = undefined;
  }

  return {
    level,
    buffer_days: bufferDays,
    risk_score: riskScore,
    factors: {
      time: timeFactor,
      quality: qualityFactor,
      utilization: utilFactor,
      history: historyFactor,
    },
    message,
  };
}

function toDate(d) {
  if (d instanceof Date) return d;
  const parsed = typeof d === "string" ? parseISO(d) : new Date(d);
  return isValid(parsed) ? parsed : new Date();
}
