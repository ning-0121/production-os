/**
 * Canonical risk color/label mapping — frontend mirror of backend scales.js.
 *
 * The ONE place the UI translates a risk level into a color or label. Used by
 * RiskPill (React) AND by non-React contexts like vis-timeline item classes
 * where we can't render a component.
 *
 * Keep in sync with backend/src/risk-engine/scales.js.
 */

import type { RiskLevelCanonical, RiskColor } from "../../types";

export const LEVEL_LABEL: Record<RiskLevelCanonical, string> = {
  ok: "正常",
  warn: "关注",
  critical: "紧急",
};

export const LEVEL_COLOR: Record<RiskLevelCanonical, RiskColor> = {
  ok: "green",
  warn: "amber",
  critical: "red",
};

/** Hex/rgba triples per color — single source for all risk visuals. */
export const COLOR_HEX: Record<RiskColor, { fg: string; bg: string; border: string }> = {
  green: { fg: "#22c55e", bg: "rgba(34,197,94,.14)", border: "rgba(34,197,94,.4)" },
  amber: { fg: "#facc15", bg: "rgba(250,204,21,.14)", border: "rgba(250,204,21,.4)" },
  red:   { fg: "#fb7185", bg: "rgba(251,113,133,.14)", border: "rgba(251,113,133,.4)" },
};

/** Translate any legacy enum value → canonical level. Mirrors backend translateLegacy. */
export function legacyToLevel(value: string | null | undefined): RiskLevelCanonical | null {
  if (value == null) return null;
  const map: Record<string, RiskLevelCanonical> = {
    SAFE: "ok", MEDIUM: "warn", HIGH: "critical",
    on_track: "ok", falling_behind: "warn",
    green: "ok", amber: "warn", red: "critical",
    low: "ok", medium: "warn", high: "critical",
    info: "ok", critical: "critical", warn: "warn", ok: "ok",
  };
  return map[String(value).trim()] ?? null;
}

/** Convenience: legacy value → hex fg color (for vis-timeline borders etc.). */
export function legacyToColorHex(value: string | null | undefined): string {
  const level = legacyToLevel(value);
  if (!level) return COLOR_HEX.green.fg;
  return COLOR_HEX[LEVEL_COLOR[level]].fg;
}

/** Map a 0-100 score to canonical level (mirrors backend levelFromScore). */
export function levelFromScore(score: number): RiskLevelCanonical {
  const s = Math.max(0, Math.min(100, Number(score) || 0));
  if (s <= 30) return "ok";
  if (s <= 70) return "warn";
  return "critical";
}
