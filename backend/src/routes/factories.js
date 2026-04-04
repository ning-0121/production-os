import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

const router = Router();

// GET /api/factories — list all factories with capabilities
router.get("/", asyncHandler(async (_req, res) => {
  const { data: factories, error } = await supabase
    .from("factories")
    .select("*, factory_capabilities(*)")
    .order("name");

  if (error) return res.status(500).json({ error: error.message });
  res.json(factories);
}));

// GET /api/factories/:id
router.get("/:id", asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from("factories")
    .select("*, factory_capabilities(*)")
    .eq("id", req.params.id)
    .single();

  if (error) return res.status(404).json({ error: error.message });
  res.json(data);
}));

// PATCH /api/factories/:id — update factory fields
router.patch("/:id", asyncHandler(async (req, res) => {
  const allowed = [
    "name", "code", "status", "address", "contact_name", "contact_phone",
    "timezone", "work_calendar", "ai_profile", "constraints", "metadata",
  ];
  const updates = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }

  const { data, error } = await supabase
    .from("factories")
    .update(updates)
    .eq("id", req.params.id)
    .select("*, factory_capabilities(*)")
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
}));

// PATCH /api/capabilities/:id — update a single capability row
router.patch("/capabilities/:id", asyncHandler(async (req, res) => {
  const allowed = [
    "base_capacity_units_per_day", "setup_minutes", "minutes_per_unit",
    "cost_per_unit", "quality_score", "features",
  ];
  const updates = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }

  const { data, error } = await supabase
    .from("factory_capabilities")
    .update(updates)
    .eq("id", req.params.id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
}));

export default router;
