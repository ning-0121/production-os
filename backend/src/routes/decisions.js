/**
 * Decision Engine API — /api/decisions/*
 *
 * GET  /:subject_type/:subject_id   evaluate + return a DecisionAssessment
 * POST /evaluate                    evaluate (optionally persist) for any subject
 * POST /:decision_id/options/:option_id/apply   explicitly apply a chosen option
 * GET  /history                     prior decisions + selected outcomes
 * POST /:decision_id/feedback       feedback on an option/recommendation
 *
 * Generating is read-only; applying is the only write path to production
 * follow-ups, and is always recorded in decision_logs.
 */

import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validate, schemas } from "../middleware/validate.js";
import { auditLog } from "../governance/audit.js";
import { evaluateDecision, getAssessment } from "../decision-engine/io.js";
import { applyOption } from "../decision-engine/apply.js";
import { recomputeLearning, listLearning } from "../decision-engine/learning-io.js";

const router = Router();

// ── Learning loop (declared before /:subject_type/:id) ──
// GET /api/decisions/learning — inspect current learned weights
router.get("/learning", asyncHandler(async (_req, res) => {
  const rows = await listLearning(supabase);
  res.json({ count: rows.length, learning: rows });
}));

// POST /api/decisions/learning/recompute — rebuild from history (cron-callable)
router.post("/learning/recompute", asyncHandler(async (req, res) => {
  const result = await recomputeLearning(supabase);
  auditLog({
    action: "decision.learning_recompute", category: "system", result_status: "success", req,
    detail: { updated: result.updated },
  });
  res.json({ updated: result.updated, rows: result.rows });
}));

const SUBJECT_TYPES = new Set(["order", "allocation", "line", "factory", "material", "incident"]);

// GET /api/decisions/history — must be declared before /:subject_type/:id
router.get("/history", asyncHandler(async (req, res) => {
  const limit = Math.min(100, Number(req.query.limit ?? 30));
  const { data: logs, error } = await supabase
    .from("decision_logs")
    .select("*, decision_assessments(subject_type, subject_id, decision_type, urgency, recommendation_reason)")
    .order("selected_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  res.json({ count: logs?.length ?? 0, history: logs ?? [] });
}));

// GET /api/decisions/:subject_type/:subject_id — evaluate (no persist)
router.get("/:subject_type/:subject_id", asyncHandler(async (req, res) => {
  const { subject_type, subject_id } = req.params;
  if (!SUBJECT_TYPES.has(subject_type)) {
    return res.status(400).json({ error: `unknown subject_type: ${subject_type}`, supported: [...SUBJECT_TYPES] });
  }
  const assessment = await evaluateDecision(supabase, { type: subject_type, id: subject_id }, {
    decision_type: req.query.decision_type,
    persist: req.query.persist === "true",
    createdBy: req.pilotIdentity?.operator,
  });
  res.json(assessment);
}));

// POST /api/decisions/evaluate — evaluate any subject, optionally persist
router.post("/evaluate", validate(schemas.evaluateDecision), asyncHandler(async (req, res) => {
  const { subject, decision_type, context, persist } = req.body;
  const assessment = await evaluateDecision(supabase, subject, {
    decision_type, context, persist: persist ?? true,
    createdBy: req.pilotIdentity?.operator,
  });
  auditLog({
    action: "decision.evaluate", category: "system", result_status: "success", req,
    detail: { subject, decision_type: assessment.decision_type, options: assessment.options.length, recommended: assessment.recommended_option_id },
  });
  res.status(201).json(assessment);
}));

// POST /api/decisions/:decision_id/options/:option_id/apply
router.post("/:decision_id/options/:option_id/apply", validate(schemas.applyDecisionOption), asyncHandler(async (req, res) => {
  const { decision_id, option_id } = req.params;
  const assessment = await getAssessment(supabase, decision_id);
  if (!assessment) return res.status(404).json({ error: "decision not found" });

  const result = await applyOption(supabase, assessment, option_id, {
    mode: req.body.mode,
    override_reason: req.body.override_reason,
    actor: req.pilotIdentity?.operator ?? "system",
    requestId: req.requestId ?? null,
  });

  if (!result.ok && result.error) return res.status(400).json({ error: result.error });

  auditLog({
    action: "decision.apply", category: "system",
    result_status: result.status === "failed" ? "failed" : "success", req,
    detail: { decision_id, option_id, mode: req.body.mode, status: result.status, actions: result.actions_taken?.length ?? 0 },
  });
  res.status(result.status === "failed" ? 207 : 200).json(result);
}));

// POST /api/decisions/:decision_id/feedback
router.post("/:decision_id/feedback", validate(schemas.decisionFeedback), asyncHandler(async (req, res) => {
  const { option_id, feedback_type, feedback_note } = req.body;
  const { data, error } = await supabase.from("decision_option_feedback").insert({
    decision_id: req.params.decision_id,
    option_id, feedback_type, feedback_note: feedback_note ?? null,
    created_by: req.pilotIdentity?.operator ?? "system",
  }).select().single();
  if (error) throw error;
  res.status(201).json(data);
}));

export default router;
