import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { runAutomationScan } from "../agents/automator.js";

const router = Router();

router.post("/scan", asyncHandler(async (_req, res) => {
  const result = await runAutomationScan(supabase);
  res.json(result);
}));

router.get("/logs", asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from("automation_logs")
    .select("*")
    .order("executed_at", { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
}));

router.get("/watchlist", asyncHandler(async (req, res) => {
  const status = req.query.status ?? "active";
  let query = supabase.from("watchlist").select("*").order("added_at", { ascending: false });
  if (status !== "all") query = query.eq("status", status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
}));

router.post("/watchlist", asyncHandler(async (req, res) => {
  const { entity_type, entity_id, reason, escalation_hours } = req.body;
  if (!entity_type || !entity_id || !reason) {
    return res.status(400).json({ error: "entity_type, entity_id, reason required" });
  }
  const deadline = escalation_hours
    ? new Date(Date.now() + Number(escalation_hours) * 3600000).toISOString()
    : null;

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
