import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { getMemoryProfile, refreshAllMemory } from "../agents/memory.js";

const router = Router();

router.get("/:entityType/:entityId", asyncHandler(async (req, res) => {
  const profile = await getMemoryProfile(supabase, req.params.entityType, req.params.entityId);
  res.json(profile);
}));

router.post("/refresh", asyncHandler(async (_req, res) => {
  const result = await refreshAllMemory(supabase);
  res.json(result);
}));

export default router;
