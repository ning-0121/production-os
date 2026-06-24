/**
 * Row Normalizer — converts raw Excel cells to typed entity payloads.
 *
 * Pure function. Given mapping config + raw row + import type, returns:
 *   { normalized, warnings, errors }
 *
 * Data-quality rules enforced here (per the V5-C spec):
 *   REJECT: negative output, cumulative regression (vs running max), duplicate (caller checks)
 *   WARN:   abnormal output spikes, suspicious low production, missing optional mappings
 */

import { INTERNAL_FIELDS, foldFullWidth } from "./dictionary.js";

/**
 * True when every cell of a raw row is empty/whitespace. Real factory sheets
 * carry spacer rows and footers; these must be skipped, not reported as
 * "required field missing" errors.
 */
export function isBlankRow(rawRow) {
  if (!rawRow || typeof rawRow !== "object") return true;
  return Object.values(rawRow).every((v) => v == null || String(v).trim() === "");
}

const ABNORMAL_SPIKE_MULTIPLIER = 3;     // > 3× running mean → warn
const ABNORMAL_LOW_FRACTION = 0.2;       // < 20% of running mean → warn

/**
 * @param {object} cfg
 * @param {Array<{external_header: string, internal_field: string|null}>} cfg.mappings
 * @param {Record<string, unknown>} cfg.rawRow
 * @param {string} cfg.importType
 * @param {{ running_mean?: number, running_max_cumulative?: number }} [cfg.context]
 * @returns {{ normalized: object, warnings: object[], errors: object[] }}
 */
export function normalizeRow({ mappings, rawRow, importType, context = {} }) {
  const normalized = {};
  const warnings = [];
  const errors = [];

  // 1) Pull every mapped field through type coercion
  for (const m of mappings) {
    if (!m.internal_field) continue;
    const def = INTERNAL_FIELDS[m.internal_field];
    if (!def) continue;
    const raw = rawRow[m.external_header];
    if (raw == null || raw === "") {
      if (def.required) errors.push({ code: "required_missing", field: m.internal_field, message: `必填字段 ${m.internal_field} 为空` });
      continue;
    }
    const { value, error } = coerce(raw, def.type);
    if (error) {
      errors.push({ code: "coerce_failed", field: m.internal_field, message: `${m.internal_field} 无法解析: ${String(raw).slice(0, 40)}`, raw });
      continue;
    }
    normalized[m.internal_field] = value;
  }

  // 2) Cross-field data-quality rules
  if (importType === "daily_report" || importType === "hanging_line") {
    const actual = numOrNull(normalized.actual_output);
    const cum = numOrNull(normalized.cumulative_output);

    if (actual != null && actual < 0) {
      errors.push({ code: "negative_output", field: "actual_output", message: `产量不能为负 (${actual})` });
    }

    if (cum != null && cum < 0) {
      errors.push({ code: "negative_output", field: "cumulative_output", message: `累计产量不能为负 (${cum})` });
    }

    if (cum != null && context.running_max_cumulative != null && cum < context.running_max_cumulative) {
      errors.push({
        code: "cumulative_regression",
        field: "cumulative_output",
        message: `累计产量倒退 (本次 ${cum} < 历史最大 ${context.running_max_cumulative})`,
      });
    }

    if (actual != null && context.running_mean != null && context.running_mean > 0) {
      if (actual > context.running_mean * ABNORMAL_SPIKE_MULTIPLIER) {
        warnings.push({ code: "spike", field: "actual_output", message: `产量异常激增 (${actual} > 均值 ${context.running_mean.toFixed(0)} × ${ABNORMAL_SPIKE_MULTIPLIER})` });
      } else if (actual < context.running_mean * ABNORMAL_LOW_FRACTION) {
        warnings.push({ code: "dip", field: "actual_output", message: `产量异常低 (${actual} < 均值 ${context.running_mean.toFixed(0)} × ${ABNORMAL_LOW_FRACTION})` });
      }
    }
  }

  if (importType === "qc") {
    const inspected = numOrNull(normalized.total_qty_inspected);
    const defects = numOrNull(normalized.total_defects);
    if (defects != null && inspected != null && defects > inspected) {
      errors.push({ code: "defects_exceed_inspected", field: "total_defects", message: `不良数 (${defects}) 不能大于抽检数 (${inspected})` });
    }
    if (defects != null && inspected != null && inspected > 0) {
      const rate = defects / inspected;
      if (rate > 0.3) warnings.push({ code: "high_defect_rate", field: "total_defects", message: `不良率 ${(rate * 100).toFixed(1)}% 偏高` });
    }
    // Normalize result string to enum.
    // Order matters: check "不合格" / "fail" before "合格" / "pass" because
    // "不合格" CONTAINS "合格". Same for "conditional pass".
    if (normalized.result) {
      const r = String(normalized.result).toLowerCase();
      if (r.includes("不合格") || r.includes("fail") || r === "ng" || r.includes("不良")) normalized.result = "fail";
      else if (r.includes("条件") || r.includes("conditional")) normalized.result = "conditional";
      else if (r.includes("合格") || r.includes("pass") || r === "ok") normalized.result = "pass";
      else normalized.result = "pending";
    }
  }

  if (importType === "rework") {
    const qty = numOrNull(normalized.rework_qty);
    if (qty != null && qty <= 0) {
      errors.push({ code: "invalid_rework_qty", field: "rework_qty", message: `返工数量必须 > 0` });
    }
  }

  return { normalized, warnings, errors };
}

/**
 * Build a dedup key for a normalized row. Used to detect duplicates within a
 * single import run (and against existing rows in the target table).
 */
export function dedupKey(normalized, importType) {
  if (importType === "daily_report" || importType === "hanging_line") {
    // import_type is part of the key so a daily_report and a hanging_line row
    // for the same date/line/order aren't wrongly flagged as duplicates of
    // each other within one run (they're distinct measurements).
    return [importType, normalized.date ?? "", normalized.factory_name ?? "", normalized.line_name ?? "", normalized.order_no ?? "", normalized.stage ?? ""].join("|");
  }
  if (importType === "qc") {
    return [normalized.date ?? "", normalized.order_no ?? "", normalized.inspection_type ?? ""].join("|");
  }
  if (importType === "rework") {
    return [normalized.date ?? "", normalized.order_no ?? "", normalized.rework_reason ?? ""].join("|");
  }
  return JSON.stringify(normalized);
}

// ── Type coercion ───────────────────────────────────────────

function coerce(raw, type) {
  if (raw == null || raw === "") return { value: null };
  try {
    switch (type) {
      case "number": {
        // Fold full-width digits, strip thousands separators.
        const n = Number(foldFullWidth(String(raw)).replace(/[,，]/g, "").trim());
        if (!Number.isFinite(n)) return { error: "not_a_number", raw };
        return { value: n };
      }
      case "date": {
        const d = parseExcelDate(raw);
        if (!d) return { error: "not_a_date", raw };
        return { value: d };
      }
      case "boolean": {
        const s = String(raw).trim().toLowerCase();
        if (["true", "1", "是", "y", "yes", "异常"].includes(s)) return { value: true };
        if (["false", "0", "否", "n", "no", "正常"].includes(s)) return { value: false };
        return { error: "not_a_boolean" };
      }
      case "string":
      default:
        return { value: String(raw).trim() };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "coerce_error" };
  }
}

function numOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Excel sends dates as serial numbers (days since 1899-12-30) OR as strings.
 * Try a few common formats.
 */
function parseExcelDate(raw) {
  // Excel serial number
  if (typeof raw === "number" && raw > 1 && raw < 100000) {
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const d = new Date(epoch.getTime() + raw * 86400000);
    return d.toISOString().slice(0, 10);
  }
  // Fold full-width digits/punctuation so "２０２６／５／１" parses.
  const s = foldFullWidth(String(raw)).trim();
  // ISO string
  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  // Year-first: 2026年4月15日, 2026/4/15, 2026.4.15
  const m = s.match(/^(\d{4})[年/.\-](\d{1,2})[月/.\-](\d{1,2})/);
  if (m) {
    const [, y, mo, dd] = m;
    return `${y}-${mo.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  // Day/Month-first with 4-digit year at the end: 15/04/2026, 04.15.2026.
  // Only accept when the order is UNAMBIGUOUS (one part > 12) so we never
  // silently mis-date — ambiguous like 05/06/2026 returns null (operator fixes).
  const t = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})/);
  if (t) {
    const a = Number(t[1]), b = Number(t[2]), y = t[3];
    let day, mo;
    if (a > 12 && b <= 12) { day = a; mo = b; }        // DD/MM/YYYY
    else if (b > 12 && a <= 12) { day = b; mo = a; }   // MM/DD/YYYY
    else return null;                                  // ambiguous → don't guess
    return `${y}-${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  return null;
}
