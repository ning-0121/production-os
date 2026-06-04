/**
 * Retrospective I/O — load all source rows ONCE, in parallel (no N+1), then
 * hand the bundle to the pure aggregator.
 *
 * Loads 2×window of time-bounded data so the aggregator can compute
 * week-over-week trends without a second round trip. Tolerates a missing table
 * (returns []) so the dashboard works even before every migration is applied.
 */

import { aggregate } from "./aggregate.js";
import { generateInsights } from "./insights.js";

export function parseWindow(windowStr) {
  const m = String(windowStr ?? "7d").match(/^(\d+)d$/);
  const days = m ? Math.min(180, Math.max(1, Number(m[1]))) : 7;
  return days;
}

/**
 * Load + aggregate. Returns the full aggregate plus insights.
 * @param {object} supabase
 * @param {object} opts  { window?: "7d"|"30d", now?: Date }
 */
export async function loadRetrospective(supabase, opts = {}) {
  const windowDays = parseWindow(opts.window);
  const now = opts.now ?? new Date();
  // Load 2×window for trend comparison, plus a small buffer.
  const sinceIso = new Date(now.getTime() - 2 * windowDays * 86400000).toISOString();
  const sinceDate = sinceIso.slice(0, 10);

  const [
    tasksRes, retroRes, incidentsRes, eventsRes, qcRes, reworkRes, corrRes,
    factoriesRes, linesRes, cronRes, aiLogsRes,
  ] = await Promise.all([
    supabase.from("decision_tasks").select("*").gte("created_at", sinceIso),
    supabase.from("retrospectives").select("*").gte("created_at", sinceIso),
    supabase.from("incidents").select("id, incident_type, severity, factory_id, order_id, status, created_at").gte("created_at", sinceIso),
    supabase.from("runtime_events").select("id, event_type, severity, factory_id, line_id, order_id, occurred_at").gte("occurred_at", sinceIso),
    supabase.from("qc_inspections").select("id, factory_id, order_id, result, defect_rate_pct, created_at").gte("created_at", sinceIso),
    supabase.from("rework_orders").select("id, factory_id, order_id, status, created_at").gte("created_at", sinceIso),
    supabase.from("order_corrections").select("allocation_id, factory_id, order_id, risk_status, computed_at, created_at").gte("created_at", sinceIso),
    supabase.from("factories").select("id, name"),
    supabase.from("production_lines").select("id, name, factory_id"),
    supabase.from("cron_runs").select("id, job_name, status, started_at, generated_count, escalated_count, notified_count, failed_count").gte("started_at", sinceIso),
    supabase.from("ai_action_logs").select("id, agent, status, created_at").gte("created_at", sinceDate),
  ]);

  const bundle = {
    tasks: safe("decision_tasks", tasksRes),
    retrospectives: safe("retrospectives", retroRes),
    incidents: safe("incidents", incidentsRes),
    runtimeEvents: safe("runtime_events", eventsRes),
    qcInspections: safe("qc_inspections", qcRes),
    reworks: safe("rework_orders", reworkRes),
    corrections: safe("order_corrections", corrRes),
    factories: safe("factories", factoriesRes),
    lines: safe("production_lines", linesRes),
    cronRuns: safe("cron_runs", cronRes),
    aiActionLogs: safe("ai_action_logs", aiLogsRes),
  };

  const agg = aggregate(bundle, { now, windowDays });
  const insights = generateInsights(agg);
  return { ...agg, insights, cron_health: cronHealth(bundle.cronRuns) };
}

function safe(name, res) {
  if (res?.error) {
    console.error(JSON.stringify({ level: "WARN", source: "retrospective", table: name, error: res.error.message }));
    return [];
  }
  return res?.data ?? [];
}

function cronHealth(runs) {
  const list = Array.isArray(runs) ? runs : [];
  const last = [...list].sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))[0] ?? null;
  return {
    runs: list.length,
    failed_runs: list.filter((r) => r.status === "failed").length,
    last_run_at: last?.started_at ?? null,
    last_status: last?.status ?? null,
  };
}
