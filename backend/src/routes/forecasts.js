import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { runDailyForecast, forecastBottlenecks } from "../agents/forecaster.js";

const router = Router();

router.get("/", asyncHandler(async (req, res) => {
  const type = req.query.type;
  const horizon = Number(req.query.horizon ?? 14);

  let query = supabase.from("forecasts").select("*")
    .order("computed_at", { ascending: false }).limit(100);

  if (type) query = query.eq("forecast_type", type);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
}));

router.post("/run", asyncHandler(async (_req, res) => {
  const result = await runDailyForecast(supabase);
  res.json(result);
}));

router.get("/bottlenecks", asyncHandler(async (req, res) => {
  const horizon = Number(req.query.horizon ?? 14);
  const bottlenecks = await forecastBottlenecks(supabase, horizon);
  res.json(bottlenecks);
}));

export default router;
