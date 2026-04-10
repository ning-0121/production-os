import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validate, schemas } from "../middleware/validate.js";
import { computeCorrections } from "../scheduler/correction.js";

const router = Router();

// POST /api/daily-reports — submit a single daily production report
router.post("/", validate(schemas.submitReport), asyncHandler(async (req, res) => {
  const {
    date, factory_id, line_id, allocation_id, order_id,
    planned_output, actual_output, cumulative_output,
    stage, is_abnormal, abnormal_reason, note, reporter,
  } = req.body;

  const { data, error } = await supabase
    .from("daily_production_reports")
    .insert({
      date, factory_id, line_id, allocation_id, order_id,
      planned_output, actual_output, cumulative_output,
      stage, is_abnormal: is_abnormal ?? false, abnormal_reason, note, reporter,
    })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  // Auto-trigger correction computation (fire-and-forget)
  computeCorrections(supabase).catch((err) => {
    console.error(JSON.stringify({ level: "WARN", msg: "Auto-correction failed", error: err.message }));
  });

  res.status(201).json(data);
}));

// POST /api/daily-reports/batch — bulk upload array of reports
router.post("/batch", validate(schemas.batchReports), asyncHandler(async (req, res) => {
  const { reports } = req.body;

  const rows = reports.map((r) => ({
    date: r.date,
    factory_id: r.factory_id,
    line_id: r.line_id ?? null,
    allocation_id: r.allocation_id ?? null,
    order_id: r.order_id ?? null,
    planned_output: r.planned_output ?? null,
    actual_output: r.actual_output ?? null,
    cumulative_output: r.cumulative_output ?? null,
    stage: r.stage ?? null,
    is_abnormal: r.is_abnormal ?? false,
    abnormal_reason: r.abnormal_reason ?? null,
    note: r.note ?? null,
    reporter: r.reporter ?? null,
  }));

  const { data, error } = await supabase
    .from("daily_production_reports")
    .insert(rows)
    .select();

  if (error) return res.status(400).json({ error: error.message });

  // Auto-trigger correction computation (fire-and-forget)
  computeCorrections(supabase).catch((err) => {
    console.error(JSON.stringify({ level: "WARN", msg: "Auto-correction failed after batch", error: err.message }));
  });

  res.status(201).json({ inserted: data.length, data });
}));

// GET /api/daily-reports — query reports with filters
router.get("/", asyncHandler(async (req, res) => {
  let query = supabase
    .from("daily_production_reports")
    .select("*")
    .order("date", { ascending: false });

  if (req.query.date) query = query.eq("date", req.query.date);
  if (req.query.factory_id) query = query.eq("factory_id", req.query.factory_id);
  if (req.query.line_id) query = query.eq("line_id", req.query.line_id);
  if (req.query.allocation_id) query = query.eq("allocation_id", req.query.allocation_id);
  if (req.query.order_id) query = query.eq("order_id", req.query.order_id);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
}));

// GET /api/daily-reports/unreported — factories that have NOT submitted for the given date
router.get("/unreported", asyncHandler(async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "date query parameter is required" });

  // 1. Load all active factories
  const { data: factories, error: facErr } = await supabase
    .from("factories")
    .select("id, name, status")
    .eq("status", "active");

  if (facErr) return res.status(500).json({ error: facErr.message });

  // 2. Load factory_ids that have reports for this date
  const { data: reported, error: repErr } = await supabase
    .from("daily_production_reports")
    .select("factory_id")
    .eq("date", date);

  if (repErr) return res.status(500).json({ error: repErr.message });

  const reportedIds = new Set((reported ?? []).map((r) => r.factory_id));

  // 3. Filter to unreported
  const unreported = (factories ?? []).filter((f) => !reportedIds.has(f.id));

  res.json({ date, total_factories: (factories ?? []).length, unreported_count: unreported.length, unreported });
}));

// GET /api/daily-reports/summary — aggregate summary for a date
router.get("/summary", asyncHandler(async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "date query parameter is required" });

  const { data: reports, error } = await supabase
    .from("daily_production_reports")
    .select("actual_output, order_id, is_abnormal, factory_id")
    .eq("date", date);

  if (error) return res.status(500).json({ error: error.message });

  const rows = reports ?? [];
  const total_output = rows.reduce((sum, r) => sum + Number(r.actual_output ?? 0), 0);
  const orders_reported = new Set(rows.map((r) => r.order_id).filter(Boolean)).size;
  const abnormal_count = rows.filter((r) => r.is_abnormal).length;
  const factories_reported = new Set(rows.map((r) => r.factory_id)).size;

  res.json({ date, total_output, orders_reported, abnormal_count, factories_reported });
}));

export default router;
