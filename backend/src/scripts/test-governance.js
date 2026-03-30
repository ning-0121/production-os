#!/usr/bin/env node

/**
 * Tests for the governance policy engine.
 * Covers: can(), resolveAction(), resolveRole(), action matrix,
 *         audit result tracking, report aggregation.
 *
 * Run: node src/scripts/test-governance.js
 */

import { can, resolveAction, resolveRole, ACTIONS } from "../governance/policy.js";

let pass = 0;
let fail = 0;

function assert(cond, label) {
  if (cond) { pass++; }
  else { fail++; console.log(`  FAIL: ${label}`); }
}

console.log("=== Governance Policy Tests ===\n");

// ═══════════════════════════════════════════════════════
// 1. ACTION REGISTRY
// ═══════════════════════════════════════════════════════

console.log("-- 1. Action registry --\n");

assert(ACTIONS["optimizer.preview"] != null, "optimizer.preview registered");
assert(ACTIONS["optimizer.confirm"] != null, "optimizer.confirm registered");
assert(ACTIONS["allocation.delete"] != null, "allocation.delete registered");
assert(ACTIONS["audit.write"] != null, "audit.write registered");
assert(ACTIONS["optimizer.confirm"].risk === "high", "optimizer.confirm is high risk");
assert(ACTIONS["data.read"].risk === "none", "data.read is no risk");

// ═══════════════════════════════════════════════════════
// 2. can() — ADMIN
// ═══════════════════════════════════════════════════════

console.log("-- 2. Admin permissions --\n");

{
  // Admin can do everything in any mode
  for (const action of Object.keys(ACTIONS)) {
    const r = can("admin", action, { pilot_mode: true });
    assert(r.allowed, `admin pilot: ${action}`);
  }
  for (const action of Object.keys(ACTIONS)) {
    const r = can("admin", action, { pilot_mode: false });
    assert(r.allowed, `admin normal: ${action}`);
  }
}

// ═══════════════════════════════════════════════════════
// 3. can() — PRODUCTION MANAGER
// ═══════════════════════════════════════════════════════

console.log("-- 3. Production manager --\n");

{
  // In pilot mode: read + preview, no writes
  assert(can("production_manager", "data.read", { pilot_mode: true }).allowed, "pm pilot: read");
  assert(can("production_manager", "optimizer.preview", { pilot_mode: true }).allowed, "pm pilot: preview");
  assert(!can("production_manager", "optimizer.confirm", { pilot_mode: true }).allowed, "pm pilot: NO confirm");
  assert(!can("production_manager", "allocation.update", { pilot_mode: true }).allowed, "pm pilot: NO update");
  assert(!can("production_manager", "factory.update", { pilot_mode: true }).allowed, "pm pilot: NO factory edit");
  assert(!can("production_manager", "tasks.generate", { pilot_mode: true }).allowed, "pm pilot: tasks.generate blocked (DB write)");
  assert(!can("production_manager", "calibration.trigger", { pilot_mode: true }).allowed, "pm pilot: NO calibrate");
  assert(!can("production_manager", "allocation.delete", { pilot_mode: true }).allowed, "pm pilot: NO delete (always)");

  // In normal mode: can confirm and edit
  assert(can("production_manager", "optimizer.confirm", { pilot_mode: false }).allowed, "pm normal: CAN confirm");
  assert(can("production_manager", "allocation.update", { pilot_mode: false }).allowed, "pm normal: CAN update");
  assert(can("production_manager", "factory.update", { pilot_mode: false }).allowed, "pm normal: CAN factory edit");
}

// ═══════════════════════════════════════════════════════
// 4. can() — OPERATOR
// ═══════════════════════════════════════════════════════

console.log("-- 4. Operator --\n");

{
  assert(can("operator", "data.read", { pilot_mode: true }).allowed, "op: read");
  assert(can("operator", "optimizer.preview", { pilot_mode: true }).allowed, "op: preview");
  assert(!can("operator", "optimizer.confirm", { pilot_mode: true }).allowed, "op: NO confirm");
  assert(!can("operator", "allocation.create", { pilot_mode: true }).allowed, "op: NO create");
  assert(!can("operator", "allocation.update", { pilot_mode: true }).allowed, "op: NO update");
  assert(!can("operator", "factory.update", { pilot_mode: true }).allowed, "op: NO factory edit");
  assert(!can("operator", "calibration.complete", { pilot_mode: true }).allowed, "op: NO calibrate");
  assert(!can("operator", "tasks.generate", { pilot_mode: true }).allowed, "op pilot: tasks.generate blocked (DB write)");
  assert(can("operator", "audit.write", { pilot_mode: true }).allowed, "op: CAN audit");

  // Operator tasks.update is mode-dependent
  assert(can("operator", "tasks.update", { pilot_mode: false }).allowed, "op normal: CAN update tasks");
  assert(!can("operator", "tasks.update", { pilot_mode: true }).allowed, "op pilot: NO update tasks");
}

// ═══════════════════════════════════════════════════════
// 5. can() — EDGE CASES
// ═══════════════════════════════════════════════════════

console.log("-- 5. Edge cases --\n");

{
  // Unknown role → deny
  const r = can("intern", "data.read", {});
  assert(!r.allowed, "unknown role denied");
  assert(r.reason.includes("Unknown role"), "reason explains unknown role");

  // Unknown action → deny
  const r2 = can("admin", "nonexistent.action", {});
  assert(!r2.allowed, "unknown action denied");
  assert(r2.reason.includes("Unknown action"), "reason explains unknown action");

  // audit.write always allowed for any role
  assert(can("operator", "audit.write", { pilot_mode: true }).allowed, "audit always allowed");
  assert(can("admin", "audit.write", { pilot_mode: true }).allowed, "audit always allowed (admin)");
}

// ═══════════════════════════════════════════════════════
// 6. resolveAction()
// ═══════════════════════════════════════════════════════

console.log("-- 6. Route → action resolution --\n");

{
  assert(resolveAction("GET", "/api/factories", {}) === "data.read", "GET → data.read");
  assert(resolveAction("HEAD", "/api/anything", {}) === "data.read", "HEAD → data.read");

  // Optimizer
  assert(resolveAction("POST", "/api/optimizer/run", { options: { dry_run: true } }) === "optimizer.preview", "optimizer dry → preview");
  assert(resolveAction("POST", "/api/optimizer/run", { options: { dry_run: false } }) === "optimizer.confirm", "optimizer confirm → confirm");
  assert(resolveAction("POST", "/api/optimizer/run", {}) === "optimizer.preview", "optimizer default → preview");

  // Allocation operations
  assert(resolveAction("POST", "/api/allocations", {}) === "allocation.create", "POST alloc → create");
  assert(resolveAction("PATCH", "/api/allocations/abc", {}) === "allocation.update", "PATCH alloc → update");
  assert(resolveAction("DELETE", "/api/allocations/abc", {}) === "allocation.delete", "DELETE alloc → delete");
  assert(resolveAction("POST", "/api/allocations/abc/schedule", {}) === "allocation.schedule", "schedule → schedule");
  assert(resolveAction("POST", "/api/allocations/abc/recommend", {}) === "optimizer.preview", "recommend → preview");

  // Safe POSTs
  assert(resolveAction("POST", "/api/risks/scan", {}) === "risk.scan", "risk scan → risk.scan");
  assert(resolveAction("POST", "/api/recommend", {}) === "recommend.compute", "recommend → compute");
  assert(resolveAction("POST", "/api/pilot/audit", {}) === "audit.write", "audit → audit.write");

  // Task generation
  assert(resolveAction("POST", "/api/geofences/generate-tasks", {}) === "tasks.generate", "generate-tasks → tasks.generate");

  // Factory
  assert(resolveAction("PATCH", "/api/factories/abc", {}) === "factory.update", "PATCH factory → factory.update");
  assert(resolveAction("PATCH", "/api/factories/capabilities/abc", {}) === "capability.update", "PATCH cap → capability.update");

  // Unknown write → null (deny)
  assert(resolveAction("POST", "/api/unknown/route", {}) === null, "unknown POST → null");
  assert(resolveAction("PUT", "/api/something", {}) === null, "PUT unknown → null");
}

// ═══════════════════════════════════════════════════════
// 7. resolveRole()
// ═══════════════════════════════════════════════════════

console.log("-- 7. Role resolution --\n");

{
  // With header
  const r1 = resolveRole({ headers: { "x-pilot-role": "admin", "x-pilot-operator": "john" } });
  assert(r1.role === "admin", "header: admin");
  assert(r1.operator === "john", "header: john");
  assert(r1.auth_method === "header", "auth: header");

  // Invalid header role → default
  const r2 = resolveRole({ headers: { "x-pilot-role": "hacker" } });
  assert(r2.role === "operator", "invalid header → operator");
  assert(r2.auth_method === "default", "auth: default");

  // No header → default
  const r3 = resolveRole({ headers: {} });
  assert(r3.role === "operator", "no header → operator");
  assert(r3.operator === "anonymous", "no header → anonymous");
}

// ═══════════════════════════════════════════════════════
// 8. FULL FLOW SIMULATION
// ═══════════════════════════════════════════════════════

console.log("-- 8. Full flow simulation --\n");

{
  // Simulate: operator tries to confirm optimizer
  const identity = resolveRole({ headers: { "x-pilot-role": "operator" } });
  const action = resolveAction("POST", "/api/optimizer/run", { options: { dry_run: false } });
  const decision = can(identity.role, action, { pilot_mode: true });

  assert(identity.role === "operator", "flow: role = operator");
  assert(action === "optimizer.confirm", "flow: action = optimizer.confirm");
  assert(!decision.allowed, "flow: operator CANNOT confirm in pilot");
  assert(decision.reason.includes("operator"), "flow: reason mentions role");

  // Same request from admin
  const adminIdentity = resolveRole({ headers: { "x-pilot-role": "admin" } });
  const adminDecision = can(adminIdentity.role, action, { pilot_mode: true });
  assert(adminDecision.allowed, "flow: admin CAN confirm in pilot");
}

// ═══════════════════════════════════════════════════════
// 9. AUDIT RESULT STATUS
// ═══════════════════════════════════════════════════════

console.log("-- 9. Audit result tracking --\n");

{
  // Simulate audit entry creation with result tracking
  function makeAuditEntry(overrides = {}) {
    return {
      occurred_at: new Date().toISOString(),
      operator: "john", role: "production_manager",
      action: "optimizer_confirm", category: "optimizer",
      result_status: "success",
      error_code: null, request_id: null, run_id: null,
      blocked: false, page: "gantt",
      detail: {}, environment: "pilot",
      ...overrides,
    };
  }

  const success = makeAuditEntry({ result_status: "success" });
  const blocked = makeAuditEntry({ result_status: "blocked", blocked: true, detail: { denied_by: "can_confirm" } });
  const failed = makeAuditEntry({ result_status: "failed", error_code: "snapshot_mismatch" });
  const partial = makeAuditEntry({ result_status: "partial", run_id: "run-123" });

  assert(success.result_status === "success", "success status");
  assert(blocked.result_status === "blocked", "blocked status");
  assert(blocked.detail.denied_by === "can_confirm", "blocked reason captured");
  assert(failed.error_code === "snapshot_mismatch", "error code captured");
  assert(partial.run_id === "run-123", "run_id captured");

  // Report aggregation simulation
  const entries = [success, blocked, failed, partial, blocked, failed];
  const byStatus = {};
  let snapshotMismatches = 0;
  const blockedReasons = {};

  for (const e of entries) {
    byStatus[e.result_status] = (byStatus[e.result_status] ?? 0) + 1;
    if (e.error_code === "snapshot_mismatch") snapshotMismatches++;
    if (e.blocked && e.detail?.denied_by) {
      const key = `permission:${e.detail.denied_by}`;
      blockedReasons[key] = (blockedReasons[key] ?? 0) + 1;
    }
  }

  assert(byStatus.success === 1, "report: 1 success");
  assert(byStatus.blocked === 2, "report: 2 blocked");
  assert(byStatus.failed === 2, "report: 2 failed");
  assert(byStatus.partial === 1, "report: 1 partial");
  assert(snapshotMismatches === 2, "report: 2 snapshot mismatches");
  assert(blockedReasons["permission:can_confirm"] === 2, "report: 2 blocked by can_confirm");
}

// ── Final ───────────────────────────────────────────────

console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
