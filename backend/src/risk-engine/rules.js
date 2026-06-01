/**
 * Risk Scoring Rules — deterministic, pure, no LLM.
 *
 * Each rule receives a typed Signal and returns a contribution to the score
 * plus a human-readable reason. Rules are PROPORTIONAL not threshold-stepped
 * where it matters (e.g. buffer_days gets a graded penalty, not a cliff).
 *
 * Why deterministic: factory floor managers will memorize what makes things
 * red. An LLM that scores differently each run destroys that intuition.
 *
 * Each rule outputs:
 *   { kind, value, weight, direction, reason }
 *     kind:      signal identifier (used in audit + UI tooltips)
 *     value:     the raw value the rule saw (for tracing)
 *     weight:    contribution to the final score (positive = increases risk)
 *     direction: "raises" | "lowers" | "neutral"
 *     reason:    one-line Chinese explanation for end users
 */

/** @typedef {{ kind: string, value: unknown, weight: number, direction: "raises"|"lowers"|"neutral", reason: string }} ScoredSignal */

// ── Order-level signals ──────────────────────────────────

export function scoreBufferDays(bufferDays) {
  if (bufferDays == null) return null;
  const b = Number(bufferDays);
  if (!Number.isFinite(b)) return null;
  if (b < 0)   return sig("buffer_days", b, 50, `已逾期 ${Math.abs(b)} 天`);
  if (b < 2)   return sig("buffer_days", b, 38, `仅剩 ${b} 天缓冲，极紧`);
  if (b < 5)   return sig("buffer_days", b, 22, `剩余 ${b} 天缓冲，偏紧`);
  if (b < 10)  return sig("buffer_days", b, 8,  `剩余 ${b} 天缓冲`);
  return sig("buffer_days", b, 0, `缓冲充足 (${b} 天)`, "lowers");
}

export function scoreDeviationPct(devPct) {
  if (devPct == null) return null;
  const d = Number(devPct);
  if (!Number.isFinite(d)) return null;
  // Negative = behind plan
  if (d <= -25) return sig("deviation_pct", d, 40, `进度严重落后 ${Math.abs(d)}%`);
  if (d <= -15) return sig("deviation_pct", d, 25, `进度落后 ${Math.abs(d)}%`);
  if (d <= -5)  return sig("deviation_pct", d, 14, `进度小幅落后 ${Math.abs(d)}%`);
  if (d >= 10)  return sig("deviation_pct", d, 0,  `进度领先 ${d}%`, "lowers");
  return sig("deviation_pct", d, 0, "进度基本符合计划", "neutral");
}

export function scoreQcFailures(failCount) {
  const f = Number(failCount);
  if (!Number.isFinite(f) || f <= 0) return null;
  if (f >= 3) return sig("qc_failures", f, 35, `近期 ${f} 次验货不合格`);
  if (f >= 1) return sig("qc_failures", f, 20, `近期 ${f} 次验货不合格`);
  return null;
}

export function scoreActiveRework(reworkCount) {
  const r = Number(reworkCount);
  if (!Number.isFinite(r) || r <= 0) return null;
  if (r >= 2) return sig("active_rework", r, 22, `${r} 个进行中返工单`);
  return sig("active_rework", r, 12, "有进行中返工");
}

export function scoreMaterialShortage(shortageCount) {
  const s = Number(shortageCount);
  if (!Number.isFinite(s) || s <= 0) return null;
  return sig("material_shortage", s, 30, `物料缺口 ${s} 项`);
}

// ── Line (runtime) signals ──────────────────────────────

export function scoreRuntimeStatus(status) {
  if (!status) return null;
  // down + blocked alone are catastrophic for that line — must hit critical (>70)
  // even without other signals piling on.
  switch (String(status)) {
    case "down":       return sig("runtime_status", status, 80, "产线停机");
    case "blocked":    return sig("runtime_status", status, 72, "产线阻塞");
    case "rework":     return sig("runtime_status", status, 28, "产线返工中");
    case "changeover": return sig("runtime_status", status, 10, "产线换型中");
    case "idle":       return sig("runtime_status", status, 5,  "产线待机");
    case "running":    return sig("runtime_status", status, 0,  "产线运行中", "lowers");
    default:           return null;
  }
}

export function scoreOverload(overloadPct) {
  if (overloadPct == null) return null;
  const o = Number(overloadPct);
  if (!Number.isFinite(o)) return null;
  if (o >= 120) return sig("overload_pct", o, 45, `严重超载 ${o.toFixed(0)}%`);
  if (o >= 105) return sig("overload_pct", o, 28, `超载 ${o.toFixed(0)}%`);
  if (o >= 95)  return sig("overload_pct", o, 14, `负载偏高 ${o.toFixed(0)}%`);
  return sig("overload_pct", o, 0, `负载 ${o.toFixed(0)}%`, "neutral");
}

export function scoreEfficiency(eff) {
  if (eff == null) return null;
  const e = Number(eff);
  if (!Number.isFinite(e)) return null;
  if (e < 0.5) return sig("efficiency", e, 30, `效率仅 ${(e * 100).toFixed(0)}%`);
  if (e < 0.7) return sig("efficiency", e, 16, `效率偏低 ${(e * 100).toFixed(0)}%`);
  if (e < 0.85) return sig("efficiency", e, 6, `效率 ${(e * 100).toFixed(0)}%`);
  return sig("efficiency", e, 0, `效率正常 ${(e * 100).toFixed(0)}%`, "lowers");
}

// ── Factory signals ─────────────────────────────────────

export function scoreFactoryScore(score, fieldName, label) {
  if (score == null) return null;
  const s = Number(score);
  if (!Number.isFinite(s)) return null;
  if (s < 50) return sig(fieldName, s, 30, `${label}评分极低 (${s})`);
  if (s < 70) return sig(fieldName, s, 18, `${label}评分偏低 (${s})`);
  if (s < 85) return sig(fieldName, s, 6,  `${label}评分 ${s}`);
  return sig(fieldName, s, 0, `${label}评分良好 (${s})`, "lowers");
}

export function scoreActiveRedLines(redCount) {
  const c = Number(redCount);
  if (!Number.isFinite(c) || c <= 0) return null;
  return sig("active_red_lines", c, Math.min(40, c * 15), `${c} 条产线高风险`);
}

// ── Customer signals ────────────────────────────────────

export function scoreCustomerRisk(riskLevel) {
  if (!riskLevel) return null;
  switch (String(riskLevel)) {
    case "high":   return sig("customer_risk_level", riskLevel, 50, "客户风险等级:高");
    case "medium": return sig("customer_risk_level", riskLevel, 22, "客户风险等级:中");
    case "low":    return sig("customer_risk_level", riskLevel, 0,  "客户风险等级:低", "lowers");
    default:       return null;
  }
}

export function scorePaymentOverdue(daysOverdue) {
  const d = Number(daysOverdue);
  if (!Number.isFinite(d) || d <= 0) return null;
  if (d >= 60) return sig("payment_overdue", d, 35, `付款已逾期 ${d} 天`);
  if (d >= 30) return sig("payment_overdue", d, 20, `付款逾期 ${d} 天`);
  return sig("payment_overdue", d, 8, `付款逾期 ${d} 天`);
}

// ── Recent anomalies (any subject) ──────────────────────

export function scoreRecentAnomalies(anomalies) {
  if (!Array.isArray(anomalies) || anomalies.length === 0) return null;
  const critical = anomalies.filter((a) => a?.severity === "critical").length;
  const high = anomalies.filter((a) => a?.severity === "high").length;
  if (critical > 0) return sig("recent_anomalies", { critical, high }, 30, `近 24h 出现 ${critical} 个紧急异常`);
  if (high > 0)     return sig("recent_anomalies", { critical, high }, 15, `近 24h 出现 ${high} 个重要异常`);
  return null;
}

// ── Aggregation ─────────────────────────────────────────

/**
 * Sum signal weights into a final score, capped at 100.
 * Signals with direction="lowers" can offset (but not below 0).
 *
 * @param {ScoredSignal[]} signals
 * @returns {{ score: number, raises_total: number, lowers_total: number }}
 */
export function aggregateScore(signals) {
  let raises = 0, lowers = 0;
  for (const s of signals) {
    if (!s) continue;
    if (s.direction === "raises") raises += s.weight;
    else if (s.direction === "lowers") lowers += s.weight * 0.3;  // gentle offset, never overrides red
  }
  const score = Math.max(0, Math.min(100, raises - lowers));
  return { score, raises_total: raises, lowers_total: lowers };
}

/**
 * Top reasons for UI display — top N by absolute weight, raises-first.
 */
export function pickTopReasons(signals, n = 3) {
  return signals
    .filter((s) => s && s.weight > 0 && s.direction === "raises")
    .sort((a, b) => b.weight - a.weight)
    .slice(0, n)
    .map((s) => s.reason);
}

// ── Helper ──────────────────────────────────────────────

function sig(kind, value, weight, reason, direction = "raises") {
  return { kind, value, weight, direction, reason };
}
