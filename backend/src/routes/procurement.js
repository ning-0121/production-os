/**
 * Procurement — 供应商 + 采购单 + 验布
 */
import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validate, schemas } from "../middleware/validate.js";

const router = Router();

// ── Suppliers ──
router.get("/suppliers", asyncHandler(async (_req, res) => {
  const { data, error } = await supabase.from("suppliers").select("*").order("name");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
}));

router.post("/suppliers", validate(schemas.createSupplier), asyncHandler(async (req, res) => {
  const { code, name, category, contact_name, contact_phone, contact_email, payment_terms, lead_time_days } = req.body;
  const { data, error } = await supabase.from("suppliers")
    .insert({ code, name, category, contact_name, contact_phone, contact_email, payment_terms, lead_time_days }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
}));

// ── Purchase Orders ──
router.get("/purchase-orders", asyncHandler(async (req, res) => {
  let query = supabase.from("purchase_orders")
    .select("*, suppliers(id, name), purchase_order_lines(*, materials(id, code, name))")
    .order("created_at", { ascending: false });
  if (req.query.status) query = query.eq("status", req.query.status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
}));

router.post("/purchase-orders", validate(schemas.createPO), asyncHandler(async (req, res) => {
  const { po_number, supplier_id, order_id, expected_date, notes, lines } = req.body;

  const totalAmount = (lines ?? []).reduce((s, l) => s + (Number(l.qty_ordered ?? 0) * Number(l.unit_price ?? 0)), 0);

  const { data: po, error: poErr } = await supabase.from("purchase_orders")
    .insert({ po_number, supplier_id, order_id, expected_date, notes, total_amount: totalAmount, created_by: req.pilotIdentity?.operator ?? "anonymous" })
    .select().single();
  if (poErr) return res.status(400).json({ error: poErr.message });

  if (Array.isArray(lines) && lines.length > 0) {
    const rows = lines.map((l) => ({ ...l, po_id: po.id }));
    await supabase.from("purchase_order_lines").insert(rows);
  }
  res.status(201).json(po);
}));

router.patch("/purchase-orders/:id/receive", validate(schemas.receivePO), asyncHandler(async (req, res) => {
  const { lines } = req.body; // [{ line_id, qty_received, qty_rejected }]

  for (const l of lines) {
    const { error: lineErr } = await supabase.from("purchase_order_lines")
      .update({ qty_received: l.qty_received, qty_rejected: l.qty_rejected ?? 0 })
      .eq("id", l.line_id);
    if (lineErr) {
      console.error(JSON.stringify({ level: "ERROR", op: "po_receive_line", line_id: l.line_id, error: lineErr.message }));
    }
  }

  const { data: po } = await supabase.from("purchase_orders")
    .update({ status: "received", actual_date: new Date().toISOString().slice(0, 10) })
    .eq("id", req.params.id).select().single();

  // Calculate delay
  if (po?.expected_date && po?.actual_date) {
    const delay = Math.ceil((new Date(po.actual_date).getTime() - new Date(po.expected_date).getTime()) / 86400000);
    if (delay !== 0) {
      await supabase.from("purchase_orders").update({ delay_days: delay }).eq("id", po.id);
    }
  }

  res.json(po);
}));

// ── Fabric Inspections ──
router.post("/inspections", asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("fabric_inspections")
    .insert(req.body).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
}));

router.get("/inspections", asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("fabric_inspections")
    .select("*, materials(id, code, name)")
    .order("created_at", { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
}));

export default router;
