/**
 * Admin — /api/admin/*  (V7.5 observability + recoverability)
 *
 * Operational Health dashboard + Failure Recovery tools. Mounted behind the
 * normal JWT auth middleware. Recovery actions default to DRY RUN and always
 * write a pilot_audit_log entry.
 *
 *   GET  /api/admin/health              full system-health snapshot (8 sections)
 *   POST /api/admin/recovery/:tool      run a recovery tool { dry_run?: true }
 *
 * Recovery tools: rebuild-runtime, replay-runtime-events, recalculate-risks,
 * regenerate-tasks, recompute-learning, rebuild-decision-intel.
 *
 * Nothing here adds business behavior — it only observes and repairs the
 * existing engines.
 */

import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { auditLog } from "../governance/audit.js";
import { replay } from "../runtime/events.js";
import { computeRisk } from "../runtime/scheduler.js";
import { listRuntimeLines, upsertRuntimeLine } from "../runtime/state.js";
import { autoGenerateTasks } from "../execution/auto-generate.js";
import { recomputeLearning } from "../decision-engine/learning-io.js";
import { loadIntelligence } from "../decision-intel/io.js";

const router = Router();

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const now = () => Date.now();
const ageMs = (ts) => (ts ? now() - new Date(ts).getTime() : Infinity);

// Worst-of helper for rolling up a section status.
const RANK = { green: 0, yellow: 1, red: 2 };
const worst = (...xs) => xs.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "green");

async function count(table, build = (q) => q) {
  const { count: c, error } = await build(supabase.from(table).select("*", { count: "exact", head: true }));
  if (error) throw error;
  return c ?? 0;
}
async function latest(table, orderCol, select = "*") {
  const { data } = await supabase.from(table).select(select).order(orderCol, { ascending: false }).limit(1);
  return data?.[0] ?? null;
}

// ── GET /api/admin/health ────────────────────────────────────
router.get("/health", asyncHandler(async (_req, res) => {
  const sections = [];
  const section = (key, label, status, metrics, note) => sections.push({ key, label, status, metrics, note });

  // 1) Database
  let dbOk = true, dbErr = null;
  try { await supabase.from("factories").select("id").limit(1); }
  catch (err) { dbOk = false; dbErr = err.message; }
  section("database", "Database", dbOk ? "green" : "red", { reachable: dbOk }, dbErr ?? "PostgREST reachable");

  // 2) Realtime — same Supabase project; we report config presence (backend can't open a socket cheaply).
  const realtimeConfigured = !!process.env.SUPABASE_URL;
  section("realtime", "Realtime", realtimeConfigured ? "green" : "red",
    { configured: realtimeConfigured }, realtimeConfigured ? "Supabase Realtime project configured" : "SUPABASE_URL missing");

  // 3) Cron
  const lastCron = await latest("cron_runs", "started_at", "job_name, status, started_at, finished_at, failed_count");
  const failedJobs24h = await count("cron_runs", (q) => q.eq("status", "failed").gte("started_at", new Date(now() - 24 * HOUR).toISOString()));
  let cronStatus = "red";
  if (lastCron) {
    const age = ageMs(lastCron.started_at);
    if (lastCron.status === "failed") cronStatus = "red";
    else if (age < 2 * HOUR) cronStatus = "green";
    else if (age < 26 * HOUR) cronStatus = "yellow";
    else cronStatus = "red";
  }
  section("cron", "Cron", worst(cronStatus, failedJobs24h > 0 ? "yellow" : "green"), {
    last_run: lastCron?.started_at ?? null, last_status: lastCron?.status ?? "never",
    failed_jobs_24h: failedJobs24h,
  }, lastCron ? `last ${lastCron.job_name} ${lastCron.status}` : "no cron runs recorded yet");

  // 4) Notifications
  const lastNotif = await latest("notification_events", "created_at", "created_at, delivery_status");
  const failedDeliveries = await count("notification_events", (q) => q.eq("delivery_status", "failed"));
  let notifStatus = lastNotif ? "green" : "yellow";
  if (failedDeliveries > 0) notifStatus = worst(notifStatus, "yellow");
  section("notifications", "Notifications", notifStatus, {
    last_notification: lastNotif?.created_at ?? null, failed_deliveries: failedDeliveries,
  }, lastNotif ? "delivering" : "none sent yet");

  // 5) Runtime
  const totalLines = await count("production_runtime_lines");
  const downLines = await count("production_runtime_lines", (q) => q.eq("runtime_status", "down"));
  const pendingProp = await count("runtime_events", (q) => q.eq("propagation_status", "pending"));
  const activeEvents = await count("runtime_events", (q) => q.in("severity", ["critical", "high"]).gte("occurred_at", new Date(now() - 24 * HOUR).toISOString()));
  let rtStatus = "green";
  if (downLines > 0) rtStatus = "red";
  else if (pendingProp > 20) rtStatus = "yellow";
  section("runtime", "Runtime", rtStatus, {
    runtime_lines: totalLines, lines_down: downLines, pending_propagation: pendingProp, active_events_24h: activeEvents,
  }, downLines > 0 ? `${downLines} line(s) down` : "stable");

  // 6) Decision Engine
  const decisions7d = await count("decision_assessments", (q) => q.gte("computed_at", new Date(now() - 7 * 24 * HOUR).toISOString()));
  const lastLearn = await latest("decision_learning", "recomputed_at", "recomputed_at");
  section("decision_engine", "Decision Engine", decisions7d > 0 ? "green" : "yellow", {
    evaluations_7d: decisions7d, last_learning_recompute: lastLearn?.recomputed_at ?? null,
  }, decisions7d > 0 ? "evaluating" : "no recent evaluations");

  // 7) Import Gateway
  const lastImport = await latest("import_runs", "started_at", "status, started_at");
  const failedImports24h = await count("import_runs", (q) => q.eq("status", "failed").gte("started_at", new Date(now() - 24 * HOUR).toISOString()));
  let impStatus = "green";
  if (failedImports24h > 0) impStatus = "yellow";
  section("import_gateway", "Import Gateway", impStatus, {
    last_import: lastImport?.started_at ?? null, last_status: lastImport?.status ?? "never", failed_imports_24h: failedImports24h,
  }, lastImport ? `last import ${lastImport.status}` : "no imports yet");

  // 8) Shopfloor
  const openWO = await count("shopfloor_work_orders", (q) => q.not("status", "in", "(completed,cancelled)"));
  const blockedWO = await count("shopfloor_work_orders", (q) => q.eq("status", "blocked"));
  section("shopfloor", "Shopfloor", blockedWO > 0 ? "yellow" : "green", {
    open_work_orders: openWO, blocked_work_orders: blockedWO,
  }, blockedWO > 0 ? `${blockedWO} blocked` : "flowing");

  // Cross-cutting metric the brief calls out explicitly.
  const pendingTasks = await count("decision_tasks", (q) => q.not("status", "in", "(resolved,dismissed)"));

  const overall = worst(...sections.map((s) => s.status));
  res.json({
    generated_at: new Date().toISOString(),
    overall,
    pending_tasks: pendingTasks,
    sections,
  });
}));

// ── POST /api/admin/recovery/:tool ───────────────────────────

const TOOLS = {
  "rebuild-runtime": rebuildRuntime,
  "replay-runtime-events": replayRuntimeEvents,
  "recalculate-risks": recalculateRisks,
  "regenerate-tasks": regenerateTasks,
  "recompute-learning": recomputeLearningTool,
  "rebuild-decision-intel": rebuildDecisionIntel,
};

router.post("/recovery/:tool", asyncHandler(async (req, res) => {
  const tool = req.params.tool;
  const fn = TOOLS[tool];
  if (!fn) return res.status(404).json({ error: `unknown recovery tool: ${tool}`, available: Object.keys(TOOLS) });

  const dryRun = req.body?.dry_run !== false; // default TRUE — must opt in to apply
  const actor = req.pilotIdentity?.operator ?? "admin";

  let result, status = "success";
  try {
    result = await fn({ dryRun, actor });
  } catch (err) {
    status = "failed";
    auditLog({ action: `recovery.${tool}`, category: "system", result_status: "failed", req, error_code: "recovery_error", detail: { dry_run: dryRun, error: err.message } });
    return res.status(500).json({ tool, dry_run: dryRun, ok: false, error: err.message });
  }

  auditLog({ action: `recovery.${tool}`, category: "system", result_status: status, req, detail: { dry_run: dryRun, ...result } });
  res.json({ tool, dry_run: dryRun, ok: true, ...result });
}));

// ── Recovery tool implementations ────────────────────────────

/** Recompute runtime_risk for every line from its current fields. */
async function rebuildRuntime({ dryRun, actor }) {
  const lines = await listRuntimeLines(supabase, {});
  let changed = 0;
  const changes = [];
  for (const l of lines) {
    const newRisk = computeRisk(l);
    if (newRisk !== l.runtime_risk) {
      changed++;
      changes.push({ line_id: l.line_id, from: l.runtime_risk, to: newRisk });
      if (!dryRun) await upsertRuntimeLine(supabase, { line_id: l.line_id, runtime_risk: newRisk }, { actor });
    }
  }
  return { lines_examined: lines.length, lines_changed: changed, sample: changes.slice(0, 20) };
}

/** Replay persisted runtime_events to derive line states; optionally persist drift. */
async function replayRuntimeEvents({ dryRun, actor }) {
  const { data: events } = await supabase.from("runtime_events")
    .select("replay_seq, event_type, severity, line_id, factory_id, occurred_at, payload")
    .order("replay_seq", { ascending: true }).limit(20000);
  const lines = await listRuntimeLines(supabase, {});
  const result = replay(events ?? [], { lines });

  let persisted = 0;
  if (!dryRun) {
    for (const l of result.final_state.lines) {
      if (!l.line_id) continue;
      await upsertRuntimeLine(supabase, {
        line_id: l.line_id, runtime_status: l.runtime_status, runtime_risk: l.runtime_risk,
        current_efficiency: l.current_efficiency, overload_pct: l.overload_pct,
      }, { actor });
      persisted++;
    }
  }
  return {
    events_processed: result.summary.events_processed,
    events_unhandled: result.summary.events_unhandled,
    lines_derived: result.final_state.lines.length,
    lines_persisted: persisted,
  };
}

/** Recompute risk classification across all runtime lines (risk is computed on-read). */
async function recalculateRisks() {
  const lines = await listRuntimeLines(supabase, {});
  const dist = { green: 0, amber: 0, red: 0 };
  for (const l of lines) {
    const risk = computeRisk(l);
    dist[risk] = (dist[risk] ?? 0) + 1;
  }
  return { subjects: lines.length, distribution: dist, note: "risk is computed on-demand; this validates classification across all lines" };
}

/** Auto-generate tasks from persisted risk sources. */
async function regenerateTasks({ dryRun, actor }) {
  if (dryRun) {
    const since = new Date(now() - 48 * HOUR).toISOString();
    const events = await count("runtime_events", (q) => q.in("severity", ["critical", "high"]).gte("occurred_at", since));
    const incidents = await count("incidents", (q) => q.in("status", ["open", "investigating"]));
    const qc = await count("qc_inspections", (q) => q.eq("result", "fail"));
    return { preview: true, candidate_sources: { runtime_events: events, incidents, qc_failures: qc }, note: "dry run — no tasks created" };
  }
  const r = await autoGenerateTasks(supabase, { actor });
  return { created: r.created, skipped: r.skipped, by_source: r.by_source };
}

/** Recompute bounded decision-learning adjustments. */
async function recomputeLearningTool({ dryRun }) {
  if (dryRun) {
    const logs = await count("decision_logs");
    const feedback = await count("decision_option_feedback");
    return { preview: true, inputs: { decision_logs: logs, feedback }, note: "dry run — learning not modified" };
  }
  const r = await recomputeLearning(supabase, { now: new Date() });
  return { updated: r.updated };
}

/** Decision Intelligence is computed on-read; this recomputes + returns a summary. */
async function rebuildDecisionIntel() {
  const intel = await loadIntelligence(supabase, {});
  return {
    note: "decision intelligence is derived on-read; recomputed snapshot returned",
    decisions: intel?.summary?.total_decisions ?? intel?.summary?.evaluated ?? null,
    feedback_total: intel?.feedback?.total_feedback ?? null,
    learned_adjustments: Array.isArray(intel?.learning) ? intel.learning.length : (intel?.learning?.adjustments?.length ?? null),
  };
}

export default router;
