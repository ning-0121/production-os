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
    "name", "status", "location", "lat", "lng",
    "cooperation_score", "quality_score", "delay_score",
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
    "daily_capacity", "efficiency_rate", "overtime_factor", "product_type",
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
