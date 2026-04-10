/**
 * Override 统计 API — AI 推荐学习闭环
 */

import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

const router = Router();

// GET /api/overrides/stats — override 统计
router.get("/stats", asyncHandler(async (req, res) => {
  const period = req.query.period ?? "week"; // week or month
  const daysBack = period === "month" ? 30 : 7;
  const since = new Date(Date.now() - daysBack * 86400000).toISOString();

  const { data: overrides } = await supabase
    .from("scheduling_overrides")
    .select("*")
    .gte("overridden_at", since)
    .order("overridden_at", { ascending: false });

  const { data: allScenarios } = await supabase
    .from("order_scenarios")
    .select("status")
    .gte("created_at", since)
    .in("status", ["applied", "rejected"]);

  const total = overrides?.length ?? 0;
  const applied = (allScenarios ?? []).filter((s) => s.status === "applied").length;
  const totalDecisions = applied + total;

  // Top override types
  const typeCount = {};
  for (const o of overrides ?? []) {
    const t = o.override_type ?? "unknown";
    typeCount[t] = (typeCount[t] ?? 0) + 1;
  }

  // Top overridden scenario types
  const scenarioTypeCount = {};
  for (const o of overrides ?? []) {
    const t = o.original_scenario_type ?? "unknown";
    scenarioTypeCount[t] = (scenarioTypeCount[t] ?? 0) + 1;
  }

  const adoptionRate = totalDecisions > 0
    ? Math.round(((totalDecisions - total) / totalDecisions) * 100)
    : 100;

  res.json({
    period,
    since,
    total_overrides: total,
    total_decisions: totalDecisions,
    adoption_rate_pct: adoptionRate,
    override_types: typeCount,
    most_overridden_scenario: Object.entries(scenarioTypeCount)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => ({ type, count }))[0] ?? null,
    recent_overrides: (overrides ?? []).slice(0, 10),
  });
}));

export default router;
