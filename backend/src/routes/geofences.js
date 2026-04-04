import { Router } from "express";
import { addDays } from "date-fns";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

const router = Router();

// GET /api/geofences — list active geofences with factory name
router.get("/", asyncHandler(async (req, res) => {
  let query = supabase
    .from("factory_geo_fences")
    .select("*, factories(id, name)")
    .order("name");

  if (req.query.active !== "false") {
    query = query.eq("is_active", true);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // PostGIS geography columns come back as WKT or GeoJSON depending on config.
  // Normalize center to { lat, lng } for the frontend.
  const normalized = (data ?? []).map((f) => {
    let center = null;
    if (f.center) {
      // Supabase returns geography as GeoJSON: { type: "Point", coordinates: [lng, lat] }
      if (typeof f.center === "object" && f.center.coordinates) {
        center = { lng: f.center.coordinates[0], lat: f.center.coordinates[1] };
      }
    }
    return { ...f, center };
  });

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
    .order("priority", { ascending: false });

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
    .select("id, product_type, quantity, start_at, end_at, status, priority")
    .eq("factory_id", factory_id)
    .in("status", ["planned", "confirmed", "in_progress"])
    .order("end_at");

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
    .select("allocation_id, task_type")
    .eq("factory_id", factory_id)
    .in("status", ["open", "in_progress"]);

  const existingSet = new Set(
    (existingTasks ?? []).map((t) => `${t.allocation_id}:${t.task_type}`),
  );

  // 4. Generate tasks
  const now = new Date();
  const threeDaysOut = addDays(now, 3);
  const tasks = [];

  for (const alloc of allocs ?? []) {
    const endDate = new Date(alloc.end_at);
    const risk = riskMap[alloc.id];
    const dueSoon = endDate <= threeDaysOut;
    const notStarted = alloc.status === "planned" || alloc.status === "confirmed";
    const highRisk = risk?.risk_level === "HIGH";

    // Task: not started orders → check production readiness
    if (notStarted && !existingSet.has(`${alloc.id}:readiness_check`)) {
      tasks.push({
        factory_id,
        allocation_id: alloc.id,
        title: `Check readiness: ${alloc.product_type} x${alloc.quantity}`,
        description: `Order not yet started. Verify materials, tooling, and line capacity are prepared.`,
        task_type: "readiness_check",
        status: "open",
        priority: alloc.status === "planned" ? 2 : 1,
        due_at: alloc.start_at,
        metadata: {
          auto_generated: true,
          reason: "order_not_started",
          allocation_status: alloc.status,
          product_type: alloc.product_type,
          quantity: alloc.quantity,
          end_at: alloc.end_at,
        },
      });
    }

    // Task: high-risk orders → urgent inspection
    if (highRisk && !existingSet.has(`${alloc.id}:risk_inspection`)) {
      tasks.push({
        factory_id,
        allocation_id: alloc.id,
        title: `URGENT: ${alloc.product_type} x${alloc.quantity} — ${risk.message ?? "high risk"}`,
        description: `High-risk order detected (buffer: ${risk.buffer_days}d). Inspect progress on production line.`,
        task_type: "risk_inspection",
        status: "open",
        priority: 3,
        due_at: alloc.end_at,
        metadata: {
          auto_generated: true,
          reason: "high_risk",
          risk_level: risk.risk_level,
          buffer_days: risk.buffer_days,
          product_type: alloc.product_type,
          quantity: alloc.quantity,
          end_at: alloc.end_at,
        },
      });
    }

    // Task: due in <3 days → delivery verification
    if (dueSoon && !highRisk && !existingSet.has(`${alloc.id}:delivery_check`)) {
      const daysLeft = Math.max(0, Math.floor((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
      tasks.push({
        factory_id,
        allocation_id: alloc.id,
        title: `Due soon (${daysLeft}d): ${alloc.product_type} x${alloc.quantity}`,
        description: `Order due within 3 days. Verify output count and quality before shipment.`,
        task_type: "delivery_check",
        status: "open",
        priority: 2,
        due_at: alloc.end_at,
        metadata: {
          auto_generated: true,
          reason: "due_soon",
          days_remaining: daysLeft,
          product_type: alloc.product_type,
          quantity: alloc.quantity,
          end_at: alloc.end_at,
        },
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
  // First load existing task to merge metadata
  const { data: existing, error: loadErr } = await supabase
    .from("factory_visit_tasks")
    .select("metadata")
    .eq("id", req.params.id)
    .single();

  if (loadErr) return res.status(404).json({ error: loadErr.message });

  const updates = {};
  const directFields = ["status", "assigned_to", "title", "description"];
  for (const k of directFields) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }

  // Merge metadata fields (notes, photo_url, checked_at, etc.) into existing metadata
  const metaUpdates = {};
  if (req.body.notes !== undefined) metaUpdates.notes = req.body.notes;
  if (req.body.photo_url !== undefined) metaUpdates.photo_url = req.body.photo_url;
  if (req.body.checked_at !== undefined) metaUpdates.checked_at = req.body.checked_at;
  if (req.body.metadata !== undefined) Object.assign(metaUpdates, req.body.metadata);

  if (Object.keys(metaUpdates).length > 0) {
    updates.metadata = { ...(existing.metadata ?? {}), ...metaUpdates };
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
