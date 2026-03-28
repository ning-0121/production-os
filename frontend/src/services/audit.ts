/**
 * Pilot Mode Audit Logger
 *
 * Records all significant user actions during pilot rollout.
 * Entries stored in memory and downloadable as JSON.
 *
 * Only active when pilot mode is on — zero overhead otherwise.
 */

import { PILOT_MODE, API_BASE_URL } from "./config";

export type AuditEntry = {
  timestamp: string;
  action: string;
  category: "optimizer" | "allocation" | "calibration" | "factory" | "system";
  detail: Record<string, unknown>;
  blocked: boolean;
};

const log: AuditEntry[] = [];

/**
 * Record an action. No-op when pilot mode is off.
 */
export function auditLog(
  action: string,
  category: AuditEntry["category"],
  detail: Record<string, unknown> = {},
  blocked = false,
) {
  if (!PILOT_MODE) return;

  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    action,
    category,
    detail,
    blocked,
  };
  log.push(entry);

  // Also log to console in pilot mode for visibility
  const prefix = blocked ? "[BLOCKED]" : "[AUDIT]";
  console.log(`${prefix} ${action}`, detail);
}

/**
 * Get all audit entries.
 */
export function getAuditLog(): AuditEntry[] {
  return [...log];
}

/**
 * Get audit summary.
 */
export function getAuditSummary() {
  const total = log.length;
  const blocked = log.filter((e) => e.blocked).length;
  const byCategory: Record<string, number> = {};
  for (const e of log) {
    byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
  }
  return { total, blocked, allowed: total - blocked, by_category: byCategory };
}

/**
 * Download audit log as JSON file.
 */
export function downloadAuditLog() {
  const data = {
    exported_at: new Date().toISOString(),
    pilot_mode: PILOT_MODE,
    api_base_url: API_BASE_URL,
    entry_count: log.length,
    entries: log,
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pilot-audit-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// Expose to console
if (PILOT_MODE && typeof window !== "undefined") {
  const w = window as unknown as Record<string, unknown>;
  const prodOS = (w.__prodOS as Record<string, unknown>) ?? {};
  prodOS.audit = { getLog: getAuditLog, getSummary: getAuditSummary, download: downloadAuditLog };
  w.__prodOS = prodOS;
}
