/**
 * Shopfloor Work-Order State Machine — pure, no I/O.
 *
 *   pending ──start──> in_progress ──pause──> paused ──resume──> in_progress
 *      │                    │                                          │
 *      │                    ├──block──> blocked ──resume/unblock──> in_progress
 *      │                    └──complete──> completed
 *      └──block──> blocked
 *
 * Mirrors the discipline of the decision-task state machine: illegal
 * transitions throw; each action yields a patch + an audit event.
 */

export const STATUSES = ["pending", "in_progress", "paused", "completed", "blocked"];
export const TERMINAL = new Set(["completed"]);

const TRANSITIONS = {
  pending:     { start: "in_progress", block: "blocked" },
  in_progress: { pause: "paused", block: "blocked", complete: "completed" },
  paused:      { resume: "in_progress", block: "blocked", complete: "completed" },
  blocked:     { resume: "in_progress", complete: "completed" },
  completed:   { /* terminal */ },
};

/** action → shopfloor_events.event_type */
export const ACTION_EVENT = {
  start: "start_work",
  pause: "pause_work",
  resume: "resume_work",
  complete: "complete_work",
  block: "report_blocked",
};

/**
 * Compute next state + DB patch + audit event for an action.
 * @param {object} wo      current work order ({status, ...})
 * @param {string} action  start|pause|resume|complete|block
 * @param {object} payload { actor, block_reason?, note? }
 */
export function transition(wo, action, payload = {}) {
  const from = wo.status;
  const allowed = TRANSITIONS[from];
  if (!allowed) throw new Error(`Unknown work-order status: ${from}`);
  const to = allowed[action];
  if (!to) throw new Error(`Illegal transition: cannot '${action}' from '${from}' (allowed: ${Object.keys(allowed).join(", ") || "none"})`);

  if (action === "block" && !payload.block_reason) {
    throw new Error("Action 'block' requires block_reason");
  }

  const now = new Date().toISOString();
  const patch = { status: to };
  const detail = {};

  if (action === "start") {
    patch.actual_start_at = wo.actual_start_at ?? now;   // first start only
  } else if (action === "complete") {
    patch.actual_end_at = now;
    patch.block_reason = null;
  } else if (action === "block") {
    patch.block_reason = payload.block_reason;
    detail.block_reason = payload.block_reason;
  } else if (action === "resume") {
    patch.block_reason = null;
  }

  return {
    from, to,
    event_type: ACTION_EVENT[action] ?? action,
    patch,
    event: {
      event_type: ACTION_EVENT[action] ?? action,
      payload: { from, to, actor: payload.actor ?? null, ...detail, note: payload.note ?? null },
    },
  };
}

export function isTerminal(status) { return TERMINAL.has(status); }
export function legalActions(status) { return Object.keys(TRANSITIONS[status] ?? {}); }

/** Progress % (zero-safe). */
export function progressPct(wo) {
  const planned = Number(wo?.planned_qty) || 0;
  const completed = Number(wo?.completed_qty) || 0;
  if (planned <= 0) return 0;
  return Math.min(100, Math.round((completed / planned) * 100));
}
