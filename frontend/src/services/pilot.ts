/**
 * Pilot Mode Guards — role-aware.
 *
 * Resolves pilot policy from:
 *   1. Backend GET /api/pilot/policy (authoritative, per-role)
 *   2. Frontend VITE_PILOT_MODE flag (fallback)
 *
 * guardWrite() checks the resolved policy before any mutation.
 */

import { PILOT_MODE } from "./config";
import { auditLog, setOperator, getOperator } from "./audit";
import { request } from "./client";

// ── Types ───────────────────────────────────────────────

export type PilotRole = "admin" | "production_manager" | "operator";

export type RolePolicy = {
  can_preview: boolean;
  can_confirm: boolean;
  can_edit_factory: boolean;
  can_calibrate: boolean;
  confirmation_required: boolean;
};

export type GuardResult =
  | { allowed: true }
  | { allowed: false; reason: string };

// ── State ───────────────────────────────────────────────

let _policy: RolePolicy = {
  can_preview: true,
  can_confirm: !PILOT_MODE,
  can_edit_factory: !PILOT_MODE,
  can_calibrate: !PILOT_MODE,
  confirmation_required: PILOT_MODE,
};

let _policyLoaded = false;

/**
 * Initialize pilot mode for a specific operator and role.
 * Fetches role-based policy from backend.
 */
export async function initPilot(operator: string, role: PilotRole): Promise<RolePolicy> {
  setOperator(operator, role);

  try {
    const data = await request<{
      pilot_mode: boolean;
      role: string;
      policy: RolePolicy;
    }>(`/pilot/policy?role=${encodeURIComponent(role)}`);
    _policy = data.policy;
    _policyLoaded = true;
  } catch {
    // Backend unreachable — use frontend-only fallback
    _policy = {
      can_preview: true,
      can_confirm: !PILOT_MODE,
      can_edit_factory: !PILOT_MODE,
      can_calibrate: !PILOT_MODE,
      confirmation_required: PILOT_MODE,
    };
  }

  auditLog("pilot_init", "system", { operator, role, policy: _policy });

  return _policy;
}

/**
 * Get current resolved policy.
 */
export function getPolicy(): RolePolicy {
  return { ..._policy };
}

// ── Action → permission mapping ─────────────────────────

const ACTION_PERMISSIONS: Record<string, keyof RolePolicy> = {
  "optimizer_confirm": "can_confirm",
  "allocation_status_change": "can_confirm",
  "smart_schedule": "can_confirm",
  "factory_edit": "can_edit_factory",
  "capability_edit": "can_edit_factory",
  "calibration_trigger": "can_calibrate",
};

/**
 * Check if a write action is allowed under current policy.
 *
 * @param action — descriptive action name (used as audit label)
 * @param category — audit category
 * @param actionType — maps to a permission key (e.g. "optimizer_confirm")
 * @param detail — extra context for the audit log
 */
export function guardWrite(
  action: string,
  category: "optimizer" | "allocation" | "calibration" | "factory",
  actionType?: string,
  detail: Record<string, unknown> = {},
): GuardResult {
  // Not in pilot mode and no policy loaded — always allowed
  if (!PILOT_MODE && !_policyLoaded) return { allowed: true };

  // Check specific permission
  const permKey = actionType ? ACTION_PERMISSIONS[actionType] : null;
  if (permKey && !_policy[permKey]) {
    auditLog(action, category, { ...detail, action_type: actionType, denied_by: permKey }, true);
    return { allowed: false, reason: `Your role (${getOperator().role}) does not have ${permKey} permission.` };
  }

  // Confirmation dialog
  if (_policy.confirmation_required) {
    const confirmed = window.confirm(
      `[Pilot Mode] ${action}\n\nThis will modify production data.\nProceed?`,
    );
    if (!confirmed) {
      auditLog(action, category, { ...detail, user_cancelled: true }, true);
      return { allowed: false, reason: "User cancelled." };
    }
  }

  // Allowed
  auditLog(action, category, { ...detail, action_type: actionType }, false);
  return { allowed: true };
}

/**
 * Check if pilot mode is active.
 */
export function isPilotMode(): boolean {
  return PILOT_MODE;
}

/**
 * Get display label for the pilot badge.
 */
export function getPilotLabel(): string | null {
  if (!PILOT_MODE) return null;
  const { role } = getOperator();
  if (!_policy.can_confirm) return `PILOT: ${role} (read-only)`;
  if (_policy.confirmation_required) return `PILOT: ${role} (confirm writes)`;
  return `PILOT: ${role}`;
}
