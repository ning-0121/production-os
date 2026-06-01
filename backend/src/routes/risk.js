/**
 * Risk Engine routes — the single canonical risk endpoint.
 *
 * GET /api/risk/:subject_type/:id
 *     Returns a RiskAssessment for the given entity.
 *
 * POST /api/risk/batch
 *     Body: { subject_type: "allocation" | "line", ids: string[] }
 *     Returns assessments for many subjects in one round trip.
 *
 * Deliberately separate from the legacy `/api/risks` (which serves the
 * risk_alerts queue). This namespace = read-only canonical assessment.
 */

import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validate, schemas } from "../middleware/validate.js";
import { assessById, assessAllocationBatch, assessLineBatch } from "../risk-engine/io.js";
import { SUPPORTED_SUBJECT_TYPES } from "../risk-engine/index.js";

const router = Router();

const VALID_TYPES = new Set(SUPPORTED_SUBJECT_TYPES);

// GET /api/risk/:type/:id
router.get("/:type/:id", asyncHandler(async (req, res) => {
  const { type, id } = req.params;
  if (!VALID_TYPES.has(type)) {
    return res.status(400).json({ error: `unknown subject_type: ${type}`, supported: [...VALID_TYPES] });
  }
  const assessment = await assessById(supabase, type, id);
  res.json(assessment);
}));

// POST /api/risk/batch
router.post("/batch", validate(schemas.riskBatch), asyncHandler(async (req, res) => {
  const { subject_type, ids } = req.body;
  let assessments;
  if (subject_type === "allocation") {
    assessments = await assessAllocationBatch(supabase, ids);
  } else if (subject_type === "line") {
    assessments = await assessLineBatch(supabase, ids);
  } else {
    // Fall back to N+1 for types without an optimized batch loader
    assessments = await Promise.all(ids.map((id) => assessById(supabase, subject_type, id)));
  }
  res.json({ count: assessments.length, assessments });
}));

export default router;
