/**
 * Escalation Engine — pure. Decides which tasks need escalating and to what level.
 *
 * Escalation is time-driven and policy-driven:
 *   - A task has a due_at and an escalation_policy with ordered steps.
 *   - Each step: { level, after_minutes, notify_role }.
 *   - after_minutes is measured FROM due_at (overdue duration), so a step with
 *     after_minutes:240 fires 4h after the deadline passed.
 *   - The engine returns the HIGHEST step whose threshold has elapsed and which
 *     is above the task's current escalation_level → one escalation per sweep.
 *
 * Pure: caller passes tasks + policies + "now"; gets back escalation actions.
 * No DB, no clock side-effects (now is injected for deterministic tests).
 */

import { isTerminal } from "./state-machine.js";

/**
 * @typedef {Object} EscalationStep
 * @property {number} level
 * @property {number} after_minutes   minutes after due_at before this step fires
 * @property {string} notify_role
 */

/**
 * @typedef {Object} EscalationAction
 * @property {string} task_id
 * @property {number} from_level
 * @property {number} to_level
 * @property {string} notify_role
 * @property {number} overdue_minutes
 * @property {string} reason
 */

/**
 * Compute the escalation action for a SINGLE task, or null if none due.
 *
 * @param {Object} task    { id, status, due_at, escalation_level, severity }
 * @param {EscalationStep[]} steps   the task's policy steps (ordered or not)
 * @param {Date} now
 * @returns {EscalationAction | null}
 */
export function computeEscalation(task, steps, now) {
  if (!task || isTerminal(task.status)) return null;
  if (!task.due_at) return null;
  if (!Array.isArray(steps) || steps.length === 0) return null;

  const dueMs = new Date(task.due_at).getTime();
  if (!Number.isFinite(dueMs)) return null;
  const overdueMinutes = (now.getTime() - dueMs) / 60000;
  if (overdueMinutes <= 0) return null;   // not overdue yet

  const currentLevel = Number(task.escalation_level ?? 0);

  // Find the highest step whose threshold has elapsed AND is above current level.
  const eligible = steps
    .filter((s) => Number(s.after_minutes) <= overdueMinutes && Number(s.level) > currentLevel)
    .sort((a, b) => Number(b.level) - Number(a.level));

  if (eligible.length === 0) return null;
  const step = eligible[0];

  return {
    task_id: task.id,
    from_level: currentLevel,
    to_level: Number(step.level),
    notify_role: step.notify_role,
    overdue_minutes: Math.round(overdueMinutes),
    reason: `逾期 ${formatDuration(overdueMinutes)} 未解决，升级至 L${step.level}（通知 ${step.notify_role}）`,
  };
}

/**
 * Pick the policy that best matches a task. More specific wins:
 *   exact category + severity match > category match > wildcard.
 *
 * @param {Object} task
 * @param {Object[]} policies   active escalation_policies
 * @returns {Object | null}
 */
export function pickPolicy(task, policies) {
  if (!Array.isArray(policies)) return null;
  const active = policies.filter((p) => p.is_active !== false);
  const sevRank = { ok: 0, warn: 1, critical: 2 };
  const taskSev = sevRank[task.severity] ?? 1;

  const scored = active
    .filter((p) => {
      // Category must match or be wildcard
      if (p.category && p.category !== task.category) return false;
      // min_severity gate
      if (p.min_severity && (sevRank[p.min_severity] ?? 0) > taskSev) return false;
      return true;
    })
    .map((p) => ({
      policy: p,
      specificity: (p.category ? 2 : 0) + (p.min_severity ? 1 : 0),
    }))
    .sort((a, b) => b.specificity - a.specificity);

  return scored.length > 0 ? scored[0].policy : null;
}

/**
 * Sweep many tasks against their policies. Returns the list of escalation
 * actions to apply. Caller resolves each task's policy first (or passes a
 * policyResolver).
 *
 * @param {Object[]} tasks
 * @param {Object[]} policies
 * @param {Date} now
 * @returns {EscalationAction[]}
 */
export function sweepEscalations(tasks, policies, now) {
  const actions = [];
  for (const task of tasks ?? []) {
    const policy = pickPolicy(task, policies);
    if (!policy) continue;
    const action = computeEscalation(task, policy.steps ?? [], now);
    if (action) {
      action.policy_id = policy.id;
      actions.push(action);
    }
  }
  return actions;
}

// ── Helpers ──

function formatDuration(minutes) {
  const m = Math.round(minutes);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时`;
  const d = Math.floor(h / 24);
  return `${d} 天 ${h % 24} 小时`;
}
