/**
 * Quality — QC 检验 + 缺陷 + 返工
 */
import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

const router = Router();

// ── QC Inspections ──
router.get("/inspections", asyncHandler(async (req, res) => {
  let query = supabase.from("qc_inspections")
    .select("*, orders(id, order_number, product_type), factories(id, name), qc_defects(*)")
    .order("created_at", { ascending: false }).limit(50);
  if (req.query.order_id) query = query.eq("order_id", req.query.order_id);
  if (req.query.factory_id) query = query.eq("factory_id", req.query.factory_id);
  if (req.query.type) query = query.eq("inspection_type", req.query.type);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
}));

router.post("/inspections", asyncHandler(async (req, res) => {
  const { order_id, factory_id, inspection_type, inspector, inspection_date, total_qty_inspected, total_defects, aql_level, result, notes, defects } = req.body;
  if (!inspection_type) return res.status(400).json({ error: "inspection_type required" });

  const defectRate = total_qty_inspected > 0 ? Math.round((total_defects / total_qty_inspected) * 10000) / 100 : 0;

  const { data: insp, error: inspErr } = await supabase.from("qc_inspections")
    .insert({ order_id, factory_id, inspection_type, inspector, inspection_date, total_qty_inspected, total_defects, defect_rate_pct: defectRate, aql_level, result, notes })
    .select().single();
  if (inspErr) return res.status(400).json({ error: inspErr.message });

  if (Array.isArray(defects) && defects.length > 0) {
    const rows = defects.map((d) => ({ ...d, inspection_id: insp.id }));
    await supabase.from("qc_defects").insert(rows);
  }
  res.status(201).json(insp);
}));

// ── Defect Library ──
router.get("/defects/library", asyncHandler(async (_req, res) => {
  const { data, error } = await supabase.from("defect_library").select("*").order("code");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
}));

// ── Rework Orders ──
router.get("/reworks", asyncHandler(async (req, res) => {
  let query = supabase.from("rework_orders")
    .select("*, orders(id, order_number), factories(id, name)")
    .order("created_at", { ascending: false });
  if (req.query.status) query = query.eq("status", req.query.status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
}));

router.post("/reworks", asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("rework_orders").insert(req.body).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
}));

router.patch("/reworks/:id", asyncHandler(async (req, res) => {
  const allowed = ["status", "actual_days", "cost", "delay_days"];
  const updates = {};
  for (const k of allowed) { if (req.body[k] !== undefined) updates[k] = req.body[k]; }
  const { data, error } = await supabase.from("rework_orders").update(updates).eq("id", req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
}));

// ── Order Financials ──
router.get("/financials/:orderId", asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("order_financials").select("*").eq("order_id", req.params.orderId).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? { order_id: req.params.orderId, status: "none" });
}));

router.post("/financials", asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("order_financials").upsert(req.body, { onConflict: "order_id" }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
}));

export default router;
