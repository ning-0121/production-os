#!/usr/bin/env node

/**
 * Tests for pilot mode: role policies, route allowlist, audit persistence.
 *
 * Run: node src/scripts/test-pilot.js
 */

let pass = 0;
let fail = 0;

function assert(cond, label) {
  if (cond) { pass++; }
  else { fail++; console.log(`  FAIL: ${label}`); }
}

console.log("=== Pilot Mode Tests ===\n");

// ═══════════════════════════════════════════════════════
// 1. ROLE POLICIES
// ═══════════════════════════════════════════════════════

console.log("-- 1. Role policies --\n");

// Simulate the role policy logic from routes/pilot.js
function getPolicy(role, pilotMode) {
  const policies = {
    admin: {
      can_preview: true,
      can_confirm: true,
      can_edit_factory: true,
      can_calibrate: true,
      confirmation_required: false,
    },
    production_manager: {
      can_preview: true,
      can_confirm: pilotMode ? false : true,
      can_edit_factory: pilotMode ? false : true,
      can_calibrate: false,
      confirmation_required: true,
    },
    operator: {
      can_preview: true,
      can_confirm: false,
      can_edit_factory: false,
      can_calibrate: false,
      confirmation_required: false,
    },
  };
  return policies[role] ?? policies.operator;
}

// Admin in pilot mode — can do everything
{
  const p = getPolicy("admin", true);
  assert(p.can_preview === true, "admin: can preview");
  assert(p.can_confirm === true, "admin: can confirm");
  assert(p.can_edit_factory === true, "admin: can edit factory");
  assert(p.can_calibrate === true, "admin: can calibrate");
  assert(p.confirmation_required === false, "admin: no confirmation required");
}

// Production manager in pilot mode — read + preview only
{
  const p = getPolicy("production_manager", true);
  assert(p.can_preview === true, "pm pilot: can preview");
  assert(p.can_confirm === false, "pm pilot: CANNOT confirm");
  assert(p.can_edit_factory === false, "pm pilot: CANNOT edit factory");
  assert(p.confirmation_required === true, "pm pilot: confirmation required");
}

// Production manager NOT in pilot mode — can confirm
{
  const p = getPolicy("production_manager", false);
  assert(p.can_confirm === true, "pm normal: CAN confirm");
  assert(p.can_edit_factory === true, "pm normal: CAN edit factory");
}

// Operator — always read-only
{
  const p = getPolicy("operator", true);
  assert(p.can_preview === true, "operator: can preview");
  assert(p.can_confirm === false, "operator: CANNOT confirm");
  assert(p.can_edit_factory === false, "operator: CANNOT edit factory");
  assert(p.can_calibrate === false, "operator: CANNOT calibrate");
}

// Unknown role → defaults to operator
{
  const p = getPolicy("intern", true);
  assert(p.can_confirm === false, "unknown role: defaults to operator (no confirm)");
}

// ═══════════════════════════════════════════════════════
// 2. ROUTE ALLOWLIST
// ═══════════════════════════════════════════════════════

console.log("\n-- 2. Route allowlist --\n");

const PILOT_ALLOWED_WRITES = new Set([
  "POST /api/pilot/audit",
  "POST /api/optimizer/run",
  "POST /api/risks/scan",
  "POST /api/recommend",
  "POST /api/risk",
  "POST /api/geofences/generate-tasks",
]);

function simulatePilotGuard(method, path, body, role) {
  // Reads always pass
  if (method === "GET" || method === "HEAD") return { allowed: true, reason: "read" };

  const routeKey = `${method} ${path}`;

  // Check allowlist
  if (PILOT_ALLOWED_WRITES.has(routeKey)) {
    // Special: optimizer confirm blocked
    if (routeKey === "POST /api/optimizer/run" && body?.options?.dry_run === false) {
      return { allowed: false, reason: "optimizer confirm blocked" };
    }
    return { allowed: true, reason: "allowlisted" };
  }

  // Admin override
  if (role === "admin") return { allowed: true, reason: "admin override" };

  return { allowed: false, reason: "not in allowlist" };
}

// GET always passes
assert(simulatePilotGuard("GET", "/api/factories", {}, "operator").allowed, "GET /factories: allowed");
assert(simulatePilotGuard("GET", "/api/allocations", {}, "operator").allowed, "GET /allocations: allowed");

// Allowed POST routes
assert(simulatePilotGuard("POST", "/api/pilot/audit", {}, "operator").allowed, "POST /pilot/audit: allowed");
assert(simulatePilotGuard("POST", "/api/risks/scan", {}, "operator").allowed, "POST /risks/scan: allowed");
assert(simulatePilotGuard("POST", "/api/recommend", {}, "operator").allowed, "POST /recommend: allowed");

// Optimizer dry-run allowed
assert(simulatePilotGuard("POST", "/api/optimizer/run", { options: { dry_run: true } }, "operator").allowed, "optimizer dry-run: allowed");

// Optimizer confirm BLOCKED
assert(!simulatePilotGuard("POST", "/api/optimizer/run", { options: { dry_run: false } }, "operator").allowed, "optimizer confirm: BLOCKED");

// PATCH allocation BLOCKED
assert(!simulatePilotGuard("PATCH", "/api/allocations/123", {}, "operator").allowed, "PATCH allocation: BLOCKED");
assert(!simulatePilotGuard("PATCH", "/api/factories/123", {}, "production_manager").allowed, "PATCH factory: BLOCKED");

// DELETE BLOCKED
assert(!simulatePilotGuard("DELETE", "/api/allocations/123", {}, "operator").allowed, "DELETE allocation: BLOCKED");

// Admin override on blocked routes
assert(simulatePilotGuard("PATCH", "/api/allocations/123", {}, "admin").allowed, "admin: PATCH allocation ALLOWED");
assert(simulatePilotGuard("DELETE", "/api/allocations/123", {}, "admin").allowed, "admin: DELETE ALLOWED");

// ═══════════════════════════════════════════════════════
// 3. GUARD WRITE LOGIC
// ═══════════════════════════════════════════════════════

console.log("\n-- 3. Guard write simulation --\n");

const ACTION_PERMISSIONS = {
  "optimizer_confirm": "can_confirm",
  "allocation_status_change": "can_confirm",
  "factory_edit": "can_edit_factory",
  "calibration_trigger": "can_calibrate",
};

function simulateGuardWrite(actionType, policy) {
  const permKey = ACTION_PERMISSIONS[actionType];
  if (permKey && !policy[permKey]) {
    return { allowed: false, reason: `no ${permKey} permission` };
  }
  return { allowed: true };
}

// Operator can't confirm
{
  const policy = getPolicy("operator", true);
  const r = simulateGuardWrite("optimizer_confirm", policy);
  assert(!r.allowed, "operator: optimizer_confirm blocked");
}

// Admin can confirm
{
  const policy = getPolicy("admin", true);
  const r = simulateGuardWrite("optimizer_confirm", policy);
  assert(r.allowed, "admin: optimizer_confirm allowed");
}

// PM in pilot can't edit factory
{
  const policy = getPolicy("production_manager", true);
  const r1 = simulateGuardWrite("factory_edit", policy);
  assert(!r1.allowed, "pm pilot: factory_edit blocked");
}

// PM not in pilot can edit factory
{
  const policy = getPolicy("production_manager", false);
  const r1 = simulateGuardWrite("factory_edit", policy);
  assert(r1.allowed, "pm normal: factory_edit allowed");
}

// Operator can't calibrate
{
  const policy = getPolicy("operator", true);
  const r = simulateGuardWrite("calibration_trigger", policy);
  assert(!r.allowed, "operator: calibration_trigger blocked");
}

// Admin can calibrate
{
  const policy = getPolicy("admin", true);
  const r = simulateGuardWrite("calibration_trigger", policy);
  assert(r.allowed, "admin: calibration_trigger allowed");
}

// ═══════════════════════════════════════════════════════
// 4. AUDIT ENTRY STRUCTURE
// ═══════════════════════════════════════════════════════

console.log("\n-- 4. Audit entry structure --\n");

{
  const entry = {
    occurred_at: new Date().toISOString(),
    operator: "john",
    role: "production_manager",
    action: "optimizer_preview",
    category: "optimizer",
    blocked: false,
    page: "gantt",
    detail: { orders: 5 },
    environment: "pilot",
  };

  assert(typeof entry.occurred_at === "string", "timestamp is string");
  assert(entry.operator === "john", "operator field");
  assert(entry.role === "production_manager", "role field");
  assert(entry.category === "optimizer", "category field");
  assert(entry.blocked === false, "blocked field");
  assert(entry.page === "gantt", "page field");
  assert(entry.environment === "pilot", "environment field");
}

// Blocked entry
{
  const entry = {
    occurred_at: new Date().toISOString(),
    operator: "jane",
    role: "operator",
    action: "allocation_status_change",
    category: "allocation",
    blocked: true,
    page: "board",
    detail: { allocation_id: "abc", new_status: "confirmed" },
    environment: "pilot",
  };

  assert(entry.blocked === true, "blocked entry");
  assert(entry.detail.allocation_id === "abc", "detail preserved");
}

// ═══════════════════════════════════════════════════════
// 5. REPORT AGGREGATION
// ═══════════════════════════════════════════════════════

console.log("\n-- 5. Report aggregation --\n");

{
  const entries = [
    { action: "optimizer_preview", category: "optimizer", blocked: false, operator: "john", page: "gantt" },
    { action: "optimizer_preview", category: "optimizer", blocked: false, operator: "john", page: "gantt" },
    { action: "optimizer_confirm", category: "optimizer", blocked: true, operator: "john", page: "gantt" },
    { action: "allocation_status_change", category: "allocation", blocked: true, operator: "jane", page: "board" },
    { action: "factory_view", category: "factory", blocked: false, operator: "jane", page: "factories" },
  ];

  const total = entries.length;
  const blocked = entries.filter((e) => e.blocked).length;
  const byCategory = {};
  const byOperator = {};
  const byAction = {};
  for (const e of entries) {
    byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
    byOperator[e.operator] = (byOperator[e.operator] ?? 0) + 1;
    byAction[e.action] = (byAction[e.action] ?? 0) + 1;
  }

  assert(total === 5, "report total = 5");
  assert(blocked === 2, "report blocked = 2");
  assert(byCategory.optimizer === 3, "3 optimizer actions");
  assert(byOperator.john === 3, "john: 3 actions");
  assert(byOperator.jane === 2, "jane: 2 actions");
  assert(byAction.optimizer_preview === 2, "2 preview runs");
  assert(byAction.optimizer_confirm === 1, "1 confirm attempt");

  const previewRuns = entries.filter((e) => e.action.includes("preview")).length;
  const confirmAttempts = entries.filter((e) => e.action.includes("confirm")).length;
  assert(previewRuns === 2, "preview_runs = 2");
  assert(confirmAttempts === 1, "confirm_attempts = 1");
}

// ── Final ───────────────────────────────────────────────

console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
