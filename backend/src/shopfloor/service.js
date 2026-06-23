/**
 * Shopfloor Service — the only file in the shopfloor layer that touches the DB.
 *
 * This is where the floor connects to the brain. Each report:
 *   - persists shopfloor_reports + shopfloor_events (audit)
 *   - updates the work order (completed_qty / status) w/ optimistic concurrency
 *   - emits a runtime_event (→ propagation + anomaly/corrector pickup)
 *   - updates production_runtime_lines (live line state)
 *   - blocked (severe) → creates an idempotent decision_task
 *
 * Reuses existing engines: runtime ingest, runtime state, execution createTask.
 */

import { transition } from "./state-machine.js";
import {
  outputEvent, outputLineDelta, blockedEvent, blockedLineDelta, blockedTaskDraft, defectEvent,
} from "./report-builders.js";
import { ingestEvent } from "../runtime/ingest.js";
import { upsertRuntimeLine } from "../runtime/state.js";
import { createTask } from "../execution/service.js";

// ── Work order CRUD ─────────────────────────────────────

export async function createWorkOrder(supabase, input) {
  const row = {
    order_id: input.order_id ?? null,
    allocation_id: input.allocation_id ?? null,
    factory_id: input.factory_id ?? null,
    line_id: input.line_id ?? null,
    operation: input.operation ?? null,
    planned_qty: Number(input.planned_qty) || 0,
    assigned_to: input.assigned_to ?? null,
    planned_start_at: input.planned_start_at ?? null,
    planned_end_at: input.planned_end_at ?? null,
    status: "pending",
    created_by: input.created_by ?? "system",
  };
  const { data, error } = await supabase.from("shopfloor_work_orders").insert(row).select().single();
  if (error) throw error;
  return data;
}

export async function listWorkOrders(supabase, filters = {}) {
  let q = supabase.from("shopfloor_work_orders").select("*").order("planned_start_at", { ascending: true, nullsFirst: false });
  if (filters.assigned_to) q = q.eq("assigned_to", filters.assigned_to);
  if (filters.status) q = q.eq("status", filters.status);
  if (filters.line_id) q = q.eq("line_id", filters.line_id);
  if (filters.factory_id) q = q.eq("factory_id", filters.factory_id);
  if (filters.today) {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(); end.setHours(23, 59, 59, 999);
    q = q.gte("planned_start_at", start.toISOString()).lte("planned_start_at", end.toISOString());
  }
  const { data, error } = await q.limit(Math.min(500, Number(filters.limit ?? 200)));
  if (error) throw error;
  return data ?? [];
}

// ── Status transition (start/pause/resume/complete/block) ──

export async function transitionWorkOrder(supabase, woId, action, payload = {}) {
  const { data: wo, error } = await supabase.from("shopfloor_work_orders").select("*").eq("id", woId).maybeSingle();
  if (error) throw error;
  if (!wo) return { ok: false, error: "work order not found" };

  let result;
  try { result = transition(wo, action, payload); }
  catch (err) { return { ok: false, error: err.message }; }

  const { data: updated, error: updErr } = await supabase
    .from("shopfloor_work_orders")
    .update({ ...result.patch, version: wo.version + 1 })
    .eq("id", woId).eq("version", wo.version)
    .select().maybeSingle();
  if (updErr) throw updErr;
  if (!updated) return { ok: false, conflict: true };

  await appendEvent(supabase, woId, result.event, payload.actor);

  // A direct "block" via status transition also flows to the brain.
  let sideEffects = {};
  if (action === "block") {
    sideEffects = await handleBlockedSideEffects(supabase, updated, { reason: payload.block_reason, note: payload.note, reported_by: payload.actor });
  }
  return { ok: true, work_order: updated, ...sideEffects };
}

// ── Report: output ──────────────────────────────────────

export async function reportOutput(supabase, woId, report, opts = {}) {
  const { data: wo, error } = await supabase.from("shopfloor_work_orders").select("*").eq("id", woId).maybeSingle();
  if (error) throw error;
  if (!wo) return { ok: false, error: "work order not found" };

  const outQty = Number(report.output_qty) || 0;
  const defQty = Number(report.defect_qty) || 0;
  const newCompleted = Number(wo.completed_qty || 0) + outQty;
  const newDefect = Number(wo.defect_qty || 0) + defQty;

  // 1. persist report
  await supabase.from("shopfloor_reports").insert({
    work_order_id: woId, report_type: "output",
    output_qty: outQty, defect_qty: defQty, note: report.note ?? null,
    reported_by: opts.actor ?? null,
  });

  // 2. update work order counts (+ auto-start if still pending)
  const patch = {
    completed_qty: newCompleted, defect_qty: newDefect,
    version: wo.version + 1,
  };
  if (wo.status === "pending") { patch.status = "in_progress"; patch.actual_start_at = wo.actual_start_at ?? new Date().toISOString(); }
  const { data: updated, error: upErr } = await supabase
    .from("shopfloor_work_orders").update(patch).eq("id", woId).eq("version", wo.version).select().maybeSingle();
  if (upErr) throw upErr;
  const woFinal = updated ?? { ...wo, completed_qty: newCompleted, defect_qty: newDefect };

  await appendEvent(supabase, woId, { event_type: "report_output", payload: { output_qty: outQty, defect_qty: defQty, completed_qty: newCompleted } }, opts.actor);

  // 3. emit runtime event + update line state
  const eventIds = [];
  const ev = await emit(supabase, outputEvent(woFinal, { ...report, reported_by: opts.actor }), opts);
  if (ev) eventIds.push(ev);
  if (woFinal.line_id) await safeLineUpsert(supabase, outputLineDelta(woFinal), opts);

  // 4. defects in the same report → defect signal
  if (defQty > 0) {
    const dev = await emit(supabase, defectEvent(woFinal, { defect_qty: defQty, reported_by: opts.actor }), opts);
    if (dev) eventIds.push(dev);
  }

  return { ok: true, work_order: woFinal, events: eventIds };
}

// ── Report: defect ──────────────────────────────────────

export async function reportDefect(supabase, woId, report, opts = {}) {
  const { data: wo, error } = await supabase.from("shopfloor_work_orders").select("*").eq("id", woId).maybeSingle();
  if (error) throw error;
  if (!wo) return { ok: false, error: "work order not found" };

  const defQty = Number(report.defect_qty) || 0;
  const newDefect = Number(wo.defect_qty || 0) + defQty;

  await supabase.from("shopfloor_reports").insert({
    work_order_id: woId, report_type: "defect",
    defect_qty: defQty, reason: report.reason ?? null, note: report.note ?? null, reported_by: opts.actor ?? null,
  });
  await supabase.from("shopfloor_work_orders").update({ defect_qty: newDefect, version: wo.version + 1 }).eq("id", woId).eq("version", wo.version);
  await appendEvent(supabase, woId, { event_type: "report_defect", payload: { defect_qty: defQty, reason: report.reason } }, opts.actor);

  const woFinal = { ...wo, defect_qty: newDefect };
  const eventIds = [];
  const ev = await emit(supabase, defectEvent(woFinal, { defect_qty: defQty, reported_by: opts.actor, note: report.note }), opts);
  if (ev) eventIds.push(ev);
  return { ok: true, work_order: woFinal, events: eventIds };
}

// ── Report: blocked ─────────────────────────────────────

export async function reportBlocked(supabase, woId, report, opts = {}) {
  const { data: wo, error } = await supabase.from("shopfloor_work_orders").select("*").eq("id", woId).maybeSingle();
  if (error) throw error;
  if (!wo) return { ok: false, error: "work order not found" };

  await supabase.from("shopfloor_reports").insert({
    work_order_id: woId,
    report_type: report.reason === "material_shortage" ? "material_shortage"
      : report.reason === "labor_shortage" ? "labor_shortage"
      : report.reason === "quality_issue" ? "quality_issue" : "downtime",
    downtime_minutes: Number(report.downtime_minutes) || 0,
    reason: report.reason ?? "other", note: report.note ?? null, reported_by: opts.actor ?? null,
  });

  // Move WO to blocked (if not terminal)
  if (wo.status !== "completed") {
    await supabase.from("shopfloor_work_orders")
      .update({ status: "blocked", block_reason: report.reason ?? "other", version: wo.version + 1 })
      .eq("id", woId).eq("version", wo.version);
  }
  await appendEvent(supabase, woId, { event_type: "report_blocked", payload: { reason: report.reason, note: report.note } }, opts.actor);

  const woFinal = { ...wo, status: "blocked", block_reason: report.reason ?? "other" };
  const fx = await handleBlockedSideEffects(supabase, woFinal, { ...report, reported_by: opts.actor }, opts);
  return { ok: true, work_order: woFinal, ...fx };
}

// Shared: blocked → runtime event + line state + (severe) decision task
async function handleBlockedSideEffects(supabase, wo, report, opts = {}) {
  const eventIds = [];
  const ev = await emit(supabase, blockedEvent(wo, report), opts);
  if (ev) eventIds.push(ev);
  if (wo.line_id) await safeLineUpsert(supabase, blockedLineDelta(wo), opts);

  let task = null;
  const draft = blockedTaskDraft(wo, report);
  if (draft) {
    try {
      const r = await createTask(supabase, { ...draft, created_by: opts.actor ?? "shopfloor", request_id: opts.requestId });
      task = { id: r.task.id, created: r.created };
    } catch (err) { console.error("[shopfloor] blocked task create failed:", err?.message ?? err); }
  }
  return { events: eventIds, task };
}

// ── Summary ─────────────────────────────────────────────

export async function shopfloorSummary(supabase, filters = {}) {
  const wos = await listWorkOrders(supabase, { ...filters, today: filters.today ?? true });
  const planned = wos.reduce((s, w) => s + (Number(w.planned_qty) || 0), 0);
  const completed = wos.reduce((s, w) => s + (Number(w.completed_qty) || 0), 0);
  const defects = wos.reduce((s, w) => s + (Number(w.defect_qty) || 0), 0);
  const blocked = wos.filter((w) => w.status === "blocked").length;
  const inProgress = wos.filter((w) => w.status === "in_progress").length;
  const done = wos.filter((w) => w.status === "completed").length;

  // downtime from today's reports
  let downtime = 0;
  if (wos.length) {
    const { data: reps } = await supabase
      .from("shopfloor_reports")
      .select("downtime_minutes, work_order_id")
      .in("work_order_id", wos.map((w) => w.id));
    downtime = (reps ?? []).reduce((s, r) => s + (Number(r.downtime_minutes) || 0), 0);
  }

  return {
    work_orders: wos.length,
    planned_qty: planned,
    completed_qty: completed,
    completion_pct: planned > 0 ? Math.round((completed / planned) * 1000) / 10 : 0,
    defect_qty: defects,
    downtime_minutes: downtime,
    blocked_orders: blocked,
    in_progress_orders: inProgress,
    completed_orders: done,
  };
}

// ── Internals ───────────────────────────────────────────

async function appendEvent(supabase, woId, ev, actor) {
  const { error } = await supabase.from("shopfloor_events").insert({
    work_order_id: woId, event_type: ev.event_type, payload: ev.payload ?? {}, created_by: actor ?? null,
  });
  if (error) console.error("[shopfloor_events] insert failed:", error.message);
}

async function emit(supabase, body, opts) {
  try {
    const r = await ingestEvent(supabase, { ...body, request_id: opts?.requestId ?? null },
      { actor: opts?.actor ?? "shopfloor", propagate: true, apply_to_lines: false });
    return r?.event?.id ?? null;
  } catch (err) { console.error("[shopfloor] emit failed:", err?.message ?? err); return null; }
}

async function safeLineUpsert(supabase, delta, opts) {
  try { await upsertRuntimeLine(supabase, delta, { actor: opts?.actor ?? "shopfloor" }); }
  catch (err) { console.error("[shopfloor] line upsert failed:", err?.message ?? err); }
}
