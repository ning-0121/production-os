/**
 * Risk Engine — public pure API.
 *
 * Each assessor takes a SIGNALS object (already gathered by io.js or by the
 * caller in a test) and returns a canonical RiskAssessment. No DB. No LLM.
 *
 * Callers MUST go through this module. Pages and agents read but never
 * write business state from here — that is by design and enforced by code review.
 */

import { levelFromScore, colorForLevel, translateLegacy } from "./scales.js";
import {
  scoreBufferDays, scoreDeviationPct, scoreQcFailures, scoreActiveRework,
  scoreMaterialShortage, scoreRuntimeStatus, scoreOverload, scoreEfficiency,
  scoreFactoryScore, scoreActiveRedLines, scoreCustomerRisk, scorePaymentOverdue,
  scoreRecentAnomalies, aggregateScore, pickTopReasons,
} from "./rules.js";

/**
 * @typedef {Object} RiskAssessment
 * @property {{ type: string, id: string }} subject
 * @property {"ok"|"warn"|"critical"} level
 * @property {number} score
 * @property {"green"|"amber"|"red"} color
 * @property {Array<{ kind: string, value: unknown, weight: number, direction: string, reason: string }>} signals
 * @property {string[]} top_reasons
 * @property {string} computed_at
 */

/**
 * Internal: pack a list of scored signals into the canonical envelope.
 */
function envelope(subject, signals) {
  const filtered = signals.filter((s) => s != null);
  const { score } = aggregateScore(filtered);
  const level = levelFromScore(score);
  return {
    subject,
    level,
    score: Math.round(score * 10) / 10,
    color: colorForLevel(level),
    signals: filtered,
    top_reasons: pickTopReasons(filtered, 3),
    computed_at: new Date().toISOString(),
  };
}

// ════════════════════════════════════════════════════════════
// ORDER
// ════════════════════════════════════════════════════════════
/**
 * @param {{ id: string }} subject
 * @param {Object} signals
 * @param {number} [signals.buffer_days]
 * @param {number} [signals.deviation_pct]
 * @param {number} [signals.qc_failure_count]
 * @param {number} [signals.active_rework_count]
 * @param {number} [signals.material_shortage_count]
 * @param {string} [signals.runtime_risk]      legacy enum, will be translated
 * @param {string} [signals.customer_risk_level]
 * @param {Array} [signals.recent_anomalies]
 */
export function assessOrder(subject, signals = {}) {
  // Translate legacy `runtime_risk` to a runtime_status equivalent contribution
  const runtimeContribution = signals.runtime_risk
    ? mapRuntimeRiskToContribution(signals.runtime_risk)
    : null;

  return envelope({ type: "order", id: subject.id }, [
    scoreBufferDays(signals.buffer_days),
    scoreDeviationPct(signals.deviation_pct),
    scoreQcFailures(signals.qc_failure_count),
    scoreActiveRework(signals.active_rework_count),
    scoreMaterialShortage(signals.material_shortage_count),
    runtimeContribution,
    scoreCustomerRisk(signals.customer_risk_level),
    scoreRecentAnomalies(signals.recent_anomalies),
  ]);
}

// ════════════════════════════════════════════════════════════
// ALLOCATION (a specific factory's share of an order)
// ════════════════════════════════════════════════════════════
export function assessAllocation(subject, signals = {}) {
  return envelope({ type: "allocation", id: subject.id }, [
    scoreBufferDays(signals.buffer_days),
    scoreDeviationPct(signals.deviation_pct),
    scoreActiveRework(signals.active_rework_count),
    scoreRuntimeStatus(signals.runtime_status),
    scoreOverload(signals.overload_pct),
    scoreEfficiency(signals.current_efficiency),
    scoreRecentAnomalies(signals.recent_anomalies),
  ]);
}

// ════════════════════════════════════════════════════════════
// LINE (runtime)
// ════════════════════════════════════════════════════════════
export function assessLine(subject, signals = {}) {
  return envelope({ type: "line", id: subject.id }, [
    scoreRuntimeStatus(signals.runtime_status),
    scoreOverload(signals.overload_pct),
    scoreEfficiency(signals.current_efficiency),
    scoreRecentAnomalies(signals.recent_anomalies),
  ]);
}

// ════════════════════════════════════════════════════════════
// FACTORY
// ════════════════════════════════════════════════════════════
export function assessFactory(subject, signals = {}) {
  return envelope({ type: "factory", id: subject.id }, [
    scoreFactoryScore(signals.delay_score, "delay_score", "守期"),
    scoreFactoryScore(signals.quality_score, "quality_score", "质量"),
    scoreFactoryScore(signals.cooperation_score, "cooperation_score", "协作"),
    scoreActiveRedLines(signals.active_red_lines_count),
    scoreRecentAnomalies(signals.recent_anomalies),
  ]);
}

// ════════════════════════════════════════════════════════════
// CUSTOMER
// ════════════════════════════════════════════════════════════
export function assessCustomer(subject, signals = {}) {
  return envelope({ type: "customer", id: subject.id }, [
    scoreCustomerRisk(signals.risk_level),
    scorePaymentOverdue(signals.payment_overdue_days),
  ]);
}

// ════════════════════════════════════════════════════════════
// Dispatcher — string subject_type → assessor
// ════════════════════════════════════════════════════════════
const DISPATCH = {
  order: assessOrder,
  allocation: assessAllocation,
  line: assessLine,
  factory: assessFactory,
  customer: assessCustomer,
};

export function assess(subjectType, subject, signals) {
  const fn = DISPATCH[subjectType];
  if (!fn) throw new Error(`Unknown subject_type: ${subjectType}`);
  return fn(subject, signals);
}

export const SUPPORTED_SUBJECT_TYPES = Object.keys(DISPATCH);

// ── Internal helpers ──

function mapRuntimeRiskToContribution(legacyRisk) {
  const canonical = translateLegacy(legacyRisk);
  if (!canonical) return null;
  if (canonical === "critical") return { kind: "runtime_line_risk", value: legacyRisk, weight: 25, direction: "raises", reason: "关联产线运行时风险:红" };
  if (canonical === "warn")     return { kind: "runtime_line_risk", value: legacyRisk, weight: 10, direction: "raises", reason: "关联产线运行时风险:黄" };
  return null;
}
