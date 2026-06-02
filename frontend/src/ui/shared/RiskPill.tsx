/**
 * RiskPill — the ONLY way risk should be displayed in the UI.
 *
 * Reads the canonical RiskAssessment shape. All pages use this — no more
 * ad-hoc `riskClass={...}` derivations sprinkled across components.
 *
 * Modes:
 *   <RiskPill assessment={a} />                 default pill with score
 *   <RiskPill assessment={a} compact />         tiny pill, no score
 *   <RiskPill assessment={a} showReasons />     pill + first reason inline
 *   <RiskPill assessment={a} detailed />        pill is clickable → popover
 *                                                with top_reasons + signals
 *
 * Color/label come from the shared riskColors module (single source of truth,
 * mirrors backend scales.js). legacyAssessment() builds a stub from a legacy
 * enum for pages not yet wired to /api/risk.
 */

import React from "react";
import type { RiskAssessment, RiskLevelCanonical, RiskColor } from "../../types";
import { LEVEL_LABEL, LEVEL_COLOR, COLOR_HEX, legacyToLevel } from "./riskColors";

export function RiskPill({
  assessment,
  showReasons = false,
  compact = false,
  detailed = false,
  loading = false,
}: {
  assessment?: RiskAssessment | null;
  showReasons?: boolean;
  compact?: boolean;
  detailed?: boolean;
  loading?: boolean;
}) {
  const [open, setOpen] = React.useState(false);

  if (loading) {
    return <span className="riskPill riskPill--loading" style={pillBase("green", compact, true)}>评估中</span>;
  }
  if (!assessment) {
    return <span className="riskPill riskPill--unknown" style={{ color: "var(--muted)", fontSize: compact ? 10 : 11 }}>—</span>;
  }

  const color = COLOR_HEX[assessment.color] ?? COLOR_HEX.green;
  const fontSz = compact ? 10 : 11;

  const pill = (
    <span
      className={`riskPill riskPill--${assessment.level}`}
      title={assessment.top_reasons.join("\n") || `风险评分 ${assessment.score}`}
      onClick={detailed ? (e) => { e.stopPropagation(); setOpen((v) => !v); } : undefined}
      style={{
        ...pillBase(assessment.color, compact, false),
        cursor: detailed ? "pointer" : "default",
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color.fg, display: "inline-block" }} />
      {LEVEL_LABEL[assessment.level]}
      {!compact && <span style={{ opacity: 0.65, fontSize: fontSz - 1, fontWeight: 400 }}>{Math.round(assessment.score)}</span>}
    </span>
  );

  if (!showReasons && !detailed) return pill;

  return (
    <span className="riskPillWrap" style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 6, verticalAlign: "middle" }}>
      {pill}
      {showReasons && assessment.top_reasons.length > 0 && (
        <span className="riskPillReasons" style={{ fontSize: 11, color: "var(--muted)" }}>
          {assessment.top_reasons[0]}
          {assessment.top_reasons.length > 1 && <span style={{ opacity: 0.6 }}> · +{assessment.top_reasons.length - 1}</span>}
        </span>
      )}
      {detailed && open && <RiskPopover assessment={assessment} onClose={() => setOpen(false)} />}
    </span>
  );
}

function RiskPopover({ assessment, onClose }: { assessment: RiskAssessment; onClose: () => void }) {
  const color = COLOR_HEX[assessment.color] ?? COLOR_HEX.green;
  // Close on outside click
  React.useEffect(() => {
    const h = () => onClose();
    const t = setTimeout(() => document.addEventListener("click", h), 0);
    return () => { clearTimeout(t); document.removeEventListener("click", h); };
  }, [onClose]);

  const raises = assessment.signals.filter((s) => s.direction === "raises" && s.weight > 0)
    .sort((a, b) => b.weight - a.weight);

  return (
    <div
      className="riskPopover"
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 100,
        minWidth: 280, maxWidth: 360,
        background: "#0b1220", border: `1px solid ${color.border}`, borderRadius: 8,
        boxShadow: "0 8px 24px rgba(0,0,0,.4)", padding: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: color.fg }} />
        <strong style={{ color: color.fg }}>{LEVEL_LABEL[assessment.level]}</strong>
        <span style={{ marginLeft: "auto", fontSize: 18, fontWeight: 700, color: color.fg }}>{Math.round(assessment.score)}</span>
        <span style={{ fontSize: 10, color: "var(--muted)" }}>/100</span>
      </div>

      {assessment.top_reasons.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>主要原因</div>
          {assessment.top_reasons.map((r, i) => (
            <div key={i} style={{ fontSize: 12, color: "var(--text)", marginBottom: 2 }}>• {r}</div>
          ))}
        </div>
      )}

      {raises.length > 0 && (
        <div>
          <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>风险信号 ({raises.length})</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {raises.slice(0, 8).map((s, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11 }}>
                <span style={{ color: "var(--muted)" }}>{s.reason}</span>
                <span style={{ color: color.fg, fontWeight: 600, flexShrink: 0 }}>+{Math.round(s.weight)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: 8, paddingTop: 6, borderTop: "1px solid rgba(255,255,255,.08)", fontSize: 9, color: "var(--muted)" }}>
        {new Date(assessment.computed_at).toLocaleString()}
      </div>
    </div>
  );
}

function pillBase(colorName: RiskColor, compact: boolean, muted: boolean): React.CSSProperties {
  const c = COLOR_HEX[colorName] ?? COLOR_HEX.green;
  return {
    background: muted ? "rgba(255,255,255,.05)" : c.bg,
    color: muted ? "var(--muted)" : c.fg,
    border: `1px solid ${muted ? "rgba(255,255,255,.1)" : c.border}`,
    borderRadius: 4,
    padding: compact ? "2px 6px" : "3px 10px",
    fontSize: compact ? 10 : 11,
    fontWeight: 600,
    letterSpacing: "0.3px",
    whiteSpace: "nowrap",
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
  };
}

/**
 * Build a stub RiskAssessment from a legacy enum for pages not yet wired to
 * /api/risk. New code MUST use a real assessment from the engine.
 */
export function legacyAssessment(
  legacyValue: string | null | undefined,
  subjectType: RiskAssessment["subject"]["type"] = "order",
  subjectId = "_legacy_",
): RiskAssessment | null {
  const level = legacyToLevel(legacyValue);
  if (!level) return null;
  return {
    subject: { type: subjectType, id: subjectId },
    level,
    color: LEVEL_COLOR[level],
    score: level === "critical" ? 85 : level === "warn" ? 50 : 10,
    signals: [],
    top_reasons: [],
    computed_at: new Date().toISOString(),
  };
}

// Re-export for convenience
export type { RiskLevelCanonical };
