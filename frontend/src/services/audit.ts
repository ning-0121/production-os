/**
 * Audit Logger — persists to backend, falls back to memory.
 *
 * Every significant action is:
 *   1. Stored in local memory (instant access for UI)
 *   2. Sent to POST /api/pilot/audit (persistent storage in Supabase)
 *
 * Active in pilot mode. Lightweight no-op otherwise.
 */

import { PILOT_MODE, API_BASE_URL } from "./config";

export type AuditEntry = {
  timestamp: string;
  operator: string;
  role: string;
  action: string;
  category: "optimizer" | "allocation" | "calibration" | "factory" | "system";
  blocked: boolean;
  page: string;
  detail: Record<string, unknown>;
};

// In-memory log (always available, no async)
const localLog: AuditEntry[] = [];

// Current operator context (set once on init)
let _operator = "anonymous";
let _role = "operator";

export function setOperator(operator: string, role: string) {
  _operator = operator;
  _role = role;
}

export function getOperator() {
  return { operator: _operator, role: _role };
}

/**
 * Record an action. Persists to backend asynchronously.
 * Never throws — fire-and-forget for persistence.
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
    operator: _operator,
    role: _role,
    action,
    category,
    blocked,
    page: getCurrentPage(),
    detail,
  };

  localLog.push(entry);

  const prefix = blocked ? "[BLOCKED]" : "[AUDIT]";
  console.log(`${prefix} ${action}`, { category, operator: _operator, ...detail });

  // Fire-and-forget persistence
  persistEntry(entry).catch(() => {
    // Silent — entry is still in localLog
  });
}

async function persistEntry(entry: AuditEntry) {
  try {
    await fetch(`${API_BASE_URL}/pilot/audit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operator: entry.operator,
        role: entry.role,
        action: entry.action,
        category: entry.category,
        blocked: entry.blocked,
        page: entry.page,
        detail: entry.detail,
      }),
    });
  } catch {
    // Network error — entry persisted locally only
  }
}

function getCurrentPage(): string {
  if (typeof document === "undefined") return "unknown";
  // Read from a data attribute on the container, or fall back to title
  return document.querySelector("[data-page]")?.getAttribute("data-page") ?? "app";
}

/**
 * Get all local audit entries.
 */
export function getAuditLog(): AuditEntry[] {
  return [...localLog];
}

/**
 * Get audit summary from local log.
 */
export function getAuditSummary() {
  const total = localLog.length;
  const blocked = localLog.filter((e) => e.blocked).length;
  const byCategory: Record<string, number> = {};
  const byAction: Record<string, number> = {};
  for (const e of localLog) {
    byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
    byAction[e.action] = (byAction[e.action] ?? 0) + 1;
  }
  return {
    total,
    blocked,
    allowed: total - blocked,
    by_category: byCategory,
    by_action: byAction,
    operator: _operator,
    role: _role,
  };
}

/**
 * Download local audit log as JSON file.
 */
export function downloadAuditLog() {
  const data = {
    exported_at: new Date().toISOString(),
    pilot_mode: PILOT_MODE,
    operator: _operator,
    role: _role,
    api_base_url: API_BASE_URL,
    entry_count: localLog.length,
    entries: localLog,
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pilot-audit-${_operator}-${new Date().toISOString().slice(0, 10)}.json`;
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
