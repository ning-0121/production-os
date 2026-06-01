/**
 * RiskPill — the ONLY way risk should be displayed in the UI.
 *
 * Reads the canonical RiskAssessment shape (or a thin variant). All pages
 * must use this — no more ad-hoc `riskClass={...}` derivations sprinkled
 * across components. Single visual language for risk.
 *
 * Two modes:
 *   - Inline pill (compact): `<RiskPill assessment={...} />`
 *   - With reasons (expanded): `<RiskPill assessment={...} showReasons />`
 *
 * Backward-compat helper translateLegacyRisk() also exposed for pages still
 * rendering pre-engine data — they get the same visual but flagged as legacy.
 */

import React from "react";
import type { RiskAssessment, RiskLevelCanonical, RiskColor } from "../../types";

const LEVEL_LABEL: Record<RiskLevelCanonical, string> = {
  ok: "正常",
  warn: "关注",
  critical: "紧急",
};

const COLOR_STYLES: Record<RiskColor, { bg: string; fg: string; border: string }> = {
  green:  { bg: "rgba(34,197,94,.14)",  fg: "#22c55e", border: "rgba(34,197,94,.4)" },
  amber:  { bg: "rgba(250,204,21,.14)", fg: "#facc15", border: "rgba(250,204,21,.4)" },
  red:    { bg: "rgba(251,113,133,.14)", fg: "#fb7185", border: "rgba(251,113,133,.4)" },
};

export function RiskPill({
  assessment,
  showReasons = false,
  compact = false,
  loading = false,
}: {
  assessment?: RiskAssessment | null;
  showReasons?: boolean;
  compact?: boolean;
  loading?: boolean;
}) {
  if (loading) {
    return <span className="riskPill riskPill--loading">评估中...</span>;
  }
  if (!assessment) {
    return <span className="riskPill riskPill--unknown">—</span>;
  }
  const color = COLOR_STYLES[assessment.color] ?? COLOR_STYLES.green;
  const sz = compact ? { pad: "2px 6px", font: 10, scoreFont: 9 } : { pad: "3px 10px", font: 11, scoreFont: 10 };

  return (
    <span className="riskPillWrap" style={{ display: "inline-flex", alignItems: "center", gap: 6, verticalAlign: "middle" }}>
      <span
        className={`riskPill riskPill--${assessment.level}`}
        title={assessment.top_reasons.join("\n") || `score ${assessment.score}`}
        style={{
          background: color.bg,
          color: color.fg,
          border: `1px solid ${color.border}`,
          borderRadius: 4,
          padding: sz.pad,
          fontSize: sz.font,
          fontWeight: 600,
          letterSpacing: "0.3px",
          whiteSpace: "nowrap",
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
        }}
      >
        <span style={{
          width: 6, height: 6, borderRadius: "50%",
          background: color.fg, display: "inline-block",
        }} />
        {LEVEL_LABEL[assessment.level]}
        {!compact && (
          <span style={{ opacity: 0.65, fontSize: sz.scoreFont, fontWeight: 400 }}>
            {Math.round(assessment.score)}
          </span>
        )}
      </span>
      {showReasons && assessment.top_reasons.length > 0 && (
        <span className="riskPillReasons" style={{ fontSize: 11, color: "var(--muted)" }}>
          {assessment.top_reasons[0]}
          {assessment.top_reasons.length > 1 && (
            <span style={{ opacity: 0.6 }}> · +{assessment.top_reasons.length - 1}</span>
          )}
        </span>
      )}
    </span>
  );
}

/**
 * Translate a legacy enum value into a stub RiskAssessment for legacy display.
 * Use ONLY on pages not yet migrated to /api/risk endpoint. New code MUST
 * use a real assessment from the engine.
 */
export function legacyAssessment(
  legacyValue: string | null | undefined,
  subjectType: RiskAssessment["subject"]["type"] = "order",
  subjectId = "_legacy_",
): RiskAssessment | null {
  if (!legacyValue) return null;
  const v = String(legacyValue).trim();
  const map: Record<string, { level: RiskLevelCanonical; color: RiskColor }> = {
    SAFE: { level: "ok", color: "green" }, MEDIUM: { level: "warn", color: "amber" }, HIGH: { level: "critical", color: "red" },
    on_track: { level: "ok", color: "green" }, falling_behind: { level: "warn", color: "amber" },
    green: { level: "ok", color: "green" }, amber: { level: "warn", color: "amber" }, red: { level: "critical", color: "red" },
    low: { level: "ok", color: "green" }, medium: { level: "warn", color: "amber" }, high: { level: "critical", color: "red" },
    critical: { level: "critical", color: "red" }, warn: { level: "warn", color: "amber" }, ok: { level: "ok", color: "green" },
  };
  const hit = map[v];
  if (!hit) return null;
  return {
    subject: { type: subjectType, id: subjectId },
    level: hit.level,
    color: hit.color,
    score: hit.level === "critical" ? 85 : hit.level === "warn" ? 50 : 10,
    signals: [],
    top_reasons: [],
    computed_at: new Date().toISOString(),
  };
}
