/**
 * Pilot Mode API
 *
 * POST /api/pilot/audit      — persist an audit entry from the frontend
 * GET  /api/pilot/audit      — retrieve audit log (optionally filtered)
 * GET  /api/pilot/report     — summary report for pilot usage
 * GET  /api/pilot/policy     — return current pilot policy for a role
 */

import { Router } from "express";
import { supabase } from "../supabase.js";

const router = Router();

const PILOT_MODE = process.env.PILOT_MODE === "true";

// ── Role-based pilot policy ─────────────────────────────

const ROLE_POLICIES = {
  admin: {
    can_preview: true,
    can_confirm: true,
    can_edit_factory: true,
    can_calibrate: true,
    confirmation_required: false,
  },
  production_manager: {
    can_preview: true,
    can_confirm: PILOT_MODE ? false : true,
    can_edit_factory: PILOT_MODE ? false : true,
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

/**
 * GET /api/pilot/policy?role=admin
 * Returns the pilot policy for the given role.
 */
router.get("/policy", (_req, res) => {
  const role = _req.query.role ?? "operator";
  const policy = ROLE_POLICIES[role] ?? ROLE_POLICIES.operator;
  res.json({
    pilot_mode: PILOT_MODE,
    role,
    policy,
    available_roles: Object.keys(ROLE_POLICIES),
  });
});

// ── Persistent audit log ────────────────────────────────

/**
 * POST /api/pilot/audit
 * Body: {
 *   operator?: string,
 *   role?: string,
 *   action: string,
 *   category: string,
 *   blocked: boolean,
 *   page?: string,
 *   detail?: object,
 * }
 */
router.post("/audit", async (req, res) => {
  const { operator, role, action, category, blocked, page, detail } = req.body;

  if (!action) return res.status(400).json({ error: "action required" });

  const entry = {
    occurred_at: new Date().toISOString(),
    operator: operator ?? "anonymous",
    role: role ?? "unknown",
    action,
    category: category ?? "system",
    blocked: blocked ?? false,
    page: page ?? null,
    detail: detail ?? {},
    environment: PILOT_MODE ? "pilot" : "production",
  };

  // Try to persist to Supabase pilot_audit_log table
  const { data, error } = await supabase
    .from("pilot_audit_log")
    .insert(entry)
    .select("id")
    .maybeSingle();

  if (error) {
    // Table may not exist yet — log to console as fallback
    console.log("[PILOT AUDIT]", JSON.stringify(entry));
    return res.json({ persisted: false, fallback: "console", entry, error: error.message });
  }

  res.json({ persisted: true, id: data?.id, entry });
});

/**
 * GET /api/pilot/audit?limit=50&operator=john&category=optimizer
 */
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

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
});

// ── Pilot usage report ──────────────────────────────────

/**
 * GET /api/pilot/report?days=7
 */
router.get("/report", async (req, res) => {
  const days = Number(req.query.days ?? 7);
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const { data: entries, error } = await supabase
    .from("pilot_audit_log")
    .select("*")
    .gte("occurred_at", since)
    .order("occurred_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const rows = entries ?? [];

  // Aggregate
  const total = rows.length;
  const blocked = rows.filter((r) => r.blocked).length;
  const allowed = total - blocked;

  const byCategory = {};
  const byOperator = {};
  const byAction = {};
  const byPage = {};

  for (const r of rows) {
    byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
    byOperator[r.operator] = (byOperator[r.operator] ?? 0) + 1;
    byAction[r.action] = (byAction[r.action] ?? 0) + 1;
    if (r.page) byPage[r.page] = (byPage[r.page] ?? 0) + 1;
  }

  // Top items
  const topActions = Object.entries(byAction)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([action, count]) => ({ action, count }));

  const previewRuns = rows.filter((r) => r.action?.includes("preview") || r.action?.includes("optimizer")).length;
  const confirmAttempts = rows.filter((r) => r.action?.includes("confirm")).length;
  const blockedWrites = rows.filter((r) => r.blocked && !r.action?.includes("cancel")).length;

  res.json({
    period_days: days,
    since,
    total_actions: total,
    blocked,
    allowed,
    preview_runs: previewRuns,
    confirm_attempts: confirmAttempts,
    blocked_writes: blockedWrites,
    by_category: byCategory,
    by_operator: byOperator,
    by_page: byPage,
    top_actions: topActions,
    entries_sampled: Math.min(rows.length, 500),
  });
});

export default router;
