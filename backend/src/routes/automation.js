import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { runAutomationScan, getBuiltinRules } from "../agents/automator.js";

const router = Router();

// POST /api/automation/scan — run rule engine evaluation
router.post("/scan", asyncHandler(async (_req, res) => {
  const result = await runAutomationScan(supabase);
  res.json(result);
}));

// GET /api/automation/rules — list all rules (builtin + custom)
router.get("/rules", asyncHandler(async (_req, res) => {
  const builtin = getBuiltinRules();
  const { data: custom } = await supabase.from("automation_rules").select("*").order("priority", { ascending: false });
  res.json({
    builtin,
    custom: (custom ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      priority: r.priority,
      trigger_type: r.trigger_type,
      conditions: r.condition_json,
      actions: r.actions_json,
      enabled: r.enabled,
      source: "custom",
    })),
  });
}));

// POST /api/automation/rules — create custom rule
router.post("/rules", asyncHandler(async (req, res) => {
  const { name, trigger_type, condition_json, actions_json, priority, enabled } = req.body;
  if (!name || !trigger_type) return res.status(400).json({ error: "name, trigger_type required" });

  const { data, error } = await supabase.from("automation_rules").insert({
    name,
    trigger_type,
    condition_json: condition_json ?? {},
    actions_json: actions_json ?? [],
    priority: priority ?? 50,
    enabled: enabled !== false,
  }).select().single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
}));

// PATCH /api/automation/rules/:id — update custom rule
router.patch("/rules/:id", asyncHandler(async (req, res) => {
  const allowed = ["name", "trigger_type", "condition_json", "actions_json", "priority", "enabled"];
  const updates = {};
  for (const k of allowed) { if (req.body[k] !== undefined) updates[k] = req.body[k]; }

  const { data, error } = await supabase.from("automation_rules").update(updates).eq("id", req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
}));

// GET /api/automation/logs — execution history
router.get("/logs", asyncHandler(async (_req, res) => {
  const { data, error } = await supabase.from("automation_logs").select("*").order("executed_at", { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
}));

// GET /api/automation/watchlist
router.get("/watchlist", asyncHandler(async (req, res) => {
  const status = req.query.status ?? "active";
  let query = supabase.from("watchlist").select("*").order("added_at", { ascending: false });
  if (status !== "all") query = query.eq("status", status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
}));

// POST /api/automation/watchlist
router.post("/watchlist", asyncHandler(async (req, res) => {
  const { entity_type, entity_id, reason, escalation_hours } = req.body;
  if (!entity_type || !entity_id || !reason) return res.status(400).json({ error: "entity_type, entity_id, reason required" });
  const deadline = escalation_hours ? new Date(Date.now() + Number(escalation_hours) * 3600000).toISOString() : null;

  const { data, error } = await supabase.from("watchlist").upsert({
    entity_type, entity_id, reason,
    added_by: req.pilotIdentity?.operator ?? "system",
    escalation_deadline: deadline,
    status: "active",
  }, { onConflict: "entity_type,entity_id,status" }).select().single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
}));

export default router;
