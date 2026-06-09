/**
 * Cron Runner — /api/cron/*
 *
 * The autonomous heartbeat. An external scheduler (GitHub Actions / Railway
 * cron / any cron) POSTs here on an interval. Mounted BEFORE the JWT auth
 * middleware and protected instead by a shared CRON_SECRET, so machines can
 * call it without a user token.
 *
 * POST /api/cron/sweep  runs, in order + idempotently:
 *   1. auto-generate tasks from persisted risk sources
 *   2. due-soon notifications
 *   3. escalation sweep (which also notifies escalation targets)
 * and logs the whole run to cron_runs for observability.
 *
 * Everything is idempotent — re-running produces no duplicate tasks or
 * notifications, so retries / overlapping schedules are safe.
 */

import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autoGenerateTasks } from "../execution/auto-generate.js";
import { runEscalationSweep } from "../execution/service.js";
import { sweepDueSoon } from "../execution/notify.js";
import { isValidCronSecret } from "../execution/cron-guard.js";
import { recomputeLearning } from "../decision-engine/learning-io.js";

const router = Router();

// Re-export so existing tests / imports keep working.
export { isValidCronSecret };

// CRON_SECRET guard — applies to every route in this router.
router.use((req, res, next) => {
  const provided = req.get("x-cron-secret") ?? req.query.secret;
  if (!isValidCronSecret(provided, process.env.CRON_SECRET)) {
    return res.status(401).json({ error: "invalid or missing cron secret" });
  }
  next();
});

// POST /api/cron/sweep — the full autonomous pass
router.post("/sweep", asyncHandler(async (req, res) => {
  const startedAt = new Date();
  const triggeredBy = req.get("x-cron-source") ?? "external";

  // Open a cron_runs row (best-effort; don't fail the job if logging fails)
  let runId = null;
  try {
    const { data } = await supabase.from("cron_runs")
      .insert({ job_name: "sweep", status: "running", started_at: startedAt.toISOString(), triggered_by: triggeredBy })
      .select("id").single();
    runId = data?.id ?? null;
  } catch { /* logging is non-critical */ }

  const result = { generated: 0, escalated: 0, notified: 0, due_soon: 0, learning_updated: 0, failed: 0 };
  let errorMessage = null;

  // 1. Auto-generate tasks
  try {
    const gen = await autoGenerateTasks(supabase, { actor: "cron", request_id: req.requestId });
    result.generated = gen.created;
    result.notified += gen.created;        // each created task emits a notification
  } catch (err) { result.failed++; errorMessage = appendErr(errorMessage, "auto_generate", err); }

  // 2. Due-soon notifications
  try {
    const ds = await sweepDueSoon(supabase, { now: startedAt });
    result.due_soon = ds.notified;
    result.notified += ds.notified;
  } catch (err) { result.failed++; errorMessage = appendErr(errorMessage, "due_soon", err); }

  // 3. Escalation sweep (notifies escalation targets internally)
  try {
    const esc = await runEscalationSweep(supabase, { now: startedAt });
    result.escalated = esc.escalated;
    result.notified += esc.notified ?? 0;
  } catch (err) { result.failed++; errorMessage = appendErr(errorMessage, "escalation", err); }

  // 4. Decision learning recompute (organizational memory; bounded + idempotent)
  try {
    const learn = await recomputeLearning(supabase, { now: startedAt });
    result.learning_updated = learn.updated;
  } catch (err) { result.failed++; errorMessage = appendErr(errorMessage, "learning", err); }

  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();
  const status = result.failed > 0 ? "failed" : "completed";

  // Close the cron_runs row
  if (runId) {
    try {
      await supabase.from("cron_runs").update({
        status, finished_at: finishedAt.toISOString(), duration_ms: durationMs,
        generated_count: result.generated, escalated_count: result.escalated,
        notified_count: result.notified, due_soon_count: result.due_soon,
        failed_count: result.failed, error_message: errorMessage,
        detail: result,
      }).eq("id", runId);
    } catch { /* non-critical */ }
  }

  res.status(status === "failed" ? 207 : 200).json({
    run_id: runId, status, duration_ms: durationMs, ...result, error_message: errorMessage,
  });
}));

// GET /api/cron/runs — recent run history (also behind the secret)
router.get("/runs", asyncHandler(async (req, res) => {
  const limit = Math.min(100, Number(req.query.limit ?? 20));
  const { data, error } = await supabase
    .from("cron_runs").select("*").order("started_at", { ascending: false }).limit(limit);
  if (error) throw error;
  res.json({ count: data?.length ?? 0, runs: data ?? [] });
}));

function appendErr(existing, stage, err) {
  const msg = `${stage}: ${err instanceof Error ? err.message : String(err)}`;
  console.error("[cron]", msg);
  return existing ? `${existing}; ${msg}` : msg;
}

export default router;
