/**
 * Execution Engine routes — /api/tasks/*
 *
 * The accountability API: create tasks from risks, claim/start/resolve,
 * set deadlines, run escalation, record retrospectives.
 *
 * Boundary: this router writes ONLY through the execution service, which
 * touches only decision_tasks / task_events / retrospectives / task_watchers.
 */

import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validate, schemas } from "../middleware/validate.js";
import { auditLog } from "../governance/audit.js";
import {
  createTask, applyTransition, setDeadline, runEscalationSweep, addRetrospective,
} from "../execution/service.js";
import { legalActions } from "../execution/state-machine.js";

const router = Router();

// ── List (filterable) ───────────────────────────────────
router.get("/", asyncHandler(async (req, res) => {
  let q = supabase.from("decision_tasks").select("*").order("created_at", { ascending: false });
  if (req.query.status) q = q.eq("status", req.query.status);
  if (req.query.owner) q = q.eq("owner", req.query.owner);
  if (req.query.category) q = q.eq("category", req.query.category);
  if (req.query.severity) q = q.eq("severity", req.query.severity);
  if (req.query.subject_type) q = q.eq("subject_type", req.query.subject_type);
  if (req.query.subject_id) q = q.eq("subject_id", req.query.subject_id);
  if (req.query.open === "true") q = q.not("status", "in", "(resolved,dismissed)");
  if (req.query.escalated === "true") q = q.gt("escalation_level", 0);
  const limit = Math.min(500, Number(req.query.limit ?? 100));
  const { data, error } = await q.limit(limit);
  if (error) throw error;
  res.json({ count: data?.length ?? 0, tasks: data ?? [] });
}));

// ── KPI summary (for Task Center header) ────────────────
router.get("/summary", asyncHandler(async (_req, res) => {
  const { data, error } = await supabase
    .from("decision_tasks")
    .select("status, severity, escalation_level, owner, due_at");
  if (error) throw error;
  const rows = data ?? [];
  const open = rows.filter((t) => !["resolved", "dismissed"].includes(t.status));
  const now = Date.now();
  res.json({
    total: rows.length,
    open: open.length,
    unowned: open.filter((t) => !t.owner).length,
    overdue: open.filter((t) => t.due_at && new Date(t.due_at).getTime() < now).length,
    escalated: open.filter((t) => (t.escalation_level ?? 0) > 0).length,
    critical: open.filter((t) => t.severity === "critical").length,
    by_status: countBy(rows, "status"),
  });
}));

// ── Detail (task + events + retrospective + watchers) ───
router.get("/:id", asyncHandler(async (req, res) => {
  const { data: task, error } = await supabase
    .from("decision_tasks").select("*").eq("id", req.params.id).maybeSingle();
  if (error) throw error;
  if (!task) return res.status(404).json({ error: "task not found" });
  const [events, retro, watchers] = await Promise.all([
    supabase.from("task_events").select("*").eq("task_id", task.id).order("occurred_at", { ascending: true }),
    supabase.from("retrospectives").select("*").eq("task_id", task.id).maybeSingle(),
    supabase.from("task_watchers").select("*").eq("task_id", task.id),
  ]);
  res.json({
    task,
    legal_actions: legalActions(task.status),
    events: events.data ?? [],
    retrospective: retro.data ?? null,
    watchers: watchers.data ?? [],
  });
}));

// ── Create ──────────────────────────────────────────────
router.post("/", validate(schemas.createTask), asyncHandler(async (req, res) => {
  const result = await createTask(supabase, {
    ...req.body,
    created_by: req.pilotIdentity?.operator ?? "system",
    request_id: req.requestId ?? null,
  });
  auditLog({
    action: "task.create", category: "system",
    result_status: "success", req,
    detail: { task_id: result.task.id, created: result.created, source: req.body.source_type, severity: req.body.severity },
  });
  res.status(result.created ? 201 : 200).json(result);
}));

// ── Transition ──────────────────────────────────────────
router.post("/:id/transition", validate(schemas.transitionTask), asyncHandler(async (req, res) => {
  const { action, ...payload } = req.body;
  const result = await applyTransition(supabase, req.params.id, action, {
    ...payload,
    actor: req.pilotIdentity?.operator ?? "system",
    actor_role: req.pilotIdentity?.role ?? null,
    request_id: req.requestId ?? null,
  });
  if (!result.ok) {
    if (result.conflict) return res.status(409).json({ error: "version conflict", conflict: result.conflict });
    return res.status(400).json({ error: result.error });
  }
  auditLog({
    action: `task.${action}`, category: "system", result_status: "success", req,
    detail: { task_id: req.params.id, action, new_status: result.task.status },
  });
  res.json(result.task);
}));

// ── Set / change deadline ───────────────────────────────
router.post("/:id/deadline", validate(schemas.setTaskDeadline), asyncHandler(async (req, res) => {
  const result = await setDeadline(supabase, req.params.id, req.body.due_at, {
    actor: req.pilotIdentity?.operator ?? "system",
    actor_role: req.pilotIdentity?.role ?? null,
    request_id: req.requestId ?? null,
  });
  if (!result.ok) return res.status(result.conflict ? 409 : 400).json({ error: result.error ?? "conflict" });
  res.json(result.task);
}));

// ── Retrospective ───────────────────────────────────────
router.post("/:id/retrospective", validate(schemas.taskRetrospective), asyncHandler(async (req, res) => {
  const result = await addRetrospective(supabase, req.params.id, {
    ...req.body,
    authored_by: req.pilotIdentity?.operator ?? "system",
  });
  if (!result.ok) return res.status(400).json({ error: result.error });
  auditLog({
    action: "task.retrospective", category: "system", result_status: "success", req,
    detail: { task_id: req.params.id, root_cause: req.body.root_cause },
  });
  res.status(201).json(result.retrospective);
}));

// ── Escalation sweep (cron-callable, idempotent) ────────
router.post("/sweep-escalations", asyncHandler(async (req, res) => {
  const result = await runEscalationSweep(supabase);
  auditLog({
    action: "task.escalation_sweep", category: "system", result_status: "success", req,
    detail: { escalated: result.escalated },
  });
  res.json(result);
}));

function countBy(rows, key) {
  const out = {};
  for (const r of rows) out[r[key]] = (out[r[key]] ?? 0) + 1;
  return out;
}

export default router;
