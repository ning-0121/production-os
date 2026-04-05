import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { runAPS } from "../scheduler/aps.js";

const router = Router();

// GET /api/lines — list production lines with factory info
router.get("/", asyncHandler(async (req, res) => {
  let query = supabase
    .from("production_lines")
    .select("*, factories(id, name)")
    .order("factory_id")
    .order("name");

  if (req.query.factory_id) {
    query = query.eq("factory_id", req.query.factory_id);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
}));

// GET /api/lines/schedules — get all line schedules with order info
router.get("/schedules", asyncHandler(async (req, res) => {
  let query = supabase
    .from("line_schedules")
    .select("*, production_lines(id, name, factory_id, front_capacity_per_day, back_capacity_per_day, factories(id, name)), production_allocations(id, order_id, allocated_qty, status)")
    .order("line_id")
    .order("process")
    .order("seq");

  if (req.query.line_id) {
    query = query.eq("line_id", req.query.line_id);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
}));

// POST /api/lines — create a production line
router.post("/", asyncHandler(async (req, res) => {
  const { factory_id, name, front_capacity_per_day, back_capacity_per_day } = req.body;
  if (!factory_id || !name) return res.status(400).json({ error: "factory_id and name required" });

  const { data, error } = await supabase
    .from("production_lines")
    .insert({ factory_id, name, front_capacity_per_day: front_capacity_per_day ?? 0, back_capacity_per_day: back_capacity_per_day ?? 0 })
    .select("*, factories(id, name)")
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
}));

// PATCH /api/lines/:id — update line capacity
router.patch("/:id", asyncHandler(async (req, res) => {
  const allowed = ["name", "front_capacity_per_day", "back_capacity_per_day", "status"];
  const updates = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }

  const { data, error } = await supabase
    .from("production_lines")
    .update(updates)
    .eq("id", req.params.id)
    .select("*, factories(id, name)")
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
}));

// POST /api/lines/schedule — assign an order to a line (front+back)
router.post("/schedule", asyncHandler(async (req, res) => {
  const { line_id, allocation_id, front_start, front_end, back_start, back_end } = req.body;
  if (!line_id || !allocation_id) return res.status(400).json({ error: "line_id and allocation_id required" });

  // Get current max seq for this line
  const { data: existing } = await supabase
    .from("line_schedules")
    .select("seq")
    .eq("line_id", line_id)
    .eq("process", "front")
    .order("seq", { ascending: false })
    .limit(1);

  const nextSeq = (existing?.[0]?.seq ?? 0) + 1;

  const rows = [
    { line_id, allocation_id, process: "front", start_date: front_start, end_date: front_end, seq: nextSeq, status: "pending" },
    { line_id, allocation_id, process: "back", start_date: back_start, end_date: back_end, seq: nextSeq, status: "pending" },
  ];

  const { data, error } = await supabase
    .from("line_schedules")
    .insert(rows)
    .select("*, production_allocations(id, order_id, allocated_qty)");

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
}));

// POST /api/lines/auto-schedule — 智能排单：输入前道天数，自动衔接
// Supports dry_run: true to preview schedule without persisting
router.post("/auto-schedule", asyncHandler(async (req, res) => {
  const { line_id, allocation_id, front_days, dry_run } = req.body;
  if (!line_id || !allocation_id || !front_days) {
    return res.status(400).json({ error: "line_id, allocation_id, front_days are required" });
  }

  // 1. Load line info (get back_capacity_per_day)
  const { data: line, error: lineErr } = await supabase
    .from("production_lines")
    .select("*")
    .eq("id", line_id)
    .single();
  if (lineErr) return res.status(404).json({ error: "Production line not found" });

  // 2. Load allocation (get quantity + product_type)
  const { data: alloc, error: allocErr } = await supabase
    .from("production_allocations")
    .select("id, order_id, allocated_qty, product_type, planned_end_date")
    .eq("id", allocation_id)
    .single();
  if (allocErr) return res.status(404).json({ error: "Allocation not found" });

  // 3. Find last front process end date on this line
  const { data: lastFront } = await supabase
    .from("line_schedules")
    .select("end_date")
    .eq("line_id", line_id)
    .eq("process", "front")
    .order("end_date", { ascending: false })
    .limit(1);

  const today = new Date().toISOString().slice(0, 10);
  const lastFrontEnd = lastFront?.[0]?.end_date ?? today;
  const frontStart = lastFrontEnd > today ? lastFrontEnd : today;

  // 4. Calculate front end date
  const frontStartDate = new Date(frontStart);
  const frontEndDate = new Date(frontStartDate);
  frontEndDate.setDate(frontEndDate.getDate() + Number(front_days));
  const frontEnd = frontEndDate.toISOString().slice(0, 10);

  // 5. Find last back process end date on this line
  const { data: lastBack } = await supabase
    .from("line_schedules")
    .select("end_date")
    .eq("line_id", line_id)
    .eq("process", "back")
    .order("end_date", { ascending: false })
    .limit(1);

  const lastBackEnd = lastBack?.[0]?.end_date ?? today;

  // 6. Back starts after BOTH front finishes AND last back finishes
  const backStartStr = frontEnd > lastBackEnd ? frontEnd : lastBackEnd;
  const backStartDate = new Date(backStartStr);

  // 7. Calculate back duration from quantity and capacity
  const backCapacity = line.back_capacity_per_day || 300;
  const qty = Number(alloc.allocated_qty) || 1000;
  const backDays = Math.ceil(qty / backCapacity);
  const backEndDate = new Date(backStartDate);
  backEndDate.setDate(backEndDate.getDate() + backDays);
  const backEnd = backEndDate.toISOString().slice(0, 10);

  // Compute risk: compare backEnd vs due date
  const dueDate = alloc.planned_end_date ? alloc.planned_end_date.slice(0, 10) : null;
  let risk_level = "SAFE";
  let buffer_days = 0;
  if (dueDate) {
    const dueMs = new Date(dueDate).getTime();
    const endMs = new Date(backEnd).getTime();
    buffer_days = Math.round((dueMs - endMs) / (1000 * 60 * 60 * 24));
    if (buffer_days < 0) risk_level = "HIGH";
    else if (buffer_days < 3) risk_level = "MEDIUM";
  }

  const summary = {
    order_id: alloc.order_id,
    product_type: alloc.product_type,
    qty,
    line_name: line.name,
    front: { start: frontStart, end: frontEnd, days: Number(front_days) },
    back: { start: backStartStr, end: backEnd, days: backDays, capacity_per_day: backCapacity },
    risk: { level: risk_level, buffer_days, due_date: dueDate },
  };

  // Dry run: return preview without persisting
  if (dry_run) {
    return res.json({ dry_run: true, summary });
  }

  // 8. Get next seq
  const { data: existing } = await supabase
    .from("line_schedules")
    .select("seq")
    .eq("line_id", line_id)
    .eq("process", "front")
    .order("seq", { ascending: false })
    .limit(1);
  const nextSeq = (existing?.[0]?.seq ?? 0) + 1;

  // 9. Insert both records
  const rows = [
    { line_id, allocation_id, process: "front", start_date: frontStart, end_date: frontEnd, seq: nextSeq, status: "pending" },
    { line_id, allocation_id, process: "back", start_date: backStartStr, end_date: backEnd, seq: nextSeq, status: "pending" },
  ];

  const { data, error } = await supabase
    .from("line_schedules")
    .insert(rows)
    .select("*, production_allocations(id, order_id, allocated_qty)");

  if (error) return res.status(400).json({ error: error.message });

  // Update allocation status to confirmed
  await supabase
    .from("production_allocations")
    .update({ status: "confirmed" })
    .eq("id", allocation_id);

  res.status(201).json({ scheduled: data, summary });
}));

// POST /api/lines/batch-schedule — 一键全排：自动排所有 planned 订单
router.post("/batch-schedule", asyncHandler(async (req, res) => {
  const dryRun = req.body.dry_run !== false; // default: preview only

  // 1. Load all planned (unscheduled) orders
  const { data: allOrders, error: ordErr } = await supabase
    .from("production_allocations")
    .select("id, order_id, product_type, allocated_qty, planned_end_date, status")
    .eq("status", "planned")
    .order("planned_end_date");

  if (ordErr) return res.status(500).json({ error: ordErr.message });

  // Filter out orders already in line_schedules
  const { data: existingSch } = await supabase
    .from("line_schedules")
    .select("allocation_id, line_id, process, end_date");

  const scheduledIds = new Set((existingSch ?? []).map((s) => s.allocation_id));
  const pendingOrders = (allOrders ?? []).filter((o) => !scheduledIds.has(o.id));

  if (pendingOrders.length === 0) {
    return res.json({ assignments: [], warnings: [{ type: "none", message: "没有待排产订单" }], summary: { total_orders: 0, scheduled: 0 } });
  }

  // 2. Load all production lines
  const { data: rawLines, error: lineErr } = await supabase
    .from("production_lines")
    .select("*, factories(id, name)")
    .eq("status", "active");

  if (lineErr) return res.status(500).json({ error: lineErr.message });

  const lines = (rawLines ?? []).map((l) => ({
    id: l.id,
    name: l.name,
    factory_id: l.factory_id,
    factory_name: l.factories?.name ?? "Unknown",
    product_types: l.product_types ?? [],
    front_capacity_per_day: l.front_capacity_per_day || 300,
    back_capacity_per_day: l.back_capacity_per_day || 200,
  }));

  // 3. Run APS engine
  const result = runAPS(pendingOrders, lines, existingSch ?? []);

  // 4. If not dry run, persist to database
  if (!dryRun && result.assignments.length > 0) {
    const rows = [];
    for (const a of result.assignments) {
      // Get next seq for this line
      const lineScheds = (existingSch ?? []).filter((s) => s.line_id === a.line_id && s.process === "front");
      const existingAssignments = result.assignments.filter((x) => x.line_id === a.line_id);
      const seqBase = lineScheds.length;
      const seqOffset = existingAssignments.indexOf(a);

      rows.push(
        { line_id: a.line_id, allocation_id: a.allocation_id, process: "front", start_date: a.front.start, end_date: a.front.end, seq: seqBase + seqOffset + 1, status: "pending" },
        { line_id: a.line_id, allocation_id: a.allocation_id, process: "back", start_date: a.back.start, end_date: a.back.end, seq: seqBase + seqOffset + 1, status: "pending" },
      );
    }

    const { error: insertErr } = await supabase
      .from("line_schedules")
      .insert(rows);

    if (insertErr) return res.status(500).json({ error: insertErr.message, result });

    // Update allocation status to confirmed
    const allocIds = result.assignments.map((a) => a.allocation_id);
    await supabase
      .from("production_allocations")
      .update({ status: "confirmed" })
      .in("id", allocIds);

    result.persisted = true;
  } else {
    result.persisted = false;
    result.dry_run = true;
  }

  res.json(result);
}));

// PATCH /api/lines/schedules/:id — update a schedule entry
router.patch("/schedules/:id", asyncHandler(async (req, res) => {
  const allowed = ["start_date", "end_date", "status", "seq"];
  const updates = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }

  const { data, error } = await supabase
    .from("line_schedules")
    .update(updates)
    .eq("id", req.params.id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
}));

export default router;
