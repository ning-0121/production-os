/**
 * Auto Task Generation — I/O orchestrator.
 *
 * Loads persisted risk sources, computes which already have active tasks
 * (so we don't duplicate), runs the pure rules, and creates the new tasks
 * via the idempotent createTask service.
 *
 * Cron-callable. Safe to re-run — createTask is idempotent on source_ref and
 * we pre-filter against existing active tasks as well (double safety).
 */

import { deriveAllTasks } from "./auto-rules.js";
import { createTask } from "./service.js";

const EVENT_LOOKBACK_HOURS = 48;
const QC_LOOKBACK_DAYS = 7;

/**
 * @param {object} supabase
 * @param {object} [opts]  { now?: Date, actor?: string, request_id?: string }
 * @returns {{ created: number, skipped: number, drafts: number, by_source: object, tasks: object[] }}
 */
export async function autoGenerateTasks(supabase, opts = {}) {
  const now = opts.now ?? new Date();
  const eventSince = new Date(now.getTime() - EVENT_LOOKBACK_HOURS * 3600 * 1000).toISOString();
  const qcSince = new Date(now.getTime() - QC_LOOKBACK_DAYS * 86400 * 1000).toISOString();

  // 1. Load persisted risk sources in parallel
  const [eventsRes, incidentsRes, correctionsRes, qcRes] = await Promise.all([
    supabase.from("runtime_events")
      .select("id, event_type, severity, factory_id, line_id, allocation_id, order_id, reasoning, confidence, occurred_at")
      .in("severity", ["critical", "high"])
      .gte("occurred_at", eventSince),
    supabase.from("incidents")
      .select("id, incident_type, severity, factory_id, order_id, description, status")
      .in("status", ["open", "investigating"]),
    supabase.from("order_corrections")
      .select("allocation_id, order_id, risk_status, deviation_pct, estimated_end_date")
      .eq("risk_status", "critical"),
    supabase.from("qc_inspections")
      .select("id, order_id, factory_id, inspection_type, result, total_defects, total_qty_inspected, defect_rate_pct, created_at")
      .eq("result", "fail")
      .gte("created_at", qcSince),
  ]);

  // Tolerate a missing table (e.g. migration not yet applied) — log + continue.
  const sources = {
    events: warnOrData("runtime_events", eventsRes),
    incidents: warnOrData("incidents", incidentsRes),
    corrections: warnOrData("order_corrections", correctionsRes),
    inspections: warnOrData("qc_inspections", qcRes),
  };

  // 2. Which source_refs already have an active task?
  const { data: activeTasks } = await supabase
    .from("decision_tasks")
    .select("source_ref")
    .not("status", "in", "(resolved,dismissed)")
    .not("source_ref", "is", null);
  const taskedRefs = new Set((activeTasks ?? []).map((t) => t.source_ref));

  // 3. Pure derivation
  const drafts = deriveAllTasks(sources, taskedRefs);

  // 4. Create (idempotent). Group outcome by source_type.
  const bySource = {};
  const createdTasks = [];
  let created = 0, skipped = 0;
  for (const draft of drafts) {
    bySource[draft.source_type] = bySource[draft.source_type] ?? { created: 0, skipped: 0 };
    try {
      const result = await createTask(supabase, {
        ...draft,
        created_by: opts.actor ?? "auto-generator",
        request_id: opts.request_id ?? null,
      });
      if (result.created) { created++; bySource[draft.source_type].created++; createdTasks.push(result.task); }
      else { skipped++; bySource[draft.source_type].skipped++; }
    } catch (err) {
      // 23505 race = already created concurrently; treat as skip
      skipped++; bySource[draft.source_type].skipped++;
      if (err?.code !== "23505") console.error("[auto-generate] create failed:", err?.message ?? err);
    }
  }

  return {
    created,
    skipped,
    drafts: drafts.length,
    by_source: bySource,
    tasks: createdTasks,
    scanned: {
      events: sources.events.length,
      incidents: sources.incidents.length,
      corrections: sources.corrections.length,
      inspections: sources.inspections.length,
    },
  };
}

function warnOrData(name, res) {
  if (res?.error) {
    console.error(JSON.stringify({ level: "WARN", source: "auto-generate", table: name, error: res.error.message }));
    return [];
  }
  return res?.data ?? [];
}
