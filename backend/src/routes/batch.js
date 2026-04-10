import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validate, schemas } from "../middleware/validate.js";
import { auditLog } from "../governance/audit.js";

const router = Router();

// POST /api/batch/allocations — batch operations on allocations
router.post("/allocations", validate(schemas.batchAllocations), asyncHandler(async (req, res) => {
  const { ids, action } = req.body;

  let result;
  const summary = { success: 0, failed: 0, details: [] };

  if (action === "delete") {
    const { error, count } = await supabase
      .from("production_allocations")
      .delete()
      .in("id", ids)
      .in("status", ["planned"]); // only delete planned orders

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    summary.success = count ?? 0;
    summary.failed = ids.length - summary.success;
  } else {
    // Map action to status
    const statusMap = {
      confirm: "confirmed",
      cancel: "cancelled",
      start: "in_progress",
    };
    const newStatus = statusMap[action];

    // Determine which source statuses are allowed
    const allowedFrom = {
      confirm: ["planned"],
      cancel: ["planned", "confirmed"],
      start: ["confirmed"],
    };

    const { data, error } = await supabase
      .from("production_allocations")
      .update({ status: newStatus })
      .in("id", ids)
      .in("status", allowedFrom[action])
      .select("id");

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    summary.success = data?.length ?? 0;
    summary.failed = ids.length - summary.success;
  }

  auditLog({
    action: `allocation.batch_${action}`,
    category: "allocation",
    result_status: summary.failed > 0 ? "partial" : "success",
    req,
    detail: { action, count: ids.length, success: summary.success, failed: summary.failed },
  });

  res.json(summary);
}));

export default router;
