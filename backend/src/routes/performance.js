import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

const router = Router();

// GET /api/performance — list recent performance logs
router.get("/", asyncHandler(async (req, res) => {
  let query = supabase
    .from("factory_performance_logs")
    .select("*, factories(id, name)")
    .order("actual_end_date", { ascending: false })
    .limit(Number(req.query.limit ?? 50));

  if (req.query.factory_id) {
    query = query.eq("factory_id", req.query.factory_id);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
}));

// GET /api/performance/factory/:id/summary — calibration summary for a factory
router.get("/factory/:id/summary", asyncHandler(async (req, res) => {
  // Get all performance logs for this factory
  const { data: logs, error } = await supabase
    .from("factory_performance_logs")
    .select("order_id, delay_days, actual_daily_output, quality_issue_count, actual_start_date, actual_end_date, notes")
    .eq("factory_id", req.params.id)
    .order("actual_end_date", { ascending: false })
    .limit(20);

  if (error) return res.status(500).json({ error: error.message });
  if (!logs || logs.length === 0) {
    return res.json({ total_completions: 0, summary: {} });
  }

  let sumOutput = 0;
  let sumDelay = 0;
  let onTimeCount = 0;
  let sumQualityIssues = 0;

  for (const log of logs) {
    sumOutput += Number(log.actual_daily_output ?? 0);
    sumDelay += Number(log.delay_days ?? 0);
    sumQualityIssues += Number(log.quality_issue_count ?? 0);
    if ((log.delay_days ?? 0) <= 0) onTimeCount++;
  }

  const n = logs.length;

  res.json({
    total_completions: n,
    summary: {
      avg_daily_output: Math.round((sumOutput / n) * 100) / 100,
      avg_delay_days: Math.round((sumDelay / n) * 100) / 100,
      on_time_rate: Math.round((onTimeCount / n) * 100) / 100,
      total_quality_issues: sumQualityIssues,
    },
  });
}));

export default router;
