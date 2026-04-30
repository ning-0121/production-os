/**
 * Agent API routes — invoke AI agents on demand.
 */

import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { runRiskPredictor } from "../agents/risk-predictor.js";
import { runCorrector } from "../agents/corrector.js";
import { runCalibrator } from "../agents/calibrator.js";
import { runMaterialAgent } from "../agents/material-agent.js";
import { runLLMAgent, createAnalysisBatch, getBatchStatus, getBatchResults } from "../agents/llm-agent.js";
import { validate, schemas } from "../middleware/validate.js";

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

  // Log any partial failures so partial-data warnings surface
  for (const [name, r] of [["allocations", allocRes], ["corrections", corrRes], ["lines", linesRes], ["factories", factRes]]) {
    if (r.error) console.error(JSON.stringify({ level: "WARN", agent: "risk-predict", source: name, error: r.error.message }));
  }

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

// POST /api/agents/material-check — run material readiness agent
router.post("/material-check", asyncHandler(async (_req, res) => {
  const [ordersRes, reqsRes, posRes, invRes] = await Promise.all([
    supabase.from("orders").select("id, order_number, product_type, total_qty, due_date, status").in("status", ["new", "confirmed", "in_production"]),
    supabase.from("material_requirements").select("*"),
    supabase.from("purchase_orders").select("id, po_number, supplier_id, order_id, expected_date, status").in("status", ["sent", "confirmed"]),
    supabase.from("material_inventory").select("material_id, qty_on_hand, qty_reserved"),
  ]);

  const result = runMaterialAgent({
    orders: ordersRes.data ?? [],
    requirements: reqsRes.data ?? [],
    purchaseOrders: posRes.data ?? [],
    inventory: invRes.data ?? [],
  });

  res.json({ agent: "material-agent", ...result, timestamp: new Date().toISOString() });
}));

// POST /api/agents/ask — LLM-powered production assistant
router.post("/ask", validate(schemas.llmQuestion), asyncHandler(async (req, res) => {
  const { question } = req.body;
  const result = await runLLMAgent(question);
  res.json({
    agent: "llm-agent",
    question,
    ...result,
    timestamp: new Date().toISOString(),
  });
}));

// POST /api/agents/batch/analyze — submit bulk analysis (50% cheaper)
router.post("/batch/analyze", asyncHandler(async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "items array required" });
  }
  if (items.length > 100) {
    return res.status(400).json({ error: "Max 100 items per batch" });
  }
  const result = await createAnalysisBatch(items);
  res.status(201).json(result);
}));

// GET /api/agents/batch/:id — check batch status
router.get("/batch/:id", asyncHandler(async (req, res) => {
  const result = await getBatchStatus(req.params.id);
  res.json(result);
}));

// GET /api/agents/batch/:id/results — retrieve batch results
router.get("/batch/:id/results", asyncHandler(async (req, res) => {
  const results = await getBatchResults(req.params.id);
  res.json({ batch_id: req.params.id, count: results.length, results });
}));

export default router;
