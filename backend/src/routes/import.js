import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validate, schemas } from "../middleware/validate.js";
import { auditLog } from "../governance/audit.js";

const router = Router();

// POST /api/import/orders — batch create orders from import
router.post("/orders", validate(schemas.batchImportOrders), asyncHandler(async (req, res) => {
  const { orders } = req.body;

  const rows = orders.map((o) => ({
    allocated_qty: o.quantity,
    planned_start_date: new Date().toISOString(),
    planned_end_date: o.end_date,
    status: "planned",
    order_id: o.order_id ?? o.order_external_id ?? null,
  }));

  const { data, error } = await supabase
    .from("production_allocations")
    .insert(rows)
    .select("id");

  if (error) {
    auditLog({
      action: "allocation.batch_import",
      category: "allocation",
      result_status: "failed",
      req,
      error_code: "db_error",
      detail: { count: orders.length, error: error.message },
    });
    return res.status(500).json({ error: error.message, created: 0, failed: orders.length });
  }

  auditLog({
    action: "allocation.batch_import",
    category: "allocation",
    result_status: "success",
    req,
    detail: { created: data.length, total: orders.length },
  });

  res.status(201).json({
    created: data.length,
    failed: orders.length - data.length,
    ids: data.map((d) => d.id),
  });
}));

export default router;
