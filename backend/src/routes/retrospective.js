/**
 * Retrospective Intelligence API — /api/retrospective/*
 *
 * Read-only management analytics over execution history. Every endpoint loads
 * the same aggregate once and returns a slice of it, so the contract is stable
 * and every field is zero-safe (no nulls, arrays always arrays).
 *
 * window query param: "7d" (default) or "30d" (any Nd up to 180).
 */

import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { loadRetrospective } from "../retrospective/io.js";

const router = Router();

// Full payload (everything) — handy for the dashboard's single fetch.
router.get("/summary", asyncHandler(async (req, res) => {
  const data = await loadRetrospective(supabase, { window: req.query.window });
  res.json(data);
}));

router.get("/root-causes", asyncHandler(async (req, res) => {
  const data = await loadRetrospective(supabase, { window: req.query.window });
  res.json({ window: data.window, root_causes: data.root_causes });
}));

router.get("/factories", asyncHandler(async (req, res) => {
  const data = await loadRetrospective(supabase, { window: req.query.window });
  res.json({ window: data.window, factories: data.factories, lines: data.lines });
}));

router.get("/owners", asyncHandler(async (req, res) => {
  const data = await loadRetrospective(supabase, { window: req.query.window });
  res.json({ window: data.window, owners: data.owners });
}));

router.get("/ai-effectiveness", asyncHandler(async (req, res) => {
  const data = await loadRetrospective(supabase, { window: req.query.window });
  res.json({ window: data.window, ai_effectiveness: data.ai_effectiveness, cron_health: data.cron_health });
}));

router.get("/trends", asyncHandler(async (req, res) => {
  const data = await loadRetrospective(supabase, { window: req.query.window });
  res.json({ window: data.window, trends: data.trends });
}));

router.get("/insights", asyncHandler(async (req, res) => {
  const data = await loadRetrospective(supabase, { window: req.query.window });
  res.json({ window: data.window, insights: data.insights });
}));

export default router;
