/**
 * Column Recognition Dictionary — first-pass deterministic mapping.
 *
 * Maps factory Excel headers (Chinese + English variants) to internal fields.
 * Used by recognizer.js. Database-learned mappings in `import_field_mappings`
 * are merged on top for tenant-specific overrides.
 *
 * Each internal field has:
 *   patterns:      array of substrings/regex that match external headers
 *   required:      true if missing field rejects the row entirely
 *   types:         expected JS type for normalization
 *   import_types:  which import types this field applies to
 */

/**
 * Internal field catalog. Keep this in sync with `normalizer.js` and the
 * target tables (daily_production_reports, qc_inspections, rework_orders).
 */
export const INTERNAL_FIELDS = {
  // ── Common / shared ─────────────────────────────────────
  date:           { patterns: ["日期", "date", "报工日期", "生产日期", "production date", "report date"], required: true, type: "date" },
  factory_name:   { patterns: ["工厂", "厂", "factory", "plant"], required: false, type: "string" },
  line_name:      { patterns: ["产线", "车间", "线", "line", "production line", "工序线"], required: false, type: "string" },
  order_no:       { patterns: ["订单号", "订单", "工单号", "工单", "po", "po no", "po number", "order no", "order number", "款号", "style", "style no"], required: false, type: "string" },
  product_type:   { patterns: ["品类", "产品类型", "product type", "product", "类别", "款式"], required: false, type: "string" },
  operator:       { patterns: ["报工人", "操作员", "员工", "operator", "worker", "员工编号"], required: false, type: "string" },
  shift:          { patterns: ["班次", "shift", "早班", "夜班"], required: false, type: "string" },
  note:           { patterns: ["备注", "note", "remark", "remarks", "说明", "comment"], required: false, type: "string" },

  // ── Daily production report ─────────────────────────────
  planned_output:   { patterns: ["计划产量", "planned output", "planned qty", "计划", "目标产量", "target"], required: false, type: "number" },
  actual_output:    { patterns: ["今日产量", "日产量", "实际产量", "actual output", "actual qty", "qty today", "today output", "产量"], required: true, type: "number" },
  cumulative_output:{ patterns: ["累计", "累计产量", "cumulative", "cum qty", "累计完工", "累计完成"], required: false, type: "number" },
  stage:            { patterns: ["工序", "stage", "operation", "前道", "后道", "缝制", "包装", "整烫"], required: false, type: "string" },
  is_abnormal:      { patterns: ["异常", "abnormal", "异常标记", "是否异常"], required: false, type: "boolean" },
  abnormal_reason:  { patterns: ["异常原因", "abnormal reason", "原因", "reason"], required: false, type: "string" },

  // ── Hanging-line export specific ────────────────────────
  pieces_per_hour:  { patterns: ["小时产量", "件/小时", "pieces per hour", "pph", "efficiency"], required: false, type: "number" },
  operation_code:   { patterns: ["工序号", "工序代码", "operation code", "op code"], required: false, type: "string" },

  // ── QC inspection ───────────────────────────────────────
  inspection_type:  { patterns: ["验货类型", "验货", "inspection type", "qc type", "样品类型"], required: false, type: "string" },
  total_qty_inspected: { patterns: ["抽检数量", "抽检", "inspected qty", "sample size", "check qty"], required: false, type: "number" },
  total_defects:    { patterns: ["不良数", "不合格数", "缺陷数", "defects", "defect qty", "ng qty", "不良品"], required: false, type: "number" },
  result:           { patterns: ["结果", "验货结果", "result", "qc result", "判定"], required: false, type: "string" },
  defect_code:      { patterns: ["缺陷代码", "不良代码", "defect code", "ng code"], required: false, type: "string" },
  severity:         { patterns: ["严重度", "等级", "severity", "level"], required: false, type: "string" },

  // ── Rework ──────────────────────────────────────────────
  rework_qty:       { patterns: ["返工数量", "返工数", "rework qty", "rework count"], required: false, type: "number" },
  rework_reason:    { patterns: ["返工原因", "rework reason"], required: false, type: "string" },
  responsible_party:{ patterns: ["责任方", "责任部门", "responsible", "responsible party"], required: false, type: "string" },
  estimated_days:   { patterns: ["预计天数", "estimated days", "est days"], required: false, type: "number" },
  cost:             { patterns: ["成本", "cost", "返工成本"], required: false, type: "number" },
};

/**
 * Field sets per import type — used to constrain which fields the recognizer
 * even considers for a given upload.
 */
export const FIELDS_PER_TYPE = {
  daily_report: [
    "date", "factory_name", "line_name", "order_no", "product_type",
    "planned_output", "actual_output", "cumulative_output", "stage",
    "is_abnormal", "abnormal_reason", "operator", "shift", "note",
  ],
  hanging_line: [
    "date", "factory_name", "line_name", "order_no", "operation_code",
    "actual_output", "pieces_per_hour", "operator", "shift", "note",
  ],
  qc: [
    "date", "factory_name", "order_no", "inspection_type",
    "total_qty_inspected", "total_defects", "result",
    "defect_code", "severity", "note",
  ],
  rework: [
    "date", "factory_name", "order_no", "rework_qty", "rework_reason",
    "responsible_party", "estimated_days", "cost", "note",
  ],
  generic: Object.keys(INTERNAL_FIELDS),
};

/**
 * Header signatures used to AUTO-DETECT import type from a workbook.
 * The type with the most matches wins.
 */
export const TYPE_SIGNATURES = {
  daily_report: ["今日产量", "日产量", "actual output", "累计", "actual qty"],
  hanging_line: ["小时产量", "工序号", "pieces per hour", "operation code", "pph"],
  qc:           ["验货", "抽检", "不良数", "缺陷代码", "inspection", "defect"],
  rework:       ["返工", "rework", "rework qty", "返工原因"],
};

/**
 * Normalize an external header for matching: lowercase + trim + strip
 * punctuation. The same normalization is applied to dictionary patterns.
 */
export function normalizeHeader(s) {
  if (s == null) return "";
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/[（）()【】\[\]:：、，,\s\-_/\\.]+/g, "");
}

/**
 * Score how well an external header matches an internal field. 0..1.
 * Exact match = 1.0; substring contains a pattern = 0.85; pattern contains
 * the header = 0.7; no match = 0.
 */
export function matchScore(externalHeader, internalField) {
  const def = INTERNAL_FIELDS[internalField];
  if (!def) return 0;
  const eh = normalizeHeader(externalHeader);
  if (!eh) return 0;
  let best = 0;
  for (const p of def.patterns) {
    const np = normalizeHeader(p);
    if (!np) continue;
    if (eh === np) return 1.0;
    if (eh.includes(np) && np.length >= 2) best = Math.max(best, 0.85);
    else if (np.includes(eh) && eh.length >= 2) best = Math.max(best, 0.7);
  }
  return best;
}
