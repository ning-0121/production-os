import { Router } from "express";
import { addDays } from "date-fns";
import { supabase } from "../supabase.js";
import { recommendFactories } from "../scheduler/recommend.js";
import { calcProductionMinutes, pickCapability } from "../scheduler/calc.js";
import { onOrderCompleted } from "../scheduler/calibrate.js";
import { auditLog } from "../governance/audit.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validate, schemas } from "../middleware/validate.js";

const router = Router();

// GET /api/allocations — list allocations, optionally filter by status
router.get("/", asyncHandler(async (req, res) => {
  let query = supabase
    .from("production_allocations")
    .select("*, factories(id, name)")
    .order("planned_start_date");

  if (req.query.status) {
    query = query.eq("status", req.query.status);
  }
  if (req.query.factory_id) {
    query = query.eq("factory_id", req.query.factory_id);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
}));

// GET /api/allocations/:id
router.get("/:id", asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from("production_allocations")
    .select("*, factories(id, name)")
    .eq("id", req.params.id)
    .single();

  if (error) return res.status(404).json({ error: error.message });
  res.json(data);
}));

// POST /api/allocations — create new allocation
router.post("/", validate(schemas.createAllocation), asyncHandler(async (req, res) => {
  const { factory_id, allocated_qty, planned_start_date, planned_end_date, status, order_id } = req.body;

  const row = {
    allocated_qty,
    planned_start_date,
    planned_end_date,
    status: status ?? "planned",
    order_id: order_id ?? null,
  };
  if (factory_id) row.factory_id = factory_id;

  const { data, error } = await supabase
    .from("production_allocations")
    .insert(row)
    .select("*, factories(id, name)")
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
}));

// PATCH /api/allocations/:id — update allocation (status, dates, etc.)
// NOTE: Setting status to "confirmed" is blocked here — must use POST /:id/schedule
router.patch("/:id", asyncHandler(async (req, res) => {
  if (req.body.status === "confirmed") {
    return res.status(403).json({
      error: 'Cannot manually set status to "confirmed". Use POST /api/allocations/:id/schedule for system-driven scheduling.',
    });
  }

  const allowed = [
    "factory_id", "allocated_qty", "planned_start_date", "planned_end_date",
    "status", "order_id", "recommendation_score", "is_locked",
  ];
  const updates = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }

  const { data, error } = await supabase
    .from("production_allocations")
    .update(updates)
    .eq("id", req.params.id)
    .select("*, factories(id, name)")
    .single();

  if (error) {
    auditLog({ action: "allocation.update", category: "allocation", result_status: "failed", req, error_code: "db_error", detail: { allocation_id: req.params.id, error: error.message } });
    return res.status(400).json({ error: error.message });
  }

  auditLog({ action: "allocation.update", category: "allocation", result_status: "success", req, detail: { allocation_id: data.id, new_status: data.status, factory_id: data.factory_id } });

  // Auto-trigger performance logging + recalibration on completion
  if (data.status === "completed") {
    auditLog({ action: "calibration.auto_trigger", category: "calibration", result_status: "success", req, detail: { allocation_id: data.id, order_id: data.order_id } });
    onOrderCompleted(data).catch((err) => {
      auditLog({ action: "calibration.auto_trigger", category: "calibration", result_status: "failed", req, error_code: "calibration_error", detail: { allocation_id: data.id, error: err.message } });
    });
  }

  res.json(data);
}));

// POST /api/allocations/:id/recommend — get AI-ranked factory recommendations
router.post("/:id/recommend", asyncHandler(async (req, res) => {
  // 1. Load the allocation (the "order")
  const { data: alloc, error: allocErr } = await supabase
    .from("production_allocations")
    .select("*")
    .eq("id", req.params.id)
    .single();
  if (allocErr) return res.status(404).json({ error: allocErr.message });

  // 2. Load all active factories with capabilities
  const { data: factories, error: facErr } = await supabase
    .from("factories")
    .select("*, factory_capabilities(*)")
    .eq("status", "active");
  if (facErr) return res.status(500).json({ error: facErr.message });

  // 3. Compute current load per factory from existing non-terminal allocations
  const horizon = 30;
  const windowEnd = addDays(new Date(), horizon).toISOString();
  const { data: existingAllocs } = await supabase
    .from("production_allocations")
    .select("factory_id, planned_start_date, planned_end_date, allocated_qty")
    .in("status", ["planned", "confirmed", "in_progress"])
    .lte("planned_start_date", windowEnd);

  const loadByFactory = {};
  for (const ea of existingAllocs ?? []) {
    if (!loadByFactory[ea.factory_id]) loadByFactory[ea.factory_id] = 0;
    // Rough estimate: use allocated_qty and derive minutes from daily_capacity
    const fac = factories.find((f) => f.id === ea.factory_id);
    if (fac) {
      const caps = fac.factory_capabilities ?? [];
      const cap = caps[0]; // use first capability as estimate
      if (cap) {
        const minutesPerUnit = cap.daily_capacity > 0 ? 480 / cap.daily_capacity : 0;
        loadByFactory[ea.factory_id] += ea.allocated_qty * minutesPerUnit;
      }
    }
  }

  // 4. Build factory inputs for scheduler
  const factoryInputs = factories.map((f) => {
    const dailyMinutes = 8 * 60; // default 8hr workday
    const capacityWindow = dailyMinutes * horizon;
    const allocated = loadByFactory[f.id] ?? 0;
    return {
      id: f.id,
      name: f.name,
      capabilities: (f.factory_capabilities ?? []).map((c) => ({
        product_type: c.product_type,
        daily_capacity: c.daily_capacity,
        efficiency_rate: c.efficiency_rate,
        overtime_factor: c.overtime_factor,
        // Derived fields for scheduler compatibility
        setup_minutes: 0,
        minutes_per_unit: c.daily_capacity > 0 ? 480 / c.daily_capacity : 0,
        base_capacity_units_per_day: c.daily_capacity,
        cost_per_unit: null,
        quality_score: f.quality_score ?? null,
      })),
      capacity: { daily_capacity_minutes: dailyMinutes },
      load: {
        allocated_minutes_next_30d: allocated,
        utilization_pct: Math.min(100, (allocated / Math.max(1, capacityWindow)) * 100),
      },
    };
  });

  // 5. Run recommendation engine
  const order = {
    product_type: null, // product_type lives on capabilities, not allocations
    quantity: alloc.allocated_qty,
    due_date: alloc.planned_end_date,
  };
  const recs = recommendFactories(order, factoryInputs, req.body.options);
  res.json(recs);
}));

// POST /api/allocations/:id/schedule — validate capacity + assign factory
router.post("/:id/schedule", asyncHandler(async (req, res) => {
  const { factory_id } = req.body;
  if (!factory_id) return res.status(400).json({ error: "factory_id is required" });

  // 1. Load allocation
  const { data: alloc, error: allocErr } = await supabase
    .from("production_allocations")
    .select("*")
    .eq("id", req.params.id)
    .single();
  if (allocErr) return res.status(404).json({ error: allocErr.message });

  // 2. Load factory with capabilities
  const { data: factory, error: facErr } = await supabase
    .from("factories")
    .select("*, factory_capabilities(*)")
    .eq("id", factory_id)
    .single();
  if (facErr) return res.status(404).json({ error: "Factory not found" });

  // 3. Find capability (use first available since product_type is on capabilities, not allocations)
  const capability = (factory.factory_capabilities ?? [])[0];
  if (!capability) {
    return res.status(400).json({
      error: `Factory ${factory.name} has no capabilities configured`,
    });
  }

  // 4. Calculate production time
  const timing = calcProductionMinutes(
    { quantity: alloc.allocated_qty },
    capability,
  );

  // 5. Capacity validation — check existing load in the scheduling window
  const dailyMinutes = 8 * 60;
  const productionDays = Math.ceil(timing.total_minutes / dailyMinutes);
  const startAt = new Date();
  const endAt = addDays(startAt, Math.max(1, productionDays));

  // Sum existing allocated minutes for this factory
  const { data: existingAllocs } = await supabase
    .from("production_allocations")
    .select("allocated_qty")
    .eq("factory_id", factory_id)
    .in("status", ["planned", "confirmed", "in_progress"])
    .neq("id", req.params.id); // exclude current order

  let existingMinutes = 0;
  for (const ea of existingAllocs ?? []) {
    const minutesPerUnit = capability.daily_capacity > 0 ? 480 / capability.daily_capacity : 0;
    existingMinutes += ea.allocated_qty * minutesPerUnit;
  }

  const horizon = 30;
  const capacityWindow = dailyMinutes * horizon;
  const newUtilization = ((existingMinutes + timing.total_minutes) / capacityWindow) * 100;

  if (newUtilization > 100) {
    return res.status(409).json({
      error: `Capacity exceeded: scheduling would bring ${factory.name} to ${Math.round(newUtilization)}% utilization (max 100%)`,
      utilization_pct: Math.round(newUtilization),
      existing_minutes: existingMinutes,
      new_minutes: timing.total_minutes,
      capacity_minutes: capacityWindow,
    });
  }

  // 6. Update allocation — assign factory, set dates, move to confirmed
  const { data: updated, error: updateErr } = await supabase
    .from("production_allocations")
    .update({
      factory_id,
      planned_start_date: startAt.toISOString(),
      planned_end_date: endAt.toISOString(),
      status: "confirmed",
      recommendation_score: Math.round(newUtilization),
    })
    .eq("id", req.params.id)
    .select("*, factories(id, name)")
    .single();

  if (updateErr) return res.status(400).json({ error: updateErr.message });
  res.json(updated);
}));

// DELETE /api/allocations/:id
router.delete("/:id", asyncHandler(async (req, res) => {
  const { error } = await supabase
    .from("production_allocations")
    .delete()
    .eq("id", req.params.id);

  if (error) return res.status(400).json({ error: error.message });
  res.status(204).end();
}));

export default router;
