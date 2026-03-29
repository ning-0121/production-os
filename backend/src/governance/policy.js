/**
 * Central Policy Engine
 *
 * Single source of truth for authorization decisions.
 * Pure functions — no DB, no Express dependency.
 *
 * Usage:
 *   import { can, resolveRole } from "./governance/policy.js";
 *   const decision = can(role, "optimizer.confirm", { pilot_mode: true });
 *   if (!decision.allowed) return res.status(403).json({ error: decision.reason });
 */

// ── Action Registry ─────────────────────────────────────
// Every action the system can perform, its risk level, and description.

export const ACTIONS = {
  // Reads (always allowed)
  "data.read":             { risk: "none",   desc: "Read any data" },
  "optimizer.preview":     { risk: "none",   desc: "Run optimizer dry-run" },
  "risk.scan":             { risk: "low",    desc: "Run risk scan (writes risk_alerts)" },
  "recommend.compute":     { risk: "none",   desc: "Compute factory recommendation" },

  // Writes
  "optimizer.confirm":     { risk: "high",   desc: "Persist optimizer allocations" },
  "allocation.create":     { risk: "medium", desc: "Create new allocation" },
  "allocation.update":     { risk: "medium", desc: "Update allocation status/dates" },
  "allocation.delete":     { risk: "high",   desc: "Delete allocation" },
  "allocation.schedule":   { risk: "high",   desc: "Smart-schedule an allocation" },
  "factory.update":        { risk: "medium", desc: "Edit factory fields" },
  "capability.update":     { risk: "medium", desc: "Edit factory capability" },
  "calibration.trigger":   { risk: "medium", desc: "Trigger recalibration" },
  "calibration.complete":  { risk: "medium", desc: "Record order completion" },
  "tasks.generate":        { risk: "low",    desc: "Generate visit tasks" },
  "tasks.update":          { risk: "low",    desc: "Update visit task" },
  "geofence.update":       { risk: "low",    desc: "Update geofence" },

  // System
  "audit.write":           { risk: "none",   desc: "Write audit entry (always allowed)" },
};

// ── Role → Action Permission Matrix ─────────────────────

const ROLE_MATRIX = {
  admin: {
    // Admin can do everything in any mode
    _default: true,
  },
  production_manager: {
    "data.read": true,
    "optimizer.preview": true,
    "recommend.compute": true,
    "risk.scan": true,
    "optimizer.confirm": { normal: true, pilot: false },
    "allocation.create": { normal: true, pilot: false },
    "allocation.update": { normal: true, pilot: false },
    "allocation.delete": false,
    "allocation.schedule": { normal: true, pilot: false },
    "factory.update": { normal: true, pilot: false },
    "capability.update": { normal: true, pilot: false },
    "calibration.trigger": false,
    "calibration.complete": { normal: true, pilot: false },
    "tasks.generate": true,
    "tasks.update": true,
    "geofence.update": false,
    "audit.write": true,
  },
  operator: {
    "data.read": true,
    "optimizer.preview": true,
    "recommend.compute": true,
    "risk.scan": true,
    "optimizer.confirm": false,
    "allocation.create": false,
    "allocation.update": false,
    "allocation.delete": false,
    "allocation.schedule": false,
    "factory.update": false,
    "capability.update": false,
    "calibration.trigger": false,
    "calibration.complete": false,
    "tasks.generate": true,
    "tasks.update": { normal: true, pilot: false },
    "geofence.update": false,
    "audit.write": true,
  },
};

// ── Core decision function ──────────────────────────────

/**
 * @param {string} role
 * @param {string} action — key from ACTIONS
 * @param {{ pilot_mode?: boolean }} [context]
 * @returns {{ allowed: boolean, reason?: string, action_info?: object }}
 */
export function can(role, action, context = {}) {
  const pilotMode = context.pilot_mode ?? false;
  const actionInfo = ACTIONS[action];

  // Unknown action → deny
  if (!actionInfo) {
    return { allowed: false, reason: `Unknown action: ${action}`, action_info: null };
  }

  // Audit writes always allowed
  if (action === "audit.write") {
    return { allowed: true, action_info: actionInfo };
  }

  // Get role matrix
  const matrix = ROLE_MATRIX[role];
  if (!matrix) {
    return { allowed: false, reason: `Unknown role: ${role}`, action_info: actionInfo };
  }

  // Admin default: allow everything
  if (matrix._default === true) {
    return { allowed: true, action_info: actionInfo };
  }

  const permission = matrix[action];

  // Not in matrix → deny
  if (permission === undefined) {
    return { allowed: false, reason: `Action ${action} not permitted for role ${role}`, action_info: actionInfo };
  }

  // Boolean: static allow/deny
  if (typeof permission === "boolean") {
    return permission
      ? { allowed: true, action_info: actionInfo }
      : { allowed: false, reason: `Role ${role} cannot ${actionInfo.desc}`, action_info: actionInfo };
  }

  // Object with mode-based permissions
  if (typeof permission === "object") {
    const modeKey = pilotMode ? "pilot" : "normal";
    const allowed = permission[modeKey] ?? false;
    return allowed
      ? { allowed: true, action_info: actionInfo }
      : { allowed: false, reason: `Role ${role} cannot ${actionInfo.desc} in ${modeKey} mode`, action_info: actionInfo };
  }

  return { allowed: false, reason: "Invalid permission configuration", action_info: actionInfo };
}

// ── Route → Action mapping ──────────────────────────────

const ROUTE_ACTION_MAP = {
  "POST /api/optimizer/run":              "optimizer.preview", // checked deeper for confirm
  "POST /api/risks/scan":                 "risk.scan",
  "POST /api/recommend":                  "recommend.compute",
  "POST /api/risk":                       "recommend.compute",
  "POST /api/pilot/audit":               "audit.write",
  "POST /api/geofences/generate-tasks":  "tasks.generate",
  "POST /api/allocations":               "allocation.create",
  "PATCH /api/allocations":              "allocation.update",
  "DELETE /api/allocations":             "allocation.delete",
  "PATCH /api/factories":                "factory.update",
  "PATCH /api/factories/capabilities":   "capability.update",
  "PATCH /api/geofences/tasks":          "tasks.update",
  "POST /api/calibration/complete":      "calibration.complete",
  "POST /api/calibration/recalibrate":   "calibration.trigger",
};

/**
 * Map an HTTP request to a policy action.
 */
export function resolveAction(method, path, body) {
  // Reads always map to data.read
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return "data.read";
  }

  // Optimizer confirm is a special case
  if (method === "POST" && path.match(/^\/api\/optimizer\/run/)) {
    return body?.options?.dry_run === false ? "optimizer.confirm" : "optimizer.preview";
  }

  // Allocation schedule
  if (method === "POST" && path.match(/^\/api\/allocations\/[^/]+\/schedule/)) {
    return "allocation.schedule";
  }

  // Allocation recommend
  if (method === "POST" && path.match(/^\/api\/allocations\/[^/]+\/recommend/)) {
    return "optimizer.preview";
  }

  // Pattern match for parameterized routes
  const exactKey = `${method} ${path}`;
  if (ROUTE_ACTION_MAP[exactKey]) return ROUTE_ACTION_MAP[exactKey];

  // Prefix match for parameterized routes (e.g. PATCH /api/allocations/123)
  // Sort by pattern length descending so more specific patterns match first
  const sorted = Object.entries(ROUTE_ACTION_MAP).sort(([a], [b]) => b.length - a.length);
  for (const [pattern, action] of sorted) {
    const [m, p] = pattern.split(" ");
    if (m === method && path.startsWith(p)) return action;
  }

  // Unknown write → deny by default
  return null;
}

// ── Role resolution ─────────────────────────────────────

/**
 * Resolve the operator's role from the request.
 *
 * Current: reads x-pilot-role header (trusted during pilot).
 * Future: replace with JWT/session-based resolution.
 *
 * @param {object} req — Express request
 * @returns {{ role: string, operator: string, auth_method: string }}
 */
export function resolveRole(req) {
  // FUTURE: JWT/session auth
  // const token = req.headers.authorization?.split(" ")[1];
  // if (token) {
  //   const payload = verifyJWT(token);
  //   return { role: payload.role, operator: payload.sub, auth_method: "jwt" };
  // }

  // PILOT PHASE: trust header (acceptable for internal rollout)
  const headerRole = req.headers["x-pilot-role"];
  const headerOperator = req.headers["x-pilot-operator"];

  if (headerRole && ROLE_MATRIX[headerRole]) {
    return {
      role: headerRole,
      operator: headerOperator ?? "anonymous",
      auth_method: "header",
    };
  }

  // Default: operator (lowest privilege)
  return { role: "operator", operator: "anonymous", auth_method: "default" };
}
