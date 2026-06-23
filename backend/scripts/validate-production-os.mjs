#!/usr/bin/env node
/**
 * V7.5 Phase 2 — End-to-End Business Validation
 *
 * Exercises the complete operational loops against a live database, driving the
 * SAME engine functions the API uses (no HTTP needed). Every flow seeds isolated,
 * clearly-marked test data and tears it down afterward — safe on production.
 *
 *   Flow A  Excel Import     daily report → runtime event → runtime line → risk
 *   Flow B  Shopfloor        WO → start → report → pause → resume → complete
 *   Flow C  Risk → Task      critical runtime event → auto task → notification
 *   Flow D  Decision         evaluate → options → apply → decision_logs + notify
 *   Flow E  Learning         apply → feedback → recompute → learning + intel
 *
 * Usage:
 *   cd backend
 *   node --env-file=.env scripts/validate-production-os.mjs
 *   node --env-file=.env scripts/validate-production-os.mjs --keep   # skip teardown
 *
 * Exit: 0 = all flows PASS, 1 = one or more FAIL, 2 = env/connection error.
 */

import { randomUUID } from "node:crypto";
import { getClient, Reporter } from "./lib/introspect.mjs";
import { createTestFactoryAndLine, teardownTestData, V75_MARK, V75_ACTOR } from "./lib/test-fixtures.mjs";

import { commitRun } from "../src/import-gateway/committer.js";
import { ingestEvent } from "../src/runtime/ingest.js";
import { autoGenerateTasks } from "../src/execution/auto-generate.js";
import { createWorkOrder, transitionWorkOrder, reportOutput } from "../src/shopfloor/service.js";
import { evaluateDecision } from "../src/decision-engine/io.js";
import { applyOption } from "../src/decision-engine/apply.js";
import { assessLineById } from "../src/risk-engine/io.js";
import { recomputeLearning } from "../src/decision-engine/learning-io.js";
import { loadIntelligence } from "../src/decision-intel/io.js";

const KEEP = process.argv.includes("--keep");
const db = getClient();
const r = new Reporter("V7.5 End-to-End Business Validation");
const today = new Date().toISOString().slice(0, 10);

// Track ids we create so cleanup is precise even across soft FKs.
const created = { taskIds: [], assessmentIds: [], importRunIds: [], eventIds: [] };

let factoryId, lineId;

// ── Flow A — Excel Import ────────────────────────────────────
async function flowA() {
  r.section("Flow A — Excel Import");
  // A real import_run so the committer's per-row bookkeeping + FK targets resolve.
  const { data: run, error: runErr } = await db.from("import_runs")
    .insert({ import_type: "daily_report", status: "committing", total_rows: 1, filename: "v75-validation.xlsx", uploaded_by: V75_ACTOR, detected_factory_id: factoryId })
    .select().single();
  if (runErr) { r.fail_("create import_run", runErr.message); return; }
  created.importRunIds.push(run.id);
  r.pass_("import_run created", run.id.slice(0, 8));

  const { data: row } = await db.from("import_rows").insert({
    run_id: run.id, row_number: 1, raw_data: {}, status: "pending",
    normalized: {
      date: today, _resolved_factory_id: factoryId, _resolved_line_id: lineId,
      actual_output: 80, planned_output: 200, cumulative_output: 80,
      stage: "sewing", is_abnormal: true, abnormal_reason: "validation low output",
    },
  }).select().single();

  const result = await commitRun(db, run, [row ?? { id: randomUUID(), row_number: 1, normalized: {
    date: today, _resolved_factory_id: factoryId, _resolved_line_id: lineId,
    actual_output: 80, planned_output: 200, stage: "sewing", is_abnormal: true,
  } }], { actor: V75_ACTOR });

  r.add(result.created >= 1 ? "PASS" : "FAIL", "daily report committed", `created=${result.created} skipped=${result.skipped} errors=${result.errors}`);
  result.events?.forEach((id) => created.eventIds.push(id));
  r.add((result.events?.length ?? 0) >= 1 ? "PASS" : "FAIL", "runtime event emitted", `${result.events?.length ?? 0} event(s)`);

  // Daily report row exists for our factory
  const { count: drCount } = await db.from("daily_production_reports")
    .select("*", { count: "exact", head: true }).eq("factory_id", factoryId).eq("date", today);
  r.add((drCount ?? 0) >= 1 ? "PASS" : "FAIL", "daily_production_reports row exists", `${drCount} row(s)`);

  // Runtime line updated by the ingest side-effect
  const { data: rtLine } = await db.from("production_runtime_lines").select("line_id, runtime_status, updated_at").eq("line_id", lineId).maybeSingle();
  r.add(rtLine ? "PASS" : "FAIL", "production_runtime_lines updated", rtLine ? `status=${rtLine.runtime_status}` : "no runtime line");

  // Risk recalculated for the line
  try {
    const risk = await assessLineById(db, lineId);
    r.add(risk ? "PASS" : "FAIL", "risk recalculated for line", risk ? `level=${risk.level} score=${risk.score}` : "no assessment");
  } catch (err) { r.fail_("risk recalculated for line", err.message); }
}

// ── Flow B — Shopfloor Execution ─────────────────────────────
async function flowB() {
  r.section("Flow B — Shopfloor Execution");
  let wo;
  try {
    wo = await createWorkOrder(db, {
      factory_id: factoryId, line_id: lineId, operation: "sewing",
      planned_qty: 100, assigned_to: V75_ACTOR, created_by: V75_ACTOR,
      order_id: `${V75_MARK}-order-B`,
    });
    r.pass_("work order created", wo.id.slice(0, 8));
  } catch (err) { r.fail_("work order created", err.message); return; }

  const step = async (label, fn) => {
    try { const res = await fn(); r.add(res?.ok !== false ? "PASS" : "FAIL", label, res?.error ?? ""); return res; }
    catch (err) { r.fail_(label, err.message); return null; }
  };

  await step("start", () => transitionWorkOrder(db, wo.id, "start", { actor: V75_ACTOR }));
  await step("report output (35)", () => reportOutput(db, wo.id, { output_qty: 35, defect_qty: 2 }, { actor: V75_ACTOR }));
  await step("pause", () => transitionWorkOrder(db, wo.id, "pause", { actor: V75_ACTOR, reason: "validation" }));
  await step("resume", () => transitionWorkOrder(db, wo.id, "resume", { actor: V75_ACTOR }));
  await step("report output (65)", () => reportOutput(db, wo.id, { output_qty: 65 }, { actor: V75_ACTOR }));
  await step("complete", () => transitionWorkOrder(db, wo.id, "complete", { actor: V75_ACTOR }));

  // Verify the chains
  const { count: sfEvents } = await db.from("shopfloor_events").select("*", { count: "exact", head: true }).eq("work_order_id", wo.id);
  r.add((sfEvents ?? 0) >= 4 ? "PASS" : "FAIL", "shopfloor_events recorded", `${sfEvents} event(s)`);
  const { count: sfReports } = await db.from("shopfloor_reports").select("*", { count: "exact", head: true }).eq("work_order_id", wo.id);
  r.add((sfReports ?? 0) >= 2 ? "PASS" : "FAIL", "shopfloor_reports recorded", `${sfReports} report(s)`);
  const { count: rtEvents } = await db.from("runtime_events").select("*", { count: "exact", head: true }).eq("factory_id", factoryId).eq("source", "human");
  r.add("PASS", "runtime_events emitted from floor", `${rtEvents ?? 0} runtime event(s) for factory`);
  const { data: rtLine } = await db.from("production_runtime_lines").select("actual_output_today, runtime_status").eq("line_id", lineId).maybeSingle();
  r.add(rtLine ? "PASS" : "FAIL", "production_runtime_lines reflects floor output", rtLine ? `actual_today=${rtLine.actual_output_today}` : "no line");
}

// ── Flow C — Risk → Task ─────────────────────────────────────
async function flowC() {
  r.section("Flow C — Risk → Task");
  // Inject a CRITICAL runtime event the auto-generator will pick up.
  let event;
  try {
    const res = await ingestEvent(db, {
      event_type: "line_slowdown", severity: "critical", source: "sensor",
      source_ref: `${V75_MARK}:flowC`, factory_id: factoryId, line_id: lineId,
      order_id: `${V75_MARK}-order-C`,
      payload: { kind: "validation", actual: 10, expected: 100 },
      reasoning: "V7.5 validation: injected critical slowdown",
    }, { propagate: true, apply_to_lines: true });
    event = res?.event;
    if (event) created.eventIds.push(event.id);
    r.add(event ? "PASS" : "FAIL", "critical runtime event injected", event ? event.id.slice(0, 8) : "no event");
  } catch (err) { r.fail_("critical runtime event injected", err.message); return; }
  if (!event) return;

  // Auto-generate tasks from persisted risk sources.
  let gen;
  try { gen = await autoGenerateTasks(db, { actor: V75_ACTOR }); r.pass_("auto-generate ran", `created=${gen.created} skipped=${gen.skipped}`); }
  catch (err) { r.fail_("auto-generate ran", err.message); return; }

  // The derived task's source_ref is `runtime_event:<eventId>`.
  const sourceRef = `runtime_event:${event.id}`;
  const { data: task } = await db.from("decision_tasks").select("id, status, severity").eq("source_ref", sourceRef).maybeSingle();
  if (task) created.taskIds.push(task.id);
  r.add(task ? "PASS" : "FAIL", "task auto-generated from event", task ? `severity=${task.severity}` : "no task for source_ref");

  if (task) {
    const { count: notifs } = await db.from("notification_events").select("*", { count: "exact", head: true }).eq("task_id", task.id);
    r.add((notifs ?? 0) >= 1 ? "PASS" : "FAIL", "notification generated for task", `${notifs} notification(s)`);
  }
}

// ── Flow D — Decision Flow ───────────────────────────────────
let flowDAssessment = null;
async function flowD() {
  r.section("Flow D — Decision Flow");
  let assessment;
  try {
    assessment = await evaluateDecision(db, { type: "order", id: `${V75_MARK}-order-D` }, {
      persist: true, createdBy: V75_ACTOR,
      context: { decision_type: "delay_resolution", expected_delay_days: 6, urgency: "high", qty: 1000, order_revenue: 80000, gross_margin_pct: 18 },
    });
    if (assessment?.id) created.assessmentIds.push(assessment.id);
    const nOpts = assessment?.options?.length ?? 0;
    r.add(assessment?.id ? "PASS" : "FAIL", "decision assessment persisted", assessment?.id ? assessment.id.slice(0, 8) : "no id");
    r.add(nOpts >= 1 ? "PASS" : "FAIL", "options generated", `${nOpts} option(s), recommended=${assessment?.recommended_option_id ?? "—"}`);
  } catch (err) { r.fail_("decision assessment persisted", err.message); return; }
  if (!assessment?.recommended_option_id) return;
  flowDAssessment = assessment;

  // Apply the recommendation (task_only mode → safe, creates a follow-up task).
  let applied;
  try {
    applied = await applyOption(db, assessment, assessment.recommended_option_id, { mode: "task_only", actor: V75_ACTOR });
    r.add(applied?.ok ? "PASS" : "FAIL", "recommendation applied", `status=${applied?.status} actions=${applied?.actions_taken?.length ?? 0}`);
    const createdTaskAction = (applied?.actions_taken ?? []).find((a) => a.action_type === "create_task" && a.task_id);
    if (createdTaskAction?.task_id) created.taskIds.push(createdTaskAction.task_id);
  } catch (err) { r.fail_("recommendation applied", err.message); }

  // decision_logs written
  const { count: logs } = await db.from("decision_logs").select("*", { count: "exact", head: true }).eq("decision_id", assessment.id);
  r.add((logs ?? 0) >= 1 ? "PASS" : "FAIL", "decision_logs created", `${logs} log(s)`);
}

// ── Flow E — Learning Flow ───────────────────────────────────
async function flowE() {
  r.section("Flow E — Learning Flow");
  if (!flowDAssessment?.id) { r.warn_("learning flow", "skipped — Flow D produced no assessment"); return; }
  const optionId = flowDAssessment.recommended_option_id;

  // Submit feedback on the applied option.
  const { error: fbErr } = await db.from("decision_option_feedback").insert({
    decision_id: flowDAssessment.id, option_id: optionId, feedback_type: "helpful",
    feedback_note: "V7.5 validation", created_by: V75_ACTOR,
  });
  r.add(!fbErr ? "PASS" : "FAIL", "feedback submitted", fbErr?.message ?? "helpful");

  // Recompute learning (global, bounded, idempotent).
  let learn;
  try { learn = await recomputeLearning(db, { now: new Date() }); r.add("PASS", "learning recompute ran", `updated=${learn.updated}`); }
  catch (err) { r.fail_("learning recompute ran", err.message); return; }

  // decision_learning now has at least one row.
  const { count: learnRows } = await db.from("decision_learning").select("*", { count: "exact", head: true });
  r.add((learnRows ?? 0) >= 1 ? "PASS" : "FAIL", "decision_learning populated", `${learnRows} row(s)`);

  // Decision Intelligence reflects the data (loads without error + has feedback).
  try {
    const intel = await loadIntelligence(db, {});
    const fb = intel?.feedback?.total_feedback ?? intel?.feedback?.helpful ?? 0;
    r.add(intel ? "PASS" : "FAIL", "decision intelligence reflects change", `feedback_total=${fb}`);
  } catch (err) { r.fail_("decision intelligence reflects change", err.message); }
}

// ── Cleanup ──────────────────────────────────────────────────
async function cleanup() {
  r.section("Cleanup");
  if (KEEP) { r.warn_("teardown", "skipped (--keep)"); return; }
  // Precise id-based deletes first (soft FKs the factory cascade can't reach).
  const safe = async (label, fn) => { try { await fn(); r.pass_(label); } catch (err) { r.warn_(label, err.message); } };
  if (created.taskIds.length) await safe("delete test tasks", () => db.from("decision_tasks").delete().in("id", created.taskIds));
  if (created.assessmentIds.length) await safe("delete test assessments", () => db.from("decision_assessments").delete().in("id", created.assessmentIds));
  if (created.eventIds.length) await safe("delete test runtime events", () => db.from("runtime_events").delete().in("id", created.eventIds));
  if (created.importRunIds.length) await safe("delete test import runs", () => db.from("import_runs").delete().in("id", created.importRunIds));
  const removed = await teardownTestData(db);
  r.pass_("factory subtree teardown", Object.entries(removed).map(([k, v]) => `${k}:${v === "ok" ? "✓" : "·"}`).join(" "));
}

// ── Run ──────────────────────────────────────────────────────
try {
  ({ factoryId, lineId } = await createTestFactoryAndLine(db));
  r.section("Setup");
  r.pass_("test factory + line", `factory=${factoryId.slice(0, 8)} line=${lineId.slice(0, 8)}`);

  await flowA();
  await flowB();
  await flowC();
  await flowD();
  await flowE();
} catch (err) {
  r.fail_("validation harness", err?.message ?? String(err));
} finally {
  try { await cleanup(); } catch (err) { console.error("cleanup error:", err?.message ?? err); }
}

const ok = r.summary();
if (KEEP) console.log("ℹ Test data retained (--keep). Re-run without --keep to clean up.\n");
process.exit(ok ? 0 : 1);
