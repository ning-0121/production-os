/**
 * Pilot Mode API
 *
 * POST /api/pilot/audit       — persist an audit entry with result tracking
 * GET  /api/pilot/audit       — retrieve audit log
 * GET  /api/pilot/report      — failure-focused summary report
 * GET  /api/pilot/policy      — role-based policy for the current user
 */

import { Router } from "express";
import { supabase } from "../supabase.js";
import { can, ACTIONS } from "../governance/policy.js";

const router = Router();
const PILOT_MODE = process.env.PILOT_MODE === "true";

// ── Policy endpoint ─────────────────────────────────────

router.get("/policy", (req, res) => {
  const role = req.query.role ?? req.pilotIdentity?.role ?? "operator";

  // Build policy by checking every action
  const policy = {};
  for (const action of Object.keys(ACTIONS)) {
    const decision = can(role, action, { pilot_mode: PILOT_MODE });
    policy[action] = decision.allowed;
  }

  // Legacy shape for frontend compatibility
  const legacyPolicy = {
    can_preview: can(role, "optimizer.preview", { pilot_mode: PILOT_MODE }).allowed,
    can_confirm: can(role, "optimizer.confirm", { pilot_mode: PILOT_MODE }).allowed,
    can_edit_factory: can(role, "factory.update", { pilot_mode: PILOT_MODE }).allowed,
    can_calibrate: can(role, "calibration.trigger", { pilot_mode: PILOT_MODE }).allowed,
    confirmation_required: role !== "admin" && PILOT_MODE,
  };

  res.json({
    pilot_mode: PILOT_MODE,
    role,
    policy: legacyPolicy,
    action_matrix: policy,
    available_roles: ["admin", "production_manager", "operator"],
  });
});

// ── Enhanced audit log ──────────────────────────────────

/**
 * POST /api/pilot/audit
 * Body: {
 *   operator?, role?, action, category,
 *   result_status: "success" | "blocked" | "failed" | "partial",
 *   error_code?, request_id?, run_id?,
 *   blocked: boolean, page?, detail?
 * }
 */
router.post("/audit", async (req, res) => {
  const {
    operator, role, action, category,
    result_status, error_code, request_id, run_id,
    blocked, page, detail,
  } = req.body;

  if (!action) return res.status(400).json({ error: "action required" });

  const entry = {
    occurred_at: new Date().toISOString(),
    operator: operator ?? req.pilotIdentity?.operator ?? "anonymous",
    role: role ?? req.pilotIdentity?.role ?? "unknown",
    action,
    category: category ?? "system",
    result_status: result_status ?? (blocked ? "blocked" : "success"),
    error_code: error_code ?? null,
    request_id: request_id ?? null,
    run_id: run_id ?? null,
    blocked: blocked ?? false,
    page: page ?? null,
    detail: detail ?? {},
    environment: PILOT_MODE ? "pilot" : "production",
  };

  const { data, error } = await supabase
    .from("pilot_audit_log")
    .insert(entry)
    .select("id")
    .maybeSingle();

  if (error) {
    console.log("[PILOT AUDIT]", JSON.stringify(entry));
    return res.json({ persisted: false, fallback: "console", entry, error: error.message });
  }

  res.json({ persisted: true, id: data?.id, entry });
});

// ── Audit retrieval ─────────────────────────────────────

router.get("/audit", async (req, res) => {
  const limit = Number(req.query.limit ?? 100);
  let query = supabase
    .from("pilot_audit_log")
    .select("*")
    .order("occurred_at", { ascending: false })
    .limit(limit);

  if (req.query.operator) query = query.eq("operator", req.query.operator);
  if (req.query.category) query = query.eq("category", req.query.category);
  if (req.query.blocked === "true") query = query.eq("blocked", true);
  if (req.query.result_status) query = query.eq("result_status", req.query.result_status);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
});

// ── Failure-focused report ──────────────────────────────

router.get("/report", async (req, res) => {
  const days = Number(req.query.days ?? 7);
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const { data: rows, error } = await supabase
    .from("pilot_audit_log")
    .select("*")
    .gte("occurred_at", since)
    .order("occurred_at", { ascending: false })
    .limit(2000);

  if (error) return res.status(500).json({ error: error.message });

  const entries = rows ?? [];
  const total = entries.length;

  // Result status counts
  const byResultStatus = {};
  const byCategory = {};
  const byOperator = {};
  const byAction = {};
  const byPage = {};
  const byErrorCode = {};

  // Failure-specific tracking
  const failedActions = {};
  const blockedReasons = {};
  let snapshotMismatches = 0;
  let optimisticLockConflicts = 0;
  let calibrationBlocked = 0;

  for (const r of entries) {
    byResultStatus[r.result_status] = (byResultStatus[r.result_status] ?? 0) + 1;
    byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
    byOperator[r.operator] = (byOperator[r.operator] ?? 0) + 1;
    byAction[r.action] = (byAction[r.action] ?? 0) + 1;
    if (r.page) byPage[r.page] = (byPage[r.page] ?? 0) + 1;
    if (r.error_code) byErrorCode[r.error_code] = (byErrorCode[r.error_code] ?? 0) + 1;

    // Track failures
    if (r.result_status === "failed" || r.result_status === "partial") {
      failedActions[r.action] = (failedActions[r.action] ?? 0) + 1;
    }

    // Track block reasons from detail
    if (r.blocked && r.detail?.reason) {
      blockedReasons[r.detail.reason] = (blockedReasons[r.detail.reason] ?? 0) + 1;
    }
    if (r.blocked && r.detail?.denied_by) {
      blockedReasons[`permission:${r.detail.denied_by}`] = (blockedReasons[`permission:${r.detail.denied_by}`] ?? 0) + 1;
    }

    // Specific governance events
    if (r.error_code === "snapshot_mismatch") snapshotMismatches++;
    if (r.error_code === "optimistic_lock_conflict") optimisticLockConflicts++;
    if (r.action?.includes("calibration") && r.blocked) calibrationBlocked++;
  }

  // Sort helpers
  const topN = (obj, n = 10) =>
    Object.entries(obj).sort(([, a], [, b]) => b - a).slice(0, n).map(([key, count]) => ({ key, count }));

  res.json({
    period_days: days,
    since,
    total_actions: total,

    // Result breakdown
    by_result_status: byResultStatus,
    success_count: byResultStatus.success ?? 0,
    blocked_count: byResultStatus.blocked ?? 0,
    failed_count: byResultStatus.failed ?? 0,
    partial_count: byResultStatus.partial ?? 0,

    // Failure focus
    top_failed_actions: topN(failedActions),
    top_blocked_reasons: topN(blockedReasons),
    top_error_codes: topN(byErrorCode),
    snapshot_mismatches: snapshotMismatches,
    optimistic_lock_conflicts: optimisticLockConflicts,
    calibration_blocked: calibrationBlocked,

    // General
    by_category: byCategory,
    by_operator: byOperator,
    by_page: byPage,
    top_actions: topN(byAction),
  });
});

export default router;
