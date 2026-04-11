/**
 * Orders V2 — 订单主表 CRUD（v4 新增，与 allocations 并行）
 */
import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

const router = Router();

router.get("/", asyncHandler(async (req, res) => {
  let query = supabase.from("orders")
    .select("*, customers(id, name, vip_level)")
    .order("created_at", { ascending: false });
  if (req.query.status) query = query.eq("status", req.query.status);
  if (req.query.customer_id) query = query.eq("customer_id", req.query.customer_id);
  if (req.query.product_type) query = query.eq("product_type", req.query.product_type);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
}));

router.get("/:id", asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("orders")
    .select("*, customers(id, name, vip_level, country)")
    .eq("id", req.params.id).single();
  if (error) return res.status(404).json({ error: error.message });
  res.json(data);
}));

router.post("/", asyncHandler(async (req, res) => {
  const { order_number, customer_id, style_number, product_type, total_qty, unit_price, currency, due_date, ship_date, season, priority } = req.body;
  if (!order_number || !product_type || !total_qty) {
    return res.status(400).json({ error: "order_number, product_type, total_qty required" });
  }
  const { data, error } = await supabase.from("orders")
    .insert({ order_number, customer_id, style_number, product_type, total_qty, unit_price, currency, due_date, ship_date, season, priority })
    .select("*, customers(id, name)").single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
}));

router.patch("/:id", asyncHandler(async (req, res) => {
  const allowed = ["customer_id", "style_number", "product_type", "total_qty", "unit_price", "currency", "due_date", "ship_date", "season", "priority", "status", "bom_id"];
  const updates = {};
  for (const k of allowed) { if (req.body[k] !== undefined) updates[k] = req.body[k]; }
  const { data, error } = await supabase.from("orders").update(updates).eq("id", req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
}));

export default router;
