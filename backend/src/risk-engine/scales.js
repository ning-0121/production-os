/**
 * Canonical risk scale — the ONLY source of truth for risk levels in the system.
 *
 * Pure. No I/O. Used by every page, every agent, every report.
 *
 * Migration mapping table at the bottom translates legacy enums to canonical
 * levels so old data and old code continue working.
 */

// ── Canonical 3-level scale ──────────────────────────────
// 3 is the right cardinality for factory floor managers. 2 is too coarse
// (lose "watching" state). 4+ asks managers to memorize an abstraction.

export const LEVELS = /** @type {const} */ (["ok", "warn", "critical"]);

/** Score thresholds — strict so behavior is reproducible across reruns. */
export const SCORE_THRESHOLDS = {
  ok_max: 30,        // 0–30  → ok
  warn_max: 70,      // 30–70 → warn; 70+ → critical
};

/** Default color mapping. Frontend uses the same triple everywhere. */
export const COLORS = /** @type {const} */ ({
  ok: "green",
  warn: "amber",
  critical: "red",
});

/** Cap any signal-summed score at 100 — keeps the scalar interpretable. */
export const SCORE_MAX = 100;

/**
 * Convert a numeric score into a canonical level.
 * @param {number} score
 * @returns {"ok" | "warn" | "critical"}
 */
export function levelFromScore(score) {
  const s = Math.max(0, Math.min(SCORE_MAX, Number(score) || 0));
  if (s <= SCORE_THRESHOLDS.ok_max) return "ok";
  if (s <= SCORE_THRESHOLDS.warn_max) return "warn";
  return "critical";
}

/** Color for a given canonical level. */
export function colorForLevel(level) {
  return COLORS[level] ?? "green";
}

// ── Legacy → canonical translation ──────────────────────
// Every legacy enum value used anywhere in the codebase MUST appear here.
// Anything missing is a bug — surface it via translateLegacy() returning null.

const LEGACY_MAP = Object.freeze({
  // scheduler/risk.js + risk_alerts.risk_level
  SAFE: "ok",
  MEDIUM: "warn",
  HIGH: "critical",
  // order_corrections.risk_status
  on_track: "ok",
  falling_behind: "warn",
  // runtime_lines.runtime_risk
  green: "ok",
  amber: "warn",
  red: "critical",
  // customers.risk_level, anomaly severity, AIAction urgency
  low: "ok",
  medium: "warn",
  high: "critical",
  // urgency enum extra
  info: "ok",
  // "critical" maps to itself everywhere — included explicitly so the map is exhaustive
  critical: "critical",
  warn: "warn",
  ok: "ok",
});

/**
 * Translate any legacy value to a canonical level, or null if unrecognized.
 * Used by io.js when reading legacy DB columns + agent outputs.
 */
export function translateLegacy(value) {
  if (value == null) return null;
  const key = String(value).trim();
  return LEGACY_MAP[key] ?? null;
}

/** Inverse: canonical → legacy enum a particular table expects. */
export const LEGACY_WRITE_MAP = Object.freeze({
  runtime_risk: { ok: "green", warn: "amber", critical: "red" },
  risk_status:  { ok: "on_track", warn: "falling_behind", critical: "critical" },
  risk_level:   { ok: "SAFE", warn: "MEDIUM", critical: "HIGH" },
});

export function toLegacy(canonical, target) {
  const m = LEGACY_WRITE_MAP[target];
  if (!m) throw new Error(`unknown legacy target: ${target}`);
  return m[canonical] ?? m.ok;
}
