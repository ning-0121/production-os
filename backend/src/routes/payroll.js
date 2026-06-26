/**
 * Payroll (piece-wage TRIAL) — /api/payroll/*
 *
 * Wedge S1. Lets the factory set 工序工价 and see daily piece-wage trial totals
 * computed from scan reports, plus reconciliation against the manual wage sheet.
 *
 * TRIAL ONLY — never authoritative payroll. Parallel-run + reconcile before pay.
 */

import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { auditLog } from "../governance/audit.js";
import { computeDailyPieceWages, computePilotReport, setPieceRate } from "../payroll/io.js";
import { reconcile } from "../payroll/piece-rate.js";

const router = Router();

const todayLocal = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());

// ── Rates ────────────────────────────────────────────────
router.get("/piece-rates", asyncHandler(async (_req, res) => {
  const { data, error } = await supabase
    .from("piece_rates").select("*").eq("active", true).order("operation", { ascending: true });
  if (error) throw error;
  res.json({ rates: data ?? [] });
}));

router.post("/piece-rates", asyncHandler(async (req, res) => {
  const { operation, line_id, unit_price, currency, note } = req.body ?? {};
  if (!operation || !(Number(unit_price) >= 0)) {
    return res.status(400).json({ error: "operation 与 unit_price(>=0) 必填" });
  }
  const rate = await setPieceRate(supabase, {
    operation, line_id: line_id ?? null, unit_price, currency, note,
    actor: req.pilotIdentity?.operator ?? "admin",
  });
  auditLog({ action: "payroll.set_piece_rate", category: "system", result_status: "success", req, detail: { operation, line_id: line_id ?? null, unit_price } });
  res.status(201).json(rate);
}));

router.delete("/piece-rates/:id", asyncHandler(async (req, res) => {
  // Soft-deactivate, never hard-delete (keep the audit/history of what was paid-by).
  const { error } = await supabase.from("piece_rates")
    .update({ active: false, updated_at: new Date().toISOString() }).eq("id", req.params.id);
  if (error) throw error;
  auditLog({ action: "payroll.deactivate_piece_rate", category: "system", result_status: "success", req, detail: { id: req.params.id } });
  res.json({ ok: true });
}));

// ── Daily piece-wage trial summary ───────────────────────
router.get("/piece-wages", asyncHandler(async (req, res) => {
  const date = req.query.date || todayLocal();
  const line_id = req.query.line_id || null;
  const summary = await computeDailyPieceWages(supabase, { date, line_id });
  res.json(summary);
}));

// ── End-of-day S1 pilot report (dirty-data + readiness) ──
router.get("/pilot-report", asyncHandler(async (req, res) => {
  const date = req.query.date || todayLocal();
  const line_id = req.query.line_id || null;
  const report = await computePilotReport(supabase, { date, line_id });
  res.json(report);
}));

// ── Reconciliation against manual wage sheet (the <1% gate) ──
router.post("/piece-wages/reconcile", asyncHandler(async (req, res) => {
  const { date, line_id, manual } = req.body ?? {};
  if (!date || typeof manual !== "object" || manual == null) {
    return res.status(400).json({ error: "date 与 manual{worker:amount} 必填" });
  }
  const summary = await computeDailyPieceWages(supabase, { date, line_id: line_id ?? null });
  const result = reconcile(summary.by_worker, manual);
  res.json({ date, line_id: line_id ?? null, ...result });
}));

export default router;
