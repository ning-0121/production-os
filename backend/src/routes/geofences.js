import { Router } from "express";
import { addDays } from "date-fns";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

const router = Router();

// GET /api/geofences — list active geofences with factory name
router.get("/", asyncHandler(async (req, res) => {
  const query = supabase
    .from("factory_geo_fences")
    .select("*, factories(id, name)")
    .order("factory_id");

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Normalize lat/lng to center object for frontend compatibility
  const normalized = (data ?? []).map((f) => ({
    ...f,
    center: (f.lat != null && f.lng != null) ? { lat: f.lat, lng: f.lng } : null,
  }));

  res.json(normalized);
}));

// GET /api/geofences/tasks?factory_id=xxx — get visit tasks for a factory
router.get("/tasks", asyncHandler(async (req, res) => {
  const { factory_id } = req.query;
  if (!factory_id) return res.status(400).json({ error: "factory_id required" });

  const { data, error } = await supabase
    .from("factory_visit_tasks")
    .select("*")
    .eq("factory_id", factory_id)
    .in("status", ["open", "in_progress"])
    .order("priority");

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
}));

// POST /api/geofences/generate-tasks — auto-generate visit tasks from orders
router.post("/generate-tasks", asyncHandler(async (req, res) => {
  const { factory_id } = req.body;
  if (!factory_id) return res.status(400).json({ error: "factory_id is required" });

  // 1. Fetch active allocations for this factory
  const { data: allocs, error: allocErr } = await supabase
    .from("production_allocations")
    .select("id, order_id, allocated_qty, planned_start_date, planned_end_date, status")
    .eq("factory_id", factory_id)
    .in("status", ["planned", "confirmed", "in_progress"])
    .order("planned_end_date");

  if (allocErr) return res.status(500).json({ error: allocErr.message });

  // 2. Fetch risk alerts for these allocations
  const allocIds = (allocs ?? []).map((a) => a.id);
  let riskMap = {};
  if (allocIds.length > 0) {
    const { data: risks } = await supabase
      .from("risk_alerts")
      .select("allocation_id, risk_level, buffer_days, message")
      .in("allocation_id", allocIds);
    for (const r of risks ?? []) {
      riskMap[r.allocation_id] = r;
    }
  }

  // 3. Fetch existing open tasks to avoid duplicates
  const { data: existingTasks } = await supabase
    .from("factory_visit_tasks")
    .select("order_id, task_type")
    .eq("factory_id", factory_id)
    .in("status", ["open", "in_progress"]);

  const existingSet = new Set(
    (existingTasks ?? []).map((t) => `${t.order_id}:${t.task_type}`),
  );

  // 4. Generate tasks
  const now = new Date();
  const threeDaysOut = addDays(now, 3);
  const tasks = [];

  for (const alloc of allocs ?? []) {
    const endDate = new Date(alloc.planned_end_date);
    const risk = riskMap[alloc.id];
    const dueSoon = endDate <= threeDaysOut;
    const notStarted = alloc.status === "planned" || alloc.status === "confirmed";
    const highRisk = risk?.risk_level === "HIGH";
    const orderLabel = alloc.order_id ?? alloc.id.slice(0, 8);

    // Task: not started orders → check production readiness
    if (notStarted && !existingSet.has(`${alloc.order_id}:readiness_check`)) {
      tasks.push({
        factory_id,
        order_id: alloc.order_id,
        task_type: "readiness_check",
        status: "open",
        priority: alloc.status === "planned" ? 2 : 1,
      });
    }

    // Task: high-risk orders → urgent inspection
    if (highRisk && !existingSet.has(`${alloc.order_id}:risk_inspection`)) {
      tasks.push({
        factory_id,
        order_id: alloc.order_id,
        task_type: "risk_inspection",
        status: "open",
        priority: 3,
      });
    }

    // Task: due in <3 days → delivery verification
    if (dueSoon && !highRisk && !existingSet.has(`${alloc.order_id}:delivery_check`)) {
      tasks.push({
        factory_id,
        order_id: alloc.order_id,
        task_type: "delivery_check",
        status: "open",
        priority: 2,
      });
    }
  }

  // 5. Preview or persist
  const preview = req.body.preview === true;

  if (preview) {
    // Return proposed tasks without writing to DB
    return res.json({
      preview: true,
      proposed: tasks.length,
      tasks,
      factory_id,
      orders_scanned: (allocs ?? []).length,
    });
  }

  // Persist
  let inserted = [];
  if (tasks.length > 0) {
    const { data, error: insertErr } = await supabase
      .from("factory_visit_tasks")
      .insert(tasks)
      .select();

    if (insertErr) return res.status(500).json({ error: insertErr.message });
    inserted = data ?? [];
  }

  res.json({
    preview: false,
    generated: inserted.length,
    tasks: inserted,
    factory_id,
    orders_scanned: (allocs ?? []).length,
  });
}));

// PATCH /api/geofences/tasks/:id — update task (status, notes, photo, checked_at)
router.patch("/tasks/:id", asyncHandler(async (req, res) => {
  const updates = {};
  const directFields = ["status", "task_type", "priority"];
  for (const k of directFields) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No valid fields to update" });
  }

  const { data, error } = await supabase
    .from("factory_visit_tasks")
    .update(updates)
    .eq("id", req.params.id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
}));

export default router;
