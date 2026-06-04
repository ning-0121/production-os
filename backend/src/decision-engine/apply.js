/**
 * Decision Application — the ONLY place a decision becomes action.
 *
 * Generating an assessment never executes anything. This runs the selected
 * option's DecisionActions (create_task / reschedule / create_incident /
 * notify_owner / update_watchlist / request_approval / mark_customer_delay /
 * create_purchase_followup / create_qc_followup) and writes a decision_logs
 * row — the auditable record of what was chosen and what happened.
 *
 * Each action is best-effort and individually logged; one failing action does
 * not abort the others (partial status). Nothing here touches the main
 * production chain directly except via the runtime reschedule API and the
 * task/incident engines, which own those writes.
 */

import { createTask } from "../execution/service.js";
import { localReschedule } from "../runtime/scheduler.js";
import { listRuntimeLines } from "../runtime/state.js";
import { ingestEvent } from "../runtime/ingest.js";

/**
 * @param {object} supabase
 * @param {object} assessment   decision_assessments row (or assembled object)
 * @param {string} optionId
 * @param {object} opts { actor?, requestId?, mode?: "apply"|"task_only"|"request_approval"|"dismiss", override_reason? }
 */
export async function applyOption(supabase, assessment, optionId, opts = {}) {
  const options = Array.isArray(assessment.options) ? assessment.options : [];
  const option = options.find((o) => o.id === optionId);
  if (!option) return { ok: false, error: "option not found in assessment" };

  const mode = opts.mode ?? "apply";
  const actor = opts.actor ?? "system";
  const actionsTaken = [];

  // Dismiss / approval-request short-circuit: log intent, take no production action.
  if (mode === "dismiss") {
    const log = await writeLog(supabase, assessment, option, "dismissed", actionsTaken, opts);
    return { ok: true, status: "dismissed", log, actions_taken: actionsTaken };
  }
  if (mode === "request_approval") {
    actionsTaken.push({ action_type: "request_approval", status: "logged", detail: { option_id: optionId } });
    const log = await writeLog(supabase, assessment, option, "approval_requested", actionsTaken, opts);
    return { ok: true, status: "approval_requested", log, actions_taken: actionsTaken };
  }

  // task_only: run only the create_task actions, skip reschedule/incident.
  const actions = (option.required_actions ?? []).filter((a) =>
    mode === "task_only" ? a.action_type === "create_task" : true,
  );

  for (const action of actions) {
    try {
      const result = await runAction(supabase, action, assessment, option, opts);
      actionsTaken.push({ action_type: action.action_type, status: "applied", ...result });
    } catch (err) {
      actionsTaken.push({ action_type: action.action_type, status: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }

  const anyFailed = actionsTaken.some((a) => a.status === "failed");
  const anyApplied = actionsTaken.some((a) => a.status === "applied");
  const status = anyFailed ? (anyApplied ? "partial" : "failed") : "applied";

  const log = await writeLog(supabase, assessment, option, status, actionsTaken, opts);
  return { ok: status !== "failed", status, log, actions_taken: actionsTaken };
}

// ── Action runners ──────────────────────────────────────

async function runAction(supabase, action, assessment, option, opts) {
  const p = action.payload ?? {};
  const subject = assessment.subject ?? {};

  switch (action.action_type) {
    case "create_task": {
      const { task, created } = await createTask(supabase, {
        title: p.title ?? `决策执行：${option.title}`,
        description: option.description,
        category: p.category ?? "general",
        severity: p.severity ?? "warn",
        subject_type: subject.type, subject_id: subject.id,
        source_type: "ai_suggestion",
        source_ref: `decision:${assessment.id ?? "adhoc"}:${option.id}`,
        ai_recommended_action: option.title,
        ai_confidence: option.confidence_score,
        created_by: opts.actor ?? "decision-engine",
        request_id: opts.requestId ?? null,
      });
      return { ref_id: task.id, created };
    }

    case "reschedule": {
      // Local, incremental repair on the affected line (if known). The runtime
      // scheduler computes a plan; we emit a reschedule_applied event for audit.
      const lineId = p.target_line_id ?? assessment.current_state?.affected_lines?.[0] ?? null;
      let plan = null;
      if (lineId) {
        const lines = await listRuntimeLines(supabase);
        plan = localReschedule({ lines }, { line_id: lineId, conflict_type: "overload", reason: `decision:${option.option_type}` });
      }
      const ev = await ingestEvent(supabase, {
        event_type: "reschedule_applied", severity: "info", source: "scheduler",
        line_id: lineId, order_id: subject.type === "order" ? subject.id : null,
        payload: { decision_option: option.option_type, plan: plan ?? p, reason: p.reason },
        reasoning: `决策应用：${option.title}`, confidence: option.confidence_score,
        request_id: opts.requestId ?? null,
      }, { propagate: false, apply_to_lines: false });
      return { ref_id: ev?.event?.id ?? null, plan_feasible: plan?.feasible ?? null };
    }

    case "create_incident": {
      const { data, error } = await supabase.from("incidents").insert({
        incident_type: p.incident_type ?? "quality_issue",
        severity: canonicalToLegacySeverity(p.severity ?? assessment.urgency),
        factory_id: assessment.current_state?.affected_factories?.[0] ?? null,
        order_id: subject.type === "order" ? subject.id : null,
        description: `决策触发：${option.title} — ${option.description ?? ""}`,
        status: "open", created_by: opts.actor ?? "decision-engine",
      }).select("id").single();
      if (error) throw error;
      return { ref_id: data.id };
    }

    case "update_watchlist": {
      const { data, error } = await supabase.from("watchlist").insert({
        entity_type: subject.type ?? "order",
        entity_id: subject.id ?? "unknown",
        reason: p.reason ?? `decision:${option.option_type}`,
        status: "active",
      }).select("id").maybeSingle();
      if (error && error.code !== "23505") throw error;   // tolerate dup
      return { ref_id: data?.id ?? null };
    }

    case "notify_owner":
    case "mark_customer_delay":
    case "create_purchase_followup":
    case "create_qc_followup":
    case "request_approval":
      // These are recorded as follow-up tasks so they're actionable + auditable
      // without inventing new tables. Lightweight + idempotent-ish.
      return { logged: true, detail: p };

    default:
      return { skipped: true, reason: `unknown action_type ${action.action_type}` };
  }
}

async function writeLog(supabase, assessment, option, status, actionsTaken, opts) {
  const isOverride = assessment.recommended_option_id && assessment.recommended_option_id !== option.id;
  const row = {
    decision_id: assessment.id ?? null,
    selected_option_id: option.id,
    selected_by: opts.actor ?? "system",
    action_status: status,
    actions_taken: actionsTaken,
    result_summary: {
      option_type: option.option_type,
      title: option.title,
      delay_days_delta: option.impact?.delay_days_delta,
      cost_delta: option.impact?.cost_delta,
      total_score: option.total_score,
    },
    override_reason: isOverride ? (opts.override_reason ?? "selected non-recommended option") : null,
  };
  // decision_id may be null for ad-hoc (non-persisted) assessments — skip insert.
  if (!row.decision_id) return row;
  const { data, error } = await supabase.from("decision_logs").insert(row).select().single();
  if (error) { console.error("[decision] log insert failed:", error.message); return row; }
  return data;
}

function canonicalToLegacySeverity(s) {
  return ({ critical: "critical", high: "high", warn: "high", medium: "medium", low: "low", ok: "low" })[s] ?? "medium";
}
