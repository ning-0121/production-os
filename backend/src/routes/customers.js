/**
 * Customer routes — V4 customers table.
 * Real users need to add customers before they can create orders.
 */

import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validate, schemas } from "../middleware/validate.js";
import { auditLog } from "../governance/audit.js";

const router = Router();

// GET /api/customers — list
router.get("/", asyncHandler(async (req, res) => {
  let q = supabase
    .from("customers")
    .select("*")
    .order("created_at", { ascending: false });
  if (req.query.vip_level) q = q.eq("vip_level", String(req.query.vip_level));
  if (req.query.q) q = q.or(`name.ilike.%${req.query.q}%,code.ilike.%${req.query.q}%`);
  const { data, error } = await q;
  if (error) throw error;
  res.json(data ?? []);
}));

// GET /api/customers/:id — detail
router.get("/:id", asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from("customers")
    .select("*")
    .eq("id", req.params.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return res.status(404).json({ error: "Customer not found" });
  res.json(data);
}));

// POST /api/customers — create
router.post("/", validate(schemas.createCustomer), asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from("customers")
    .insert(req.body)
    .select()
    .single();
  if (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: `客户代码 "${req.body.code}" 已存在` });
    }
    throw error;
  }
  auditLog({ action: "customer.create", category: "system", result_status: "success", req,
    detail: { id: data.id, code: data.code, name: data.name } });
  res.status(201).json(data);
}));

// PATCH /api/customers/:id — update
router.patch("/:id", validate(schemas.updateCustomer), asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from("customers")
    .update({ ...req.body, updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .select()
    .single();
  if (error) throw error;
  if (!data) return res.status(404).json({ error: "Customer not found" });
  auditLog({ action: "customer.update", category: "system", result_status: "success", req,
    detail: { id: data.id, fields: Object.keys(req.body) } });
  res.json(data);
}));

// DELETE /api/customers/:id
router.delete("/:id", asyncHandler(async (req, res) => {
  // Soft check — has orders?
  const { count } = await supabase
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("customer_id", req.params.id);
  if ((count ?? 0) > 0) {
    return res.status(409).json({ error: `该客户有 ${count} 个订单，无法删除` });
  }
  const { error } = await supabase.from("customers").delete().eq("id", req.params.id);
  if (error) throw error;
  auditLog({ action: "customer.delete", category: "system", result_status: "success", req,
    detail: { id: req.params.id } });
  res.status(204).end();
}));

export default router;
