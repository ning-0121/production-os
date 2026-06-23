/**
 * Shopfloor Report Builders — pure. Shape a floor report into the runtime
 * event + line-state delta + (optional) task draft that feed the AI brain.
 *
 * Pure so the floor→brain mapping is fully testable without a DB. The service
 * persists the report, then calls these to derive what else must happen.
 */

const BLOCK_REASON_LABEL = {
  material_shortage: "物料短缺", machine_issue: "设备故障", labor_shortage: "人员短缺",
  quality_issue: "质量问题", waiting_instruction: "等待指令", other: "其他",
};

const BLOCK_REASON_EVENT = {
  material_shortage: "material_delayed",
  machine_issue: "factory_shutdown",     // closest disturbance type for a stopped machine
  labor_shortage: "labor_shortage",
  quality_issue: "qc_failure",
  waiting_instruction: "line_slowdown",
  other: "line_slowdown",
};

/**
 * Build the runtime_event for an OUTPUT report.
 * @param {object} wo   work order (post-update, with new completed_qty)
 * @param {object} report { output_qty, defect_qty, note, reported_by }
 */
export function outputEvent(wo, report) {
  const planned = Number(wo.planned_qty) || 0;
  const completed = Number(wo.completed_qty) || 0;
  const expectedSoFar = planned;   // line endpoint compares against plan
  const isLow = planned > 0 && Number(report.output_qty) > 0 && Number(report.output_qty) < planned * 0.2;
  return {
    event_type: "line_status_changed",
    severity: isLow ? "high" : "info",
    source: "human",
    source_ref: report.reported_by ?? "shopfloor",
    factory_id: wo.factory_id ?? null,
    line_id: wo.line_id ?? null,
    allocation_id: wo.allocation_id ?? null,
    order_id: wo.order_id ?? null,
    payload: {
      kind: "piece_output_updated",
      work_order_id: wo.id,
      output_qty: Number(report.output_qty) || 0,
      completed_qty: completed,
      planned_qty: planned,
      defect_qty: Number(report.defect_qty) || 0,
      operation: wo.operation ?? null,
    },
    reasoning: `车间报工：${wo.operation ?? "工序"} 完成 ${report.output_qty} 件（累计 ${completed}/${planned}）`,
    confidence: 0.95,
  };
}

/** Line-state delta for an output report (applied via state.upsertRuntimeLine). */
export function outputLineDelta(wo) {
  const planned = Number(wo.planned_qty) || 0;
  const completed = Number(wo.completed_qty) || 0;
  return {
    line_id: wo.line_id,
    factory_id: wo.factory_id,
    current_order_id: wo.order_id ?? null,
    current_allocation_id: wo.allocation_id ?? null,
    current_operation: wo.operation ?? null,
    runtime_status: "running",
    actual_output_today: completed,
    expected_output_today: planned,
  };
}

/**
 * Build the runtime_event for a BLOCKED report. Severity scales with reason.
 */
export function blockedEvent(wo, report) {
  const reason = report.reason ?? "other";
  const severe = reason === "material_shortage" || reason === "machine_issue";
  return {
    event_type: BLOCK_REASON_EVENT[reason] ?? "line_slowdown",
    severity: severe ? "critical" : "high",
    source: "human",
    source_ref: report.reported_by ?? "shopfloor",
    factory_id: wo.factory_id ?? null,
    line_id: wo.line_id ?? null,
    allocation_id: wo.allocation_id ?? null,
    order_id: wo.order_id ?? null,
    payload: { kind: "work_blocked", work_order_id: wo.id, reason, operation: wo.operation ?? null },
    reasoning: `车间报阻塞：${BLOCK_REASON_LABEL[reason] ?? reason}${report.note ? ` — ${report.note}` : ""}`,
    confidence: 0.95,
  };
}

/** Line-state delta for a blocked report. */
export function blockedLineDelta(wo) {
  return {
    line_id: wo.line_id,
    factory_id: wo.factory_id,
    runtime_status: "blocked",
  };
}

/**
 * Build a decision-task draft for a blocked report, IF it warrants one.
 * Returns null for low-severity blocks (e.g. waiting_instruction) — those just
 * surface as runtime events, not accountable tasks.
 */
export function blockedTaskDraft(wo, report) {
  const reason = report.reason ?? "other";
  const severe = reason === "material_shortage" || reason === "machine_issue" || reason === "quality_issue";
  if (!severe) return null;
  const category = reason === "material_shortage" ? "material"
    : reason === "quality_issue" ? "quality"
    : "production_delay";
  return {
    title: `车间阻塞：${BLOCK_REASON_LABEL[reason] ?? reason}${wo.order_id ? ` · ${wo.order_id}` : ""}`,
    description: `${wo.operation ?? "工序"} 在产线 ${wo.line_id ?? "?"} 受阻：${BLOCK_REASON_LABEL[reason] ?? reason}${report.note ? `（${report.note}）` : ""}`,
    category,
    severity: reason === "material_shortage" || reason === "machine_issue" ? "critical" : "warn",
    subject_type: wo.allocation_id ? "allocation" : wo.line_id ? "line" : "order",
    subject_id: wo.allocation_id ?? wo.line_id ?? wo.order_id ?? null,
    source_type: "runtime_event",
    source_ref: `shopfloor_block:${wo.id}`,   // idempotent: one active task per blocked WO
  };
}

/**
 * Build the runtime_event + optional qc signal for a DEFECT report.
 */
export function defectEvent(wo, report) {
  const qty = Number(report.defect_qty) || 0;
  const planned = Number(wo.planned_qty) || 0;
  const rate = planned > 0 ? (qty / planned) * 100 : 0;
  const severe = rate >= 10;
  return {
    event_type: "qc_failure",
    severity: severe ? "high" : "medium",
    source: "human",
    source_ref: report.reported_by ?? "shopfloor",
    factory_id: wo.factory_id ?? null,
    line_id: wo.line_id ?? null,
    allocation_id: wo.allocation_id ?? null,
    order_id: wo.order_id ?? null,
    payload: { kind: "defect_reported", work_order_id: wo.id, defect_qty: qty, defect_rate_pct: Math.round(rate * 10) / 10, operation: wo.operation ?? null },
    reasoning: `车间报不良：${qty} 件${rate > 0 ? `（不良率 ${Math.round(rate * 10) / 10}%）` : ""}${report.note ? ` — ${report.note}` : ""}`,
    confidence: 0.9,
  };
}

export { BLOCK_REASON_LABEL, BLOCK_REASON_EVENT };
