/**
 * Auto Task Generation Rules — pure. Convert persisted risk sources into
 * decision-task drafts. No I/O, no clock side-effects (now injected).
 *
 * Each derive* function takes raw source rows + the set of source_refs that
 * already have an ACTIVE task, and returns task drafts for the ones that don't.
 * The drafts feed createTask() which is itself idempotent — double safety.
 *
 * source_ref is the dedup anchor. Format per source so a recurrence after a
 * task closes can open a fresh task, but an open one is never duplicated.
 *
 * DISCIPLINE: this module only PROPOSES tasks. It never resolves or mutates
 * anything. Humans still claim + own.
 */

import { translateLegacy } from "../risk-engine/scales.js";

// ── runtime_events → tasks ──────────────────────────────
// Only critical disturbance events become tasks automatically. Operational /
// scheduler events (reschedule_applied, simulation_run, etc.) are noise here.

const EVENT_TASKABLE = new Set([
  "material_delayed", "line_slowdown", "rework_started", "qc_failure",
  "factory_shutdown", "labor_shortage", "shipment_risk",
]);

const EVENT_CATEGORY = {
  material_delayed: "material",
  line_slowdown: "production_delay",
  rework_started: "quality",
  qc_failure: "quality",
  factory_shutdown: "production_delay",
  labor_shortage: "capacity",
  shipment_risk: "shipment",
};

const EVENT_LABEL = {
  material_delayed: "物料延迟", line_slowdown: "产线减速", rework_started: "返工开始",
  qc_failure: "质量异常", factory_shutdown: "工厂停产", labor_shortage: "人员短缺",
  shipment_risk: "出货风险",
};

/**
 * @param {object[]} events    runtime_events rows
 * @param {Set<string>} taskedRefs   source_refs already having an active task
 * @returns {object[]} task drafts
 */
export function deriveTasksFromEvents(events, taskedRefs = new Set()) {
  const drafts = [];
  for (const e of events ?? []) {
    if (!EVENT_TASKABLE.has(e.event_type)) continue;
    // Auto-create only for the most severe; medium/low stay informational.
    if (e.severity !== "critical" && e.severity !== "high") continue;
    const ref = `runtime_event:${e.id}`;
    if (taskedRefs.has(ref)) continue;

    drafts.push({
      title: `${EVENT_LABEL[e.event_type] ?? e.event_type}${e.order_id ? ` · ${e.order_id}` : ""}`,
      description: e.reasoning ?? `运行时事件 ${e.event_type}`,
      category: EVENT_CATEGORY[e.event_type] ?? "general",
      // Canonical mapping (high → critical), consistent with risk display everywhere
      severity: translateLegacy(e.severity) ?? "warn",
      subject_type: e.allocation_id ? "allocation" : e.line_id ? "line" : e.order_id ? "order" : e.factory_id ? "factory" : null,
      subject_id: e.allocation_id ?? e.line_id ?? e.order_id ?? e.factory_id ?? null,
      source_type: "runtime_event",
      source_ref: ref,
      ai_recommended_action: e.reasoning ?? null,
      ai_confidence: e.confidence ?? null,
    });
  }
  return drafts;
}

// ── incidents → tasks ───────────────────────────────────

const INCIDENT_CATEGORY = {
  factory_shutdown: "production_delay",
  material_delay: "material",
  quality_issue: "quality",
  rush_order: "shipment",
  equipment_failure: "production_delay",
};

export function deriveTasksFromIncidents(incidents, taskedRefs = new Set()) {
  const drafts = [];
  for (const inc of incidents ?? []) {
    if (inc.status !== "open" && inc.status !== "investigating") continue;
    const level = translateLegacy(inc.severity) ?? "warn";
    if (level !== "critical" && level !== "warn") continue;
    // Only high/critical incidents auto-task
    if (inc.severity !== "critical" && inc.severity !== "high") continue;
    const ref = `incident:${inc.id}`;
    if (taskedRefs.has(ref)) continue;

    drafts.push({
      title: `生产事件：${inc.description?.slice(0, 60) ?? inc.incident_type}`,
      description: inc.description ?? null,
      category: INCIDENT_CATEGORY[inc.incident_type] ?? "general",
      severity: level,
      subject_type: inc.order_id ? "order" : inc.factory_id ? "factory" : null,
      subject_id: inc.order_id ?? inc.factory_id ?? null,
      source_type: "incident",
      source_ref: ref,
    });
  }
  return drafts;
}

// ── order_corrections → tasks ───────────────────────────

export function deriveTasksFromCorrections(corrections, taskedRefs = new Set()) {
  const drafts = [];
  for (const c of corrections ?? []) {
    const level = translateLegacy(c.risk_status) ?? "ok";
    if (level !== "critical") continue;   // only critical deviations auto-task
    const ref = `correction:${c.allocation_id}`;
    if (taskedRefs.has(ref)) continue;

    drafts.push({
      title: `进度严重偏离${c.order_id ? ` · ${c.order_id}` : ""}（${c.deviation_pct}%）`,
      description: `订单进度偏离计划 ${c.deviation_pct}%，预计完成 ${c.estimated_end_date ?? "未知"}`,
      category: "production_delay",
      severity: "critical",
      subject_type: "allocation",
      subject_id: c.allocation_id,
      source_type: "risk",
      source_ref: ref,
    });
  }
  return drafts;
}

// ── qc_inspections (failed) → tasks ─────────────────────

export function deriveTasksFromQc(inspections, taskedRefs = new Set()) {
  const drafts = [];
  for (const q of inspections ?? []) {
    if (q.result !== "fail") continue;
    const ref = `qc:${q.id}`;
    if (taskedRefs.has(ref)) continue;
    const rate = Number(q.defect_rate_pct ?? 0);
    const severity = rate >= 10 ? "critical" : "warn";

    drafts.push({
      title: `验货不合格${q.order_id ? ` · ${q.order_id}` : ""}（不良率 ${rate}%）`,
      description: `${q.inspection_type ?? "验货"} 不合格，不良 ${q.total_defects}/${q.total_qty_inspected}`,
      category: "quality",
      severity,
      subject_type: q.order_id ? "order" : q.factory_id ? "factory" : null,
      subject_id: q.order_id ?? q.factory_id ?? null,
      source_type: "qc_failure",
      source_ref: ref,
    });
  }
  return drafts;
}

/**
 * Combine all source derivations into one draft list.
 * @param {object} sources  { events, incidents, corrections, inspections }
 * @param {Set<string>} taskedRefs
 */
export function deriveAllTasks(sources, taskedRefs = new Set()) {
  return [
    ...deriveTasksFromEvents(sources.events, taskedRefs),
    ...deriveTasksFromIncidents(sources.incidents, taskedRefs),
    ...deriveTasksFromCorrections(sources.corrections, taskedRefs),
    ...deriveTasksFromQc(sources.inspections, taskedRefs),
  ];
}
