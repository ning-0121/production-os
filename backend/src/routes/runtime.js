/**
 * Runtime Brain API — V5-A Foundation Layer.
 *
 * All endpoints are runtime-safe, composable, and incremental. Heavy lifting
 * is delegated to pure modules under `src/runtime/`. This route file is the
 * thin HTTP/IO boundary.
 */

import { Router } from "express";
import crypto from "node:crypto";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validate, schemas } from "../middleware/validate.js";
import { auditLog } from "../governance/audit.js";

import {
  listRuntimeLines, getRuntimeLine, upsertRuntimeLine,
  takeSnapshot, getSnapshot, applyPlanToLines,
} from "../runtime/state.js";
import { ingestEvent, loadGraph } from "../runtime/ingest.js";
import { propagateImpact } from "../runtime/propagation.js";
import { findNodeByRef, graphSize } from "../runtime/graph.js";
import { localReschedule, insertEmergency, simulate, rollback, computeRisk } from "../runtime/scheduler.js";
import { replay } from "../runtime/events.js";

const router = Router();

// ════════════════════════════════════════════════════════════
// War Room aggregate views (V5-B): timeline, commands, KPI
// ════════════════════════════════════════════════════════════
// These read-only endpoints aggregate runtime + planning data into shapes the
// War Room UI can render directly (no client-side joining required).

// GET /api/runtime/timeline — vis-timeline groups+items shape
// Query: factory_id?, from?, to?  (defaults: now-7d ... now+30d)
router.get("/timeline", asyncHandler(async (req, res) => {
  const now = Date.now();
  const from = req.query.from ?? new Date(now - 7 * 86400000).toISOString();
  const to   = req.query.to   ?? new Date(now + 30 * 86400000).toISOString();

  let linesQ = supabase
    .from("production_lines")
    .select("id, name, factory_id, status, factories(id, name)")
    .eq("status", "active");
  if (req.query.factory_id) linesQ = linesQ.eq("factory_id", req.query.factory_id);

  let allocQ = supabase
    .from("production_allocations")
    .select("id, order_id, factory_id, product_type, allocated_qty, planned_start_date, planned_end_date, status, is_locked")
    .gte("planned_end_date", from)
    .lte("planned_start_date", to)
    .not("status", "eq", "cancelled");
  if (req.query.factory_id) allocQ = allocQ.eq("factory_id", req.query.factory_id);

  const [linesRes, allocRes, schedRes, corrRes, runtimeRes] = await Promise.all([
    linesQ,
    allocQ,
    supabase.from("line_schedules").select("line_id, allocation_id, planned_start, planned_end, status"),
    supabase.from("order_corrections").select("allocation_id, risk_status, deviation_pct, actual_cumulative, planned_cumulative"),
    listRuntimeLines(supabase, req.query.factory_id ? { factory_id: req.query.factory_id } : {}),
  ]);

  const lines = linesRes.data ?? [];
  const allocations = allocRes.data ?? [];
  const schedules = schedRes.data ?? [];
  const corrections = corrRes.data ?? [];
  const runtime = runtimeRes ?? [];

  const corrByAlloc = new Map(corrections.map((c) => [c.allocation_id, c]));
  const runtimeByLine = new Map(runtime.map((r) => [r.line_id, r]));
  const schedByAlloc = new Map(schedules.map((s) => [s.allocation_id, s]));

  // Groups: one row per line, ordered by factory→line name
  const groups = lines
    .map((l) => {
      const rt = runtimeByLine.get(l.id);
      return {
        id: l.id,
        content: l.name,
        factory_id: l.factory_id,
        factory_name: l.factories?.name ?? "—",
        runtime_status: rt?.runtime_status ?? "idle",
        runtime_risk: rt?.runtime_risk ?? "green",
        overload_pct: Number(rt?.overload_pct ?? 0),
        current_efficiency: Number(rt?.current_efficiency ?? 1),
      };
    })
    .sort((a, b) => (a.factory_name + a.content).localeCompare(b.factory_name + b.content));

  // Items: one block per allocation
  const items = allocations
    .map((a) => {
      const sched = schedByAlloc.get(a.id);
      const corr = corrByAlloc.get(a.id);
      const start = sched?.planned_start ?? a.planned_start_date ?? from;
      const end   = sched?.planned_end   ?? a.planned_end_date   ?? to;
      const lineId = sched?.line_id ?? null;
      if (!lineId) return null;

      // Progress %
      const planned = Number(corr?.planned_cumulative ?? 0);
      const actual  = Number(corr?.actual_cumulative ?? 0);
      const progress = planned > 0 ? Math.min(100, Math.round((actual / Math.max(1, Number(a.allocated_qty))) * 100)) : 0;

      const risk = corr?.risk_status === "critical" ? "critical"
        : corr?.risk_status === "falling_behind" ? "high"
        : (a.status === "in_progress" ? "running" : "ok");

      return {
        id: a.id,
        group: lineId,
        start,
        end,
        order_id: a.order_id ?? null,
        product_type: a.product_type ?? null,
        qty: Number(a.allocated_qty ?? 0),
        progress,
        status: a.status,
        is_locked: !!a.is_locked,
        risk,
        deviation_pct: Number(corr?.deviation_pct ?? 0),
        // vis-timeline content rendered HTML-side in TimelineOrderBlock
        content: a.order_id ?? a.id.slice(0, 8),
      };
    })
    .filter(Boolean);

  res.json({
    window: { from, to },
    counts: { groups: groups.length, items: items.length },
    groups,
    items,
  });
}));

// GET /api/runtime/commands — aggregated AI command feed
// Pulls high-severity unhandled events + recent agent actions into one stream
router.get("/commands", asyncHandler(async (req, res) => {
  const limit = Math.min(50, Number(req.query.limit ?? 20));
  const since = new Date(Date.now() - 7 * 86400000).toISOString();

  const [eventsRes, actionsRes] = await Promise.all([
    supabase
      .from("runtime_events")
      .select("*")
      .in("severity", ["critical", "high", "medium"])
      .gte("occurred_at", since)
      .order("occurred_at", { ascending: false })
      .limit(limit),
    supabase
      .from("ai_action_logs")
      .select("*")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(limit),
  ]);

  const events = eventsRes.data ?? [];
  const actions = actionsRes.data ?? [];

  // Normalize into a single command shape
  const commands = [
    ...events.map((e) => ({
      id: `evt:${e.id}`,
      kind: "event",
      severity: e.severity,
      title: shortLabel(e.event_type),
      summary: e.reasoning ?? `${e.event_type} on ${e.line_id ?? e.factory_id ?? "—"}`,
      affected: e.affected_entities ?? [],
      source: e.source,
      source_event_id: e.id,
      factory_id: e.factory_id,
      line_id: e.line_id,
      allocation_id: e.allocation_id,
      order_id: e.order_id,
      payload: e.payload ?? {},
      confidence: e.confidence,
      occurred_at: e.occurred_at,
      propagation_status: e.propagation_status,
      // Recommended actions per event type
      actions: routeActionsFor(e),
    })),
    ...actions.map((a) => ({
      id: `act:${a.id}`,
      kind: "action",
      severity: a.urgency ?? "medium",
      title: a.action_type,
      summary: a.summary,
      affected: [],
      source: a.agent ?? "agent",
      source_event_id: null,
      factory_id: null,
      line_id: null,
      allocation_id: null,
      order_id: a.target_id,
      payload: a.params ?? {},
      confidence: Number(a.confidence ?? 0.5),
      occurred_at: a.created_at,
      propagation_status: "n/a",
      actions: [
        { type: "execute", label: "执行", endpoint: `/ai-actions/${a.id}/execute`, method: "POST" },
        { type: "dismiss", label: "忽略", endpoint: `/ai-actions/${a.id}/reject`, method: "POST" },
      ],
    })),
  ].sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at))).slice(0, limit);

  res.json({ count: commands.length, commands });
}));

// GET /api/runtime/kpi — aggregated KPI strip data
router.get("/kpi", asyncHandler(async (_req, res) => {
  const [linesRes, eventsRes] = await Promise.all([
    listRuntimeLines(supabase),
    supabase
      .from("runtime_events")
      .select("severity, propagation_status, occurred_at")
      .gte("occurred_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString()),
  ]);

  const lines = linesRes ?? [];
  const events = eventsRes.data ?? [];

  const overloaded = lines.filter((l) => Number(l.overload_pct ?? 0) > 100).length;
  const high_risk_lines = lines.filter((l) => l.runtime_risk === "red").length;
  const active_lines = lines.filter((l) => l.runtime_status === "running").length;
  const blocked_lines = lines.filter((l) => l.runtime_status === "blocked" || l.runtime_status === "down").length;

  res.json({
    active_lines,
    overloaded_lines: overloaded,
    blocked_lines,
    high_risk_lines,
    runtime_events_24h: events.length,
    critical_events_24h: events.filter((e) => e.severity === "critical").length,
    pending_propagations: events.filter((e) => e.propagation_status === "pending").length,
    timestamp: new Date().toISOString(),
  });
}));

function shortLabel(eventType) {
  const map = {
    material_delayed: "物料延迟",
    line_slowdown: "产线减速",
    rework_started: "返工开始",
    qc_failure: "质量异常",
    factory_shutdown: "工厂停产",
    labor_shortage: "人员短缺",
    shipment_risk: "出货风险",
    vip_inserted: "紧急插单",
    overtime_started: "加班开启",
    allocation_completed: "订单完成",
    line_status_changed: "产线状态变更",
    reschedule_applied: "重排已应用",
    rollback_applied: "已回滚",
    simulation_run: "模拟运行",
  };
  return map[eventType] ?? eventType;
}

function routeActionsFor(event) {
  const acts = [
    { type: "simulate", label: "模拟影响", endpoint: "/runtime/simulate", method: "POST",
      payload: { events: [{ event_type: event.event_type, line_id: event.line_id, payload: event.payload }] } },
  ];
  if (event.event_type === "material_delayed" || event.event_type === "line_slowdown" || event.event_type === "qc_failure") {
    acts.push({ type: "incident", label: "升级为事件", endpoint: "/incidents", method: "POST",
      payload: { incident_type: event.event_type, severity: event.severity, factory_id: event.factory_id, order_id: event.order_id, description: event.reasoning ?? event.event_type } });
  }
  if (event.line_id) {
    acts.push({ type: "reschedule", label: "本地重排", endpoint: "/runtime/reschedule", method: "POST",
      payload: { line_id: event.line_id, conflict_type: event.event_type === "line_slowdown" ? "slowdown" : "blocked", reason: event.reasoning ?? "" } });
  }
  acts.push({ type: "dismiss", label: "忽略", endpoint: null, method: null });
  return acts;
}

// ════════════════════════════════════════════════════════════
// Lines (live state)
// ════════════════════════════════════════════════════════════

// GET /api/runtime/lines — list live line states (filterable)
router.get("/lines", asyncHandler(async (req, res) => {
  const filters = {
    factory_id: req.query.factory_id,
    status: req.query.status,
    risk: req.query.risk,
  };
  const data = await listRuntimeLines(supabase, filters);
  res.json({ count: data.length, lines: data });
}));

// GET /api/runtime/lines/:line_id — single line
router.get("/lines/:line_id", asyncHandler(async (req, res) => {
  const line = await getRuntimeLine(supabase, req.params.line_id);
  if (!line) return res.status(404).json({ error: "runtime line not found" });
  res.json(line);
}));

// PATCH /api/runtime/lines/:line_id — partial update with optimistic concurrency
router.patch("/lines/:line_id", validate(schemas.runtimeLineUpdate), asyncHandler(async (req, res) => {
  const { expected_version, ...patch } = req.body;
  const result = await upsertRuntimeLine(
    supabase,
    { line_id: req.params.line_id, ...patch },
    { expected_version, actor: req.pilotIdentity?.operator ?? "system" }
  );

  if (!result.updated) {
    auditLog({
      action: "runtime.line.update",
      category: "system",
      result_status: "failed",
      req,
      error_code: "version_conflict",
      detail: { line_id: req.params.line_id, conflict: result.conflict },
    });
    return res.status(409).json({ error: "version conflict", conflict: result.conflict, current: result.row });
  }

  // Recompute risk after persist (cheap)
  const recomputedRisk = computeRisk(result.row);
  if (recomputedRisk !== result.row.runtime_risk) {
    await supabase
      .from("production_runtime_lines")
      .update({ runtime_risk: recomputedRisk, updated_at: new Date().toISOString() })
      .eq("id", result.row.id);
    result.row.runtime_risk = recomputedRisk;
  }

  auditLog({
    action: "runtime.line.update",
    category: "system",
    result_status: "success",
    req,
    detail: { line_id: req.params.line_id, version: result.row.version },
  });
  res.json(result.row);
}));

// ════════════════════════════════════════════════════════════
// Events
// ════════════════════════════════════════════════════════════

// GET /api/runtime/events — list (filter by type, severity, factory, line)
router.get("/events", asyncHandler(async (req, res) => {
  let q = supabase.from("runtime_events").select("*").order("replay_seq", { ascending: false }).limit(Math.min(500, Number(req.query.limit ?? 100)));
  if (req.query.event_type) q = q.eq("event_type", req.query.event_type);
  if (req.query.severity) q = q.eq("severity", req.query.severity);
  if (req.query.factory_id) q = q.eq("factory_id", req.query.factory_id);
  if (req.query.line_id) q = q.eq("line_id", req.query.line_id);
  if (req.query.allocation_id) q = q.eq("allocation_id", req.query.allocation_id);
  if (req.query.since) q = q.gte("occurred_at", req.query.since);
  const { data, error } = await q;
  if (error) throw error;
  res.json({ count: data?.length ?? 0, events: data ?? [] });
}));

// POST /api/runtime/events — ingest a new event (drives the runtime brain)
router.post("/events", validate(schemas.runtimeEventCreate), asyncHandler(async (req, res) => {
  const result = await ingestEvent(supabase, {
    ...req.body,
    request_id: req.requestId ?? null,
  }, {
    actor: req.pilotIdentity?.operator ?? req.body.source_ref ?? "system",
  });

  auditLog({
    action: "runtime.event.ingest",
    category: "system",
    result_status: "success",
    req,
    detail: {
      event_id: result.event.id,
      event_type: result.event.event_type,
      severity: result.event.severity,
      source: result.event.source,
      propagation_status: result.event.propagation_status,
      affected_count: result.propagation?.impacted?.length ?? 0,
      lines_updated: result.lines_updated.length,
    },
  });

  res.status(201).json(result);
}));

// POST /api/runtime/events/replay — fold events to derive state (no persist)
router.post("/events/replay", validate(schemas.runtimeReplay), asyncHandler(async (req, res) => {
  const { since_seq, until_seq, factory_id } = req.body;
  let q = supabase.from("runtime_events").select("*").order("replay_seq", { ascending: true });
  if (since_seq != null) q = q.gte("replay_seq", since_seq);
  if (until_seq != null) q = q.lte("replay_seq", until_seq);
  if (factory_id) q = q.eq("factory_id", factory_id);
  const { data: events, error } = await q;
  if (error) throw error;

  const baseline = await listRuntimeLines(supabase, factory_id ? { factory_id } : {});
  const result = replay(events ?? [], { lines: baseline });

  res.json({
    events_count: events?.length ?? 0,
    summary: result.summary,
    final_state: result.final_state,
    per_event: result.per_event.slice(0, 200),  // cap response size
  });
}));

// ════════════════════════════════════════════════════════════
// Constraint Graph + Propagation
// ════════════════════════════════════════════════════════════

// GET /api/runtime/graph — return current constraint graph (capped)
router.get("/graph", asyncHandler(async (_req, res) => {
  const graph = await loadGraph(supabase);
  const sz = graphSize(graph);
  res.json({
    size: sz,
    nodes: [...graph.nodesById.values()].slice(0, 1000),
    edges: [...graph.outgoing.values()].flat().slice(0, 5000),
  });
}));

// POST /api/runtime/propagate — manual propagation from an origin node
router.post("/propagate", validate(schemas.runtimePropagate), asyncHandler(async (req, res) => {
  const { origin_node, severity, ...opts } = req.body;
  const graph = await loadGraph(supabase);
  const origin = findNodeByRef(graph, origin_node.node_type, origin_node.ref_id);
  if (!origin) {
    return res.status(404).json({
      error: "origin node not in graph",
      detail: { node_type: origin_node.node_type, ref_id: origin_node.ref_id },
    });
  }
  const result = propagateImpact(graph, origin.id, severity, opts);

  auditLog({
    action: "runtime.propagate",
    category: "system",
    result_status: "success",
    req,
    detail: { origin: origin_node, severity, impacted_count: result.impacted.length },
  });
  res.json(result);
}));

// ════════════════════════════════════════════════════════════
// Runtime Scheduler
// ════════════════════════════════════════════════════════════

async function loadCurrentState() {
  const lines = await listRuntimeLines(supabase);
  return { lines };
}

// POST /api/runtime/reschedule — local repair on one line
router.post("/reschedule", validate(schemas.runtimeReschedule), asyncHandler(async (req, res) => {
  const state = await loadCurrentState();
  const plan = localReschedule(state, req.body);

  // Take a snapshot before any state change so the move is rollback-able
  let snapshot_id = null;
  if (plan.feasible && plan.moves.length > 0) {
    const snap = await takeSnapshot(supabase, {
      reason: "pre_reschedule",
      taken_by: req.pilotIdentity?.operator ?? "system",
      label: `pre_reschedule_${req.body.line_id}`,
    });
    snapshot_id = snap?.id ?? null;

    // Emit a `reschedule_applied` event so the change is auditable + replayable
    await ingestEvent(supabase, {
      event_type: "reschedule_applied",
      severity: "info",
      source: "scheduler",
      line_id: req.body.line_id,
      payload: { plan, snapshot_id },
      reasoning: plan.reasoning,
      confidence: plan.confidence,
      request_id: req.requestId ?? null,
    }, { propagate: false, apply_to_lines: false });
  }

  auditLog({
    action: "runtime.reschedule",
    category: "system",
    result_status: plan.feasible ? "success" : "failed",
    req,
    detail: {
      line_id: req.body.line_id,
      conflict_type: req.body.conflict_type,
      moves: plan.moves.length,
      affected_orders: plan.affected_orders.length,
      snapshot_id,
    },
  });

  res.status(plan.feasible ? 200 : 400).json({ plan, snapshot_id });
}));

// POST /api/runtime/insert — VIP emergency insertion (returns displacement plan)
router.post("/insert", validate(schemas.runtimeInsert), asyncHandler(async (req, res) => {
  const state = await loadCurrentState();
  const plan = insertEmergency(state, req.body);

  let snapshot_id = null;
  if (plan.feasible && plan.moves.length > 0) {
    const snap = await takeSnapshot(supabase, {
      reason: "pre_vip_insert",
      taken_by: req.pilotIdentity?.operator ?? "system",
      label: `pre_vip_${req.body.allocation_id?.slice(0, 8)}`,
    });
    snapshot_id = snap?.id ?? null;

    await ingestEvent(supabase, {
      event_type: "vip_inserted",
      severity: req.body.urgency ?? "critical",
      source: "scheduler",
      factory_id: req.body.factory_id ?? null,
      allocation_id: req.body.allocation_id,
      order_id: req.body.order_id,
      payload: { plan, snapshot_id, qty: req.body.qty, due_date: req.body.due_date },
      reasoning: plan.reasoning,
      confidence: plan.confidence,
      request_id: req.requestId ?? null,
    }, { propagate: true, apply_to_lines: false });
  }

  auditLog({
    action: "runtime.insert",
    category: "system",
    result_status: plan.feasible ? "success" : "failed",
    req,
    detail: {
      allocation_id: req.body.allocation_id,
      order_id: req.body.order_id,
      moves: plan.moves.length,
      snapshot_id,
    },
  });

  res.status(plan.feasible ? 200 : 400).json({ plan, snapshot_id });
}));

// POST /api/runtime/simulate — dry-run "what-if" event sequence
router.post("/simulate", validate(schemas.runtimeSimulate), asyncHandler(async (req, res) => {
  const state = await loadCurrentState();
  const result = simulate(state, req.body.events);

  // Persist as a simulation_run audit event (no state change)
  await ingestEvent(supabase, {
    event_type: "simulation_run",
    severity: "info",
    source: "scheduler",
    payload: {
      input_events: req.body.events.length,
      summary: result.summary,
      effects: result.effects.slice(0, 50),
    },
    request_id: req.requestId ?? null,
  }, { propagate: false, apply_to_lines: false });

  auditLog({
    action: "runtime.simulate",
    category: "system",
    result_status: "success",
    req,
    detail: { input_events: req.body.events.length, lines_affected: result.summary.lines_affected.length },
  });

  res.json(result);
}));

// POST /api/runtime/rollback — preview or apply a rollback to a snapshot
router.post("/rollback", validate(schemas.runtimeRollback), asyncHandler(async (req, res) => {
  const { snapshot_id, apply } = req.body;
  const snap = await getSnapshot(supabase, snapshot_id);
  if (!snap) return res.status(404).json({ error: "snapshot not found" });

  const current = await loadCurrentState();
  const snapshotState = { lines: snap.payload?.lines ?? [] };
  const plan = rollback(current, snapshotState);

  let applied_count = 0;
  if (apply && plan.line_updates.length > 0) {
    const updates = plan.line_updates.map((u) => ({
      line_id: u.line_id,
      ...u.restored,
    }));
    const result = await applyPlanToLines(supabase, plan, updates, {
      actor: req.pilotIdentity?.operator ?? "system",
    });
    applied_count = result.line_results.filter((r) => r.updated).length;

    await ingestEvent(supabase, {
      event_type: "rollback_applied",
      severity: "high",
      source: "scheduler",
      payload: { snapshot_id, applied_count, plan: { reasoning: plan.reasoning } },
      reasoning: `Rolled back ${applied_count}/${plan.line_updates.length} lines from snapshot ${snapshot_id.slice(0, 8)}`,
      confidence: 1.0,
      request_id: req.requestId ?? null,
    }, { propagate: false, apply_to_lines: false });
  }

  auditLog({
    action: apply ? "runtime.rollback.apply" : "runtime.rollback.preview",
    category: "system",
    result_status: "success",
    req,
    detail: { snapshot_id, line_updates: plan.line_updates.length, applied_count },
  });

  res.json({ plan, applied_count, snapshot_id });
}));

// POST /api/runtime/snapshot — manual snapshot
router.post("/snapshot", asyncHandler(async (req, res) => {
  const snap = await takeSnapshot(supabase, {
    reason: req.body?.reason ?? "manual",
    taken_by: req.pilotIdentity?.operator ?? "system",
    label: req.body?.label ?? null,
  });
  res.status(201).json(snap);
}));

export default router;
