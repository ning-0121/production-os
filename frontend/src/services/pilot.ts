/**
 * Pilot Mode Guards
 *
 * Wraps write operations to enforce pilot policy:
 *   - In pilot mode with writes_blocked: blocks the action, logs it
 *   - In pilot mode with confirmation_required: shows confirm dialog first
 *   - Always logs to audit trail when pilot mode is active
 */

import { pilotPolicy, PILOT_MODE } from "./config";
import { auditLog } from "./audit";

export type GuardResult =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Check if a write action is allowed.
 * Call before any mutation (optimizer confirm, status change, factory edit).
 *
 * Returns { allowed: true } or { allowed: false, reason }.
 * When confirmation is required, shows a browser confirm() dialog.
 */
export function guardWrite(
  action: string,
  category: "optimizer" | "allocation" | "calibration" | "factory",
  detail: Record<string, unknown> = {},
): GuardResult {
  // Not in pilot mode — always allowed, no logging
  if (!PILOT_MODE) return { allowed: true };

  // Pilot mode with writes blocked
  if (pilotPolicy.writes_blocked) {
    auditLog(action, category, detail, true);
    return { allowed: false, reason: "Pilot mode: writes are disabled. Preview only." };
  }

  // Pilot mode with confirmation required
  if (pilotPolicy.confirmation_required) {
    const confirmed = window.confirm(
      `[Pilot Mode] ${action}\n\n` +
      `This will modify production data.\n` +
      `Proceed?`,
    );
    if (!confirmed) {
      auditLog(action, category, { ...detail, user_cancelled: true }, true);
      return { allowed: false, reason: "User cancelled in pilot confirmation dialog." };
    }
  }

  // Allowed — log it
  auditLog(action, category, detail, false);
  return { allowed: true };
}

/**
 * Convenience: check if pilot mode is active.
 */
export function isPilotMode(): boolean {
  return PILOT_MODE;
}

/**
 * Get the pilot mode label for UI display.
 */
export function getPilotLabel(): string | null {
  if (!PILOT_MODE) return null;
  if (pilotPolicy.writes_blocked) return "PILOT: Preview Only";
  if (pilotPolicy.confirmation_required) return "PILOT: Confirm Writes";
  return "PILOT";
}
