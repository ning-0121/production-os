/**
 * Execution Service — the only file in the engine that touches the DB.
 *
 * Responsibilities:
 *   - createTask (idempotent on source_type + source_ref)
 *   - applyTransition (state-machine + event log + optimistic concurrency)
 *   - runEscalationSweep (pure escalation engine + persist level bumps + events)
 *   - addRetrospective
 *
 * Discipline: writes ONLY decision_tasks / task_events / retrospectives /
 * task_watchers. Never the main chain.
 */

import { transition, isTerminal } from "./state-machine.js";
import { sweepEscalations } from "./escalation.js";
import { notifyForTask } from "./notify.js";

// ════════════════════════════════════════════════════════════
// Create (idempotent)
// ════════════════════════════════════════════════════════════

/**
 * Create a decision task. If an active task already exists for the same
 * (source_type, source_ref), returns that existing task instead of creating a
 * duplicate (idempotency — one risk, one owner).
 *
 * @param {Object} supabase
 * @param {Object} input
 * @returns {{ task: Object, created: boolean }}
 */
export async function createTask(supabase, input) {
  // Idempotency check
  if (input.source_ref) {
    const { data: existing } = await supabase
      .from("decision_tasks")
      .select("*")
      .eq("source_type", input.source_type ?? "manual")
      .eq("source_ref", input.source_ref)
      .not("status", "in", "(resolved,dismissed)")
      .maybeSingle();
    if (existing) return { task: existing, created: false };
  }

  const row = {
    title: input.title,
    description: input.description ?? null,
    category: input.category ?? "general",
    severity: input.severity ?? "warn",
    subject_type: input.subject_type ?? null,
    subject_id: input.subject_id ?? null,
    source_type: input.source_type ?? "manual",
    source_ref: input.source_ref ?? null,
    status: "open",
    owner: input.owner ?? null,
    owner_role: input.owner_role ?? null,
    due_at: input.due_at ?? null,
    escalation_policy_id: input.escalation_policy_id ?? null,
    ai_suggested_owner: input.ai_suggested_owner ?? null,
    ai_suggested_due_at: input.ai_suggested_due_at ?? null,
    ai_recommended_action: input.ai_recommended_action ?? null,
    ai_confidence: input.ai_confidence ?? null,
    created_by: input.created_by ?? "system",
  };

  const { data: task, error } = await supabase
    .from("decision_tasks")
    .insert(row)
    .select()
    .single();

  if (error) {
    // Race: another request created the active task between our check and insert.
    if (error.code === "23505" && input.source_ref) {
      const { data: existing } = await supabase
        .from("decision_tasks")
        .select("*")
        .eq("source_type", input.source_type ?? "manual")
        .eq("source_ref", input.source_ref)
        .not("status", "in", "(resolved,dismissed)")
        .maybeSingle();
      if (existing) return { task: existing, created: false };
    }
    throw error;
  }

  await appendEvent(supabase, task.id, {
    event_type: "created",
    to_status: "open",
    actor: input.created_by ?? "system",
    actor_role: input.owner_role ?? null,
    detail: { source_type: row.source_type, source_ref: row.source_ref, severity: row.severity },
    note: input.description ?? null,
    request_id: input.request_id ?? null,
  });

  // If AI provided suggestions, log them as an advisory event
  if (input.ai_suggested_owner || input.ai_suggested_due_at || input.ai_recommended_action) {
    await appendEvent(supabase, task.id, {
      event_type: "ai_suggested",
      actor: "ai",
      detail: {
        suggested_owner: input.ai_suggested_owner,
        suggested_due_at: input.ai_suggested_due_at,
        recommended_action: input.ai_recommended_action,
        confidence: input.ai_confidence,
      },
      request_id: input.request_id ?? null,
    });
  }

  // Notify whoever owns this (or the default queue if unowned). Idempotent.
  await notifyForTask(supabase, "task_created", task);

  return { task, created: true };
}

// ════════════════════════════════════════════════════════════
// Transition
// ════════════════════════════════════════════════════════════

/**
 * Apply a state transition with optimistic concurrency + audit event.
 * @returns {{ ok: boolean, task?: Object, conflict?: Object, error?: string }}
 */
export async function applyTransition(supabase, taskId, action, payload = {}) {
  const { data: task, error: loadErr } = await supabase
    .from("decision_tasks").select("*").eq("id", taskId).maybeSingle();
  if (loadErr) throw loadErr;
  if (!task) return { ok: false, error: "task not found" };

  let result;
  try {
    result = transition(task, action, payload);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  // Persist patch with optimistic concurrency
  const { data: updated, error: updErr } = await supabase
    .from("decision_tasks")
    .update({ ...result.patch, version: task.version + 1 })
    .eq("id", taskId)
    .eq("version", task.version)
    .select()
    .maybeSingle();
  if (updErr) throw updErr;
  if (!updated) {
    const { data: fresh } = await supabase.from("decision_tasks").select("version,status").eq("id", taskId).maybeSingle();
    return { ok: false, conflict: { current_version: fresh?.version, current_status: fresh?.status } };
  }

  await appendEvent(supabase, taskId, { ...result.event, request_id: payload.request_id ?? null });

  // Notify on terminal-positive + reassign transitions.
  if (action === "resolve") {
    await notifyForTask(supabase, "task_resolved", updated);
  } else if (action === "reassign" && payload.owner) {
    await notifyForTask(supabase, "task_reassigned", updated, { new_owner: payload.owner });
  }

  return { ok: true, task: updated };
}

// ════════════════════════════════════════════════════════════
// Set / change deadline + owner (non-status mutations)
// ════════════════════════════════════════════════════════════

export async function setDeadline(supabase, taskId, dueAt, payload = {}) {
  const { data: task } = await supabase.from("decision_tasks").select("*").eq("id", taskId).maybeSingle();
  if (!task) return { ok: false, error: "task not found" };
  const wasSet = !!task.due_at;
  const { data: updated, error } = await supabase
    .from("decision_tasks")
    .update({ due_at: dueAt, version: task.version + 1 })
    .eq("id", taskId).eq("version", task.version)
    .select().maybeSingle();
  if (error) throw error;
  if (!updated) return { ok: false, conflict: true };
  await appendEvent(supabase, taskId, {
    event_type: wasSet ? "deadline_changed" : "deadline_set",
    actor: payload.actor ?? null, actor_role: payload.actor_role ?? null,
    detail: { from: task.due_at, to: dueAt }, request_id: payload.request_id ?? null,
  });
  return { ok: true, task: updated };
}

// ════════════════════════════════════════════════════════════
// Escalation sweep
// ════════════════════════════════════════════════════════════

/**
 * Run one escalation pass. Idempotent: a task only escalates if its overdue
 * duration crosses a NEW policy step above its current level. Safe to re-run.
 *
 * @returns {{ escalated: number, actions: Object[] }}
 */
export async function runEscalationSweep(supabase, opts = {}) {
  const now = opts.now ?? new Date();

  const [{ data: tasks, error: tErr }, { data: policies, error: pErr }] = await Promise.all([
    supabase.from("decision_tasks").select("*")
      .not("status", "in", "(resolved,dismissed)")
      .not("due_at", "is", null),
    supabase.from("escalation_policies").select("*").eq("is_active", true),
  ]);
  if (tErr) throw tErr;
  if (pErr) throw pErr;

  const actions = sweepEscalations(tasks ?? [], policies ?? [], now);

  let escalated = 0;
  let notified = 0;
  for (const action of actions) {
    const task = (tasks ?? []).find((t) => t.id === action.task_id);
    if (!task) continue;
    const { data: updated, error } = await supabase
      .from("decision_tasks")
      .update({
        escalation_level: action.to_level,
        last_escalated_at: now.toISOString(),
        escalated_to: action.notify_role,
        version: task.version + 1,
      })
      .eq("id", task.id)
      .eq("version", task.version)        // concurrency guard
      .select()
      .maybeSingle();
    if (error) { console.error("[escalation] update failed", error.message); continue; }
    if (!updated) continue;               // someone changed it; next sweep retries

    escalated++;
    await appendEvent(supabase, task.id, {
      event_type: "escalated",
      actor: "system",
      detail: {
        from_level: action.from_level, to_level: action.to_level,
        notify_role: action.notify_role, overdue_minutes: action.overdue_minutes,
        policy_id: action.policy_id,
      },
      note: action.reason,
    });
    // Add the escalation target as a watcher
    await supabase.from("task_watchers")
      .upsert({ task_id: task.id, watcher: action.notify_role, reason: "escalation" }, { onConflict: "task_id,watcher" });
    // Notify the escalation target (idempotent per level via dedup_key esc:L{n})
    const r = await notifyForTask(supabase, "task_overdue_escalated", updated, {
      escalation_level: action.to_level, notify_role: action.notify_role,
    });
    if (r.inserted) notified++;
  }

  return { escalated, notified, actions };
}

// ════════════════════════════════════════════════════════════
// Retrospective
// ════════════════════════════════════════════════════════════

export async function addRetrospective(supabase, taskId, input) {
  const { data: task } = await supabase.from("decision_tasks")
    .select("created_at, resolved_at, escalation_level").eq("id", taskId).maybeSingle();
  if (!task) return { ok: false, error: "task not found" };

  const resolutionMinutes = task.resolved_at
    ? Math.round((new Date(task.resolved_at).getTime() - new Date(task.created_at).getTime()) / 60000)
    : null;

  const row = {
    task_id: taskId,
    root_cause: input.root_cause ?? null,
    what_happened: input.what_happened ?? null,
    what_we_did: input.what_we_did ?? null,
    prevention: input.prevention ?? null,
    resolution_time_minutes: resolutionMinutes,
    was_escalated: (task.escalation_level ?? 0) > 0,
    max_escalation_level: task.escalation_level ?? 0,
    was_false_positive: input.was_false_positive ?? null,
    authored_by: input.authored_by ?? "system",
  };
  const { data, error } = await supabase
    .from("retrospectives")
    .upsert(row, { onConflict: "task_id" })
    .select().single();
  if (error) throw error;
  await appendEvent(supabase, taskId, {
    event_type: "comment", actor: input.authored_by ?? "system",
    detail: { retrospective: true, root_cause: row.root_cause }, note: "复盘已记录",
  });
  return { ok: true, retrospective: data };
}

// ── Internal ──

async function appendEvent(supabase, taskId, ev) {
  const { error } = await supabase.from("task_events").insert({ task_id: taskId, ...ev });
  if (error) console.error("[task_events] insert failed:", error.message);
}
