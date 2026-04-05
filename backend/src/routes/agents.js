/**
 * Agent API routes — invoke AI agents on demand.
 */

import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { runRiskPredictor } from "../agents/risk-predictor.js";
import { runCorrector } from "../agents/corrector.js";
import { runCalibrator } from "../agents/calibrator.js";

const router = Router();

// POST /api/agents/risk-predict — run risk prediction agent
router.post("/risk-predict", asyncHandler(async (_req, res) => {
  // Load context
  const [allocRes, corrRes, linesRes, factRes] = await Promise.all([
    supabase
      .from("production_allocations")
      .select("id, order_id, factory_id, product_type, allocated_qty, planned_end_date, status")
      .not("status", "eq", "completed")
      .not("status", "eq", "cancelled"),
    supabase
      .from("order_corrections")
      .select("allocation_id, order_id, factory_id, risk_status, deviation_pct, estimated_end_date"),
    supabase
      .from("production_lines")
      .select("id, name, factory_id, front_capacity_per_day, back_capacity_per_day, status"),
    supabase
      .from("factories")
      .select("id, name, status, quality_score, delay_score, cooperation_score")
      .eq("status", "active"),
  ]);

  const result = runRiskPredictor({
    allocations: allocRes.data ?? [],
    corrections: corrRes.data ?? [],
    lines: linesRes.data ?? [],
    factories: factRes.data ?? [],
  });

  res.json({
    agent: "risk-predictor",
    ...result,
    timestamp: new Date().toISOString(),
  });
}));

// POST /api/agents/correct — run progress correction agent
router.post("/correct", asyncHandler(async (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  const [allocRes, corrRes, reportsRes] = await Promise.all([
    supabase
      .from("production_allocations")
      .select("id, order_id, factory_id, product_type, allocated_qty, planned_start_date, planned_end_date, status")
      .not("status", "eq", "completed")
      .not("status", "eq", "cancelled"),
    supabase
      .from("order_corrections")
      .select("allocation_id, order_id, factory_id, risk_status, deviation_pct, estimated_end_date, actual_cumulative, planned_cumulative"),
    supabase
      .from("daily_production_reports")
      .select("factory_id, allocation_id, order_id, actual_output, is_abnormal, abnormal_reason, date")
      .gte("date", new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)),
  ]);

  const result = runCorrector({
    allocations: allocRes.data ?? [],
    corrections: corrRes.data ?? [],
    reports: reportsRes.data ?? [],
  });

  res.json({
    agent: "corrector",
    ...result,
    timestamp: new Date().toISOString(),
  });
}));

// POST /api/agents/calibrate — run calibration agent
router.post("/calibrate", asyncHandler(async (_req, res) => {
  const [factRes, perfRes] = await Promise.all([
    supabase
      .from("factories")
      .select("id, name, status, quality_score, delay_score, factory_capabilities(id, product_type, daily_capacity, base_capacity_units_per_day, efficiency_rate)")
      .eq("status", "active"),
    supabase
      .from("factory_performance_logs")
      .select("factory_id, metric_type, metric_value, occurred_at")
      .gte("occurred_at", new Date(Date.now() - 30 * 86400000).toISOString())
      .order("occurred_at", { ascending: false }),
  ]);

  const result = runCalibrator({
    factories: factRes.data ?? [],
    performanceLogs: perfRes.data ?? [],
  });

  res.json({
    agent: "calibrator",
    ...result,
    timestamp: new Date().toISOString(),
  });
}));

export default router;
