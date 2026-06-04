/**
 * Decision Task State Machine — pure, no I/O.
 *
 * The single authority on which task transitions are legal. Every status
 * change in the system goes through `transition()`. Illegal transitions throw
 * so bugs surface loudly instead of corrupting accountability state.
 *
 *   open ──claim──> acknowledged ──start──> in_progress ──resolve──> resolved
 *     │                  │                       │  ▲
 *     │                  │              block │  │ unblock
 *     │                  │                       ▼  │
 *     │                  │                     blocked
 *     │                  └──────── start ───────┘
 *   (any non-terminal) ──dismiss──> dismissed
 *   resolved ──reopen──> in_progress
 *
 * Escalation is NOT a status — it's a separate dimension (escalation_level)
 * that increases while a task sits unresolved past its deadline. See escalation.js.
 */

export const STATUSES = /** @type {const} */ ([
  "open", "acknowledged", "in_progress", "blocked", "resolved", "dismissed",
]);

export const TERMINAL_STATUSES = new Set(["resolved", "dismissed"]);

/**
 * Allowed transitions: from-status → { action → to-status }.
 * The action name becomes the task_event.event_type (mostly).
 */
const TRANSITIONS = {
  open: {
    claim: "acknowledged",
    start: "in_progress",     // owner can claim+start in one move
    dismiss: "dismissed",
  },
  acknowledged: {
    start: "in_progress",
    dismiss: "dismissed",
    reassign: "acknowledged", // owner change, stays acknowledged
  },
  in_progress: {
    block: "blocked",
    resolve: "resolved",
    dismiss: "dismissed",
    reassign: "in_progress",
  },
  blocked: {
    unblock: "in_progress",
    dismiss: "dismissed",
    reassign: "blocked",
  },
  resolved: {
    reopen: "in_progress",
  },
  dismissed: {
    // terminal — but allow reopen for mistaken dismissals
    reopen: "in_progress",
  },
};

/** Map an action to its canonical task_event.event_type. */
export const ACTION_EVENT = {
  claim: "claimed",
  start: "started",
  block: "blocked",
  unblock: "unblocked",
  resolve: "resolved",
  dismiss: "dismissed",
  reopen: "reopened",
  reassign: "reassigned",
};

/**
 * Fields each action REQUIRES in its payload. Enforced by transition().
 */
const REQUIRED_FIELDS = {
  dismiss: ["dismissed_reason"],
  block: ["blocked_reason"],
  resolve: ["resolution_note"],
  reassign: ["owner"],
};

/**
 * @typedef {Object} TransitionResult
 * @property {string} from
 * @property {string} to
 * @property {string} event_type
 * @property {Object} patch          fields to persist on the task
 * @property {Object} event          the task_event row to append (sans task_id)
 */

/**
 * Compute the next state + the DB patch + the audit event for an action.
 * Pure — does not mutate input. Throws on illegal transition or missing fields.
 *
 * @param {Object} task     current task row (needs at least { status, owner })
 * @param {string} action   one of the transition action names
 * @param {Object} payload  { actor, actor_role, owner?, due_at?, resolution_note?, blocked_reason?, dismissed_reason?, note? }
 * @returns {TransitionResult}
 */
export function transition(task, action, payload = {}) {
  const from = task.status;
  const allowed = TRANSITIONS[from];
  if (!allowed) throw new Error(`Unknown current status: ${from}`);
  const to = allowed[action];
  if (!to) {
    throw new Error(`Illegal transition: cannot '${action}' from '${from}' (allowed: ${Object.keys(allowed).join(", ") || "none"})`);
  }

  // Required fields
  const required = REQUIRED_FIELDS[action] ?? [];
  for (const f of required) {
    if (payload[f] == null || payload[f] === "") {
      throw new Error(`Action '${action}' requires field '${f}'`);
    }
  }

  const now = new Date().toISOString();
  const patch = { status: to };
  const eventDetail = {};

  switch (action) {
    case "claim":
      patch.owner = payload.owner ?? task.owner;
      patch.owner_role = payload.actor_role ?? task.owner_role;
      break;
    case "start":
      if (payload.owner) { patch.owner = payload.owner; patch.owner_role = payload.actor_role; }
      break;
    case "block":
      patch.blocked_reason = payload.blocked_reason;
      eventDetail.blocked_reason = payload.blocked_reason;
      break;
    case "unblock":
      patch.blocked_reason = null;
      break;
    case "resolve":
      patch.resolution_note = payload.resolution_note;
      patch.resolved_by = payload.actor ?? null;
      patch.resolved_at = now;
      eventDetail.resolution_note = payload.resolution_note;
      break;
    case "dismiss":
      patch.dismissed_reason = payload.dismissed_reason;
      patch.resolved_by = payload.actor ?? null;
      patch.resolved_at = now;
      eventDetail.dismissed_reason = payload.dismissed_reason;
      break;
    case "reopen":
      patch.resolution_note = null;
      patch.dismissed_reason = null;
      patch.resolved_at = null;
      patch.resolved_by = null;
      break;
    case "reassign":
      patch.owner = payload.owner;
      patch.owner_role = payload.owner_role ?? null;
      eventDetail.from_owner = task.owner;
      eventDetail.to_owner = payload.owner;
      break;
    default:
      break;
  }

  return {
    from,
    to,
    event_type: ACTION_EVENT[action] ?? action,
    patch,
    event: {
      event_type: ACTION_EVENT[action] ?? action,
      from_status: from,
      to_status: to,
      actor: payload.actor ?? null,
      actor_role: payload.actor_role ?? null,
      detail: eventDetail,
      note: payload.note ?? null,
    },
  };
}

/** Is a status terminal (closed)? */
export function isTerminal(status) {
  return TERMINAL_STATUSES.has(status);
}

/** List the legal actions from a given status (for UI button enablement). */
export function legalActions(status) {
  return Object.keys(TRANSITIONS[status] ?? {});
}
