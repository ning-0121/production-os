import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

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
router.post("/auto-schedule", asyncHandler(async (req, res) => {
  const { line_id, allocation_id, front_days } = req.body;
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

  // 2. Load allocation (get quantity)
  const { data: alloc, error: allocErr } = await supabase
    .from("production_allocations")
    .select("id, order_id, allocated_qty")
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

  res.status(201).json({
    scheduled: data,
    summary: {
      order_id: alloc.order_id,
      qty,
      line_name: line.name,
      front: { start: frontStart, end: frontEnd, days: Number(front_days) },
      back: { start: backStartStr, end: backEnd, days: backDays, capacity_per_day: backCapacity },
    },
  });
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
