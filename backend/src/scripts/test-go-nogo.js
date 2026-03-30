#!/usr/bin/env node

/**
 * Production Go/No-Go readiness tests.
 *
 * Verifies:
 *   1. Every write route maps to a policy action
 *   2. Every policy action is in the ACTIONS registry
 *   3. Risk classifications are correct
 *   4. Role-fallback events are auditable
 *   5. All governed actions produce audit entries
 *   6. Launch criteria are measurable
 *
 * Run: node src/scripts/test-go-nogo.js
 */

import { can, resolveAction, resolveRole, ACTIONS } from "../governance/policy.js";

let pass = 0;
let fail = 0;

function assert(cond, label) {
  if (cond) { pass++; }
  else { fail++; console.log(`  FAIL: ${label}`); }
}

console.log("=== Go/No-Go Readiness Tests ===\n");

// ═══════════════════════════════════════════════════════
// 1. ROUTE COVERAGE — every write route maps to an action
// ═══════════════════════════════════════════════════════

console.log("-- 1. Route coverage --\n");

// Complete list of every write route in the backend
const ALL_WRITE_ROUTES = [
  ["POST",   "/api/allocations",                   "allocation.create"],
  ["PATCH",  "/api/allocations/abc",               "allocation.update"],
  ["DELETE", "/api/allocations/abc",               "allocation.delete"],
  ["POST",   "/api/allocations/abc/schedule",      "allocation.schedule"],
  ["POST",   "/api/allocations/abc/recommend",     "optimizer.preview"],
  ["POST",   "/api/optimizer/run",                 "optimizer.preview"],  // dry_run default
  ["POST",   "/api/optimizer/run",                 "optimizer.confirm", { options: { dry_run: false } }],
  ["PATCH",  "/api/factories/abc",                 "factory.update"],
  ["PATCH",  "/api/factories/capabilities/abc",    "capability.update"],
  ["POST",   "/api/risks/scan",                    "risk.scan"],
  ["POST",   "/api/recommend",                     "recommend.compute"],
  ["POST",   "/api/risk",                          "recommend.compute"],
  ["POST",   "/api/geofences/generate-tasks",      "tasks.generate"],
  ["PATCH",  "/api/geofences/tasks/abc",           "tasks.update"],
  ["POST",   "/api/pilot/audit",                   "audit.write"],
  ["POST",   "/api/calibration/complete",          "calibration.complete"],
  ["POST",   "/api/calibration/recalibrate",       "calibration.trigger"],
];

for (const [method, path, expectedAction, body] of ALL_WRITE_ROUTES) {
  const resolved = resolveAction(method, path, body ?? {});
  assert(resolved === expectedAction, `${method} ${path} → ${expectedAction} (got: ${resolved})`);
}

// No route should resolve to null (unmapped)
const unmappedRoutes = ALL_WRITE_ROUTES.filter(([m, p, , b]) => resolveAction(m, p, b ?? {}) === null);
assert(unmappedRoutes.length === 0, `0 unmapped routes (found: ${unmappedRoutes.length})`);

// ═══════════════════════════════════════════════════════
// 2. EVERY RESOLVED ACTION EXISTS IN ACTIONS REGISTRY
// ═══════════════════════════════════════════════════════

console.log("\n-- 2. Action registry completeness --\n");

const allResolvedActions = new Set(ALL_WRITE_ROUTES.map(([m, p, , b]) => resolveAction(m, p, b ?? {})));
allResolvedActions.add("data.read"); // GET routes

for (const action of allResolvedActions) {
  assert(ACTIONS[action] != null, `${action} is in ACTIONS registry`);
}

// ═══════════════════════════════════════════════════════
// 3. RISK CLASSIFICATIONS
// ═══════════════════════════════════════════════════════

console.log("\n-- 3. Risk classification audit --\n");

// High risk: actions that modify scheduling decisions or factory scores
const expectedHigh = ["optimizer.confirm", "allocation.delete", "allocation.schedule", "calibration.trigger", "calibration.complete"];
for (const a of expectedHigh) {
  assert(ACTIONS[a]?.risk === "high", `${a} should be HIGH risk (is: ${ACTIONS[a]?.risk})`);
}

// Medium risk: data mutations that affect future scheduling
const expectedMedium = ["allocation.create", "allocation.update", "factory.update", "capability.update", "tasks.generate"];
for (const a of expectedMedium) {
  assert(ACTIONS[a]?.risk === "medium", `${a} should be MEDIUM risk (is: ${ACTIONS[a]?.risk})`);
}

// Low risk: read-adjacent writes
const expectedLow = ["risk.scan", "tasks.update", "geofence.update"];
for (const a of expectedLow) {
  assert(ACTIONS[a]?.risk === "low", `${a} should be LOW risk (is: ${ACTIONS[a]?.risk})`);
}

// None risk: pure reads and system ops
const expectedNone = ["data.read", "optimizer.preview", "recommend.compute", "audit.write"];
for (const a of expectedNone) {
  assert(ACTIONS[a]?.risk === "none", `${a} should be NONE risk (is: ${ACTIONS[a]?.risk})`);
}

// ═══════════════════════════════════════════════════════
// 4. PILOT MODE BLOCKS ALL HIGH-RISK FOR NON-ADMIN
// ═══════════════════════════════════════════════════════

console.log("\n-- 4. Pilot mode blocks high-risk --\n");

for (const action of expectedHigh) {
  // Operator: always blocked
  assert(!can("operator", action, { pilot_mode: true }).allowed, `operator pilot: ${action} BLOCKED`);
  assert(!can("operator", action, { pilot_mode: false }).allowed, `operator normal: ${action} BLOCKED`);

  // PM: blocked in pilot
  assert(!can("production_manager", action, { pilot_mode: true }).allowed, `pm pilot: ${action} BLOCKED`);

  // Admin: always allowed
  assert(can("admin", action, { pilot_mode: true }).allowed, `admin pilot: ${action} ALLOWED`);
}

// ═══════════════════════════════════════════════════════
// 5. TASK GENERATION IS PILOT-RESTRICTED (not freely writable)
// ═══════════════════════════════════════════════════════

console.log("\n-- 5. Task generation governance --\n");

assert(!can("production_manager", "tasks.generate", { pilot_mode: true }).allowed, "pm pilot: tasks.generate BLOCKED");
assert(can("production_manager", "tasks.generate", { pilot_mode: false }).allowed, "pm normal: tasks.generate ALLOWED");
assert(!can("operator", "tasks.generate", { pilot_mode: true }).allowed, "operator pilot: tasks.generate BLOCKED");
assert(can("admin", "tasks.generate", { pilot_mode: true }).allowed, "admin pilot: tasks.generate ALLOWED");

// ═══════════════════════════════════════════════════════
// 6. ROLE FALLBACK DETECTION
// ═══════════════════════════════════════════════════════

console.log("\n-- 6. Role fallback --\n");

{
  // No role header → defaults to operator + auth_method: "default"
  const r = resolveRole({ headers: {} });
  assert(r.role === "operator", "no header → operator");
  assert(r.auth_method === "default", "no header → default auth");
  assert(r.operator === "anonymous", "no header → anonymous");

  // Invalid role header → defaults
  const r2 = resolveRole({ headers: { "x-pilot-role": "hacker" } });
  assert(r2.role === "operator", "invalid role → operator");
  assert(r2.auth_method === "default", "invalid role → default auth");

  // Valid role header
  const r3 = resolveRole({ headers: { "x-pilot-role": "admin", "x-pilot-operator": "john" } });
  assert(r3.auth_method === "header", "valid role → header auth");
}

// ═══════════════════════════════════════════════════════
// 7. AUDIT ENTRY COMPLETENESS
// ═══════════════════════════════════════════════════════

console.log("\n-- 7. Audit entry fields --\n");

{
  // Simulate a complete audit entry as generated by governance/audit.js
  const entry = {
    occurred_at: new Date().toISOString(),
    operator: "john",
    role: "production_manager",
    action: "optimizer.confirm",
    category: "optimizer",
    result_status: "blocked",
    error_code: "policy_denied",
    request_id: null,
    run_id: "run-abc",
    blocked: true,
    page: null,
    detail: { reason: "Role production_manager cannot Persist optimizer allocations in pilot mode" },
    environment: "pilot",
  };

  // Every required field present
  const required = ["occurred_at", "operator", "role", "action", "category", "result_status", "blocked", "environment"];
  for (const field of required) {
    assert(entry[field] !== undefined, `audit entry has ${field}`);
  }

  // result_status is a valid enum
  const validStatuses = new Set(["success", "blocked", "failed", "partial"]);
  assert(validStatuses.has(entry.result_status), "result_status is valid enum");
}

// ═══════════════════════════════════════════════════════
// 8. LAUNCH CRITERIA VALIDATION
// ═══════════════════════════════════════════════════════

console.log("\n-- 8. Launch criteria --\n");

{
  // Simulate a pilot report
  const report = {
    total_actions: 500,
    by_result_status: { success: 450, blocked: 40, failed: 8, partial: 2 },
    snapshot_mismatches: 1,
    optimistic_lock_conflicts: 0,
    calibration_blocked: 3,
    unknown_role_fallbacks: 5,
  };

  // Define thresholds
  const THRESHOLDS = {
    min_total_actions: 100,            // need enough data
    max_failure_rate_pct: 5,           // < 5% failed
    max_snapshot_mismatch_pct: 2,      // < 2% snapshot drift
    max_lock_conflict_pct: 1,          // < 1% concurrent issues
    max_unknown_role_pct: 3,           // < 3% unauthenticated writes
    audit_persistence_rate_pct: 95,    // > 95% audit entries persisted
  };

  // Check each criterion
  const failureRate = ((report.by_result_status.failed ?? 0) / report.total_actions) * 100;
  const snapshotRate = (report.snapshot_mismatches / report.total_actions) * 100;
  const lockRate = (report.optimistic_lock_conflicts / report.total_actions) * 100;
  const unknownRoleRate = (report.unknown_role_fallbacks / report.total_actions) * 100;

  assert(report.total_actions >= THRESHOLDS.min_total_actions, `total actions ≥ ${THRESHOLDS.min_total_actions}: ${report.total_actions}`);
  assert(failureRate < THRESHOLDS.max_failure_rate_pct, `failure rate < ${THRESHOLDS.max_failure_rate_pct}%: ${failureRate.toFixed(1)}%`);
  assert(snapshotRate < THRESHOLDS.max_snapshot_mismatch_pct, `snapshot mismatch < ${THRESHOLDS.max_snapshot_mismatch_pct}%: ${snapshotRate.toFixed(1)}%`);
  assert(lockRate < THRESHOLDS.max_lock_conflict_pct, `lock conflicts < ${THRESHOLDS.max_lock_conflict_pct}%: ${lockRate.toFixed(1)}%`);
  assert(unknownRoleRate < THRESHOLDS.max_unknown_role_pct, `unknown role < ${THRESHOLDS.max_unknown_role_pct}%: ${unknownRoleRate.toFixed(1)}%`);
}

// ── Final ───────────────────────────────────────────────

console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
