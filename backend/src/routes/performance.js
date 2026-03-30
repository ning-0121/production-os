import { Router } from "express";
import { supabase } from "../supabase.js";

const router = Router();

// GET /api/performance — list recent performance logs
router.get("/", async (req, res) => {
  let query = supabase
    .from("factory_performance_logs")
    .select("*, factories(id, name, code)")
    .order("occurred_at", { ascending: false })
    .limit(Number(req.query.limit ?? 50));

  if (req.query.factory_id) {
    query = query.eq("factory_id", req.query.factory_id);
  }
  if (req.query.metric_type) {
    query = query.eq("metric_type", req.query.metric_type);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/performance/factory/:id/summary — calibration summary for a factory
router.get("/factory/:id/summary", async (req, res) => {
  // Get all order_completion logs for this factory
  const { data: logs, error } = await supabase
    .from("factory_performance_logs")
    .select("metric_value, context, occurred_at")
    .eq("factory_id", req.params.id)
    .eq("metric_type", "order_completion")
    .order("occurred_at", { ascending: false })
    .limit(20);

  if (error) return res.status(500).json({ error: error.message });
  if (!logs || logs.length === 0) {
    return res.json({ total_completions: 0, by_product_type: {} });
  }

  // Group by product_type
  const byProduct = {};
  for (const log of logs) {
    const pt = log.context?.product_type ?? "unknown";
    if (!byProduct[pt]) {
      byProduct[pt] = {
        completions: 0,
        avg_daily_output: 0,
        avg_delay_days: 0,
        avg_efficiency: 0,
        on_time_rate: 0,
        _sums: { output: 0, delay: 0, eff: 0, onTime: 0 },
      };
    }
    const b = byProduct[pt];
    b.completions++;
    b._sums.output += Number(log.metric_value ?? 0);
    b._sums.delay += Number(log.context?.delay_days ?? 0);
    b._sums.eff += Number(log.context?.efficiency_rate ?? 1);
    if (log.context?.on_time) b._sums.onTime++;
  }

  for (const [, b] of Object.entries(byProduct)) {
    const n = b.completions;
    b.avg_daily_output = Math.round((b._sums.output / n) * 100) / 100;
    b.avg_delay_days = Math.round((b._sums.delay / n) * 100) / 100;
    b.avg_efficiency = Math.round((b._sums.eff / n) * 1000) / 1000;
    b.on_time_rate = Math.round((b._sums.onTime / n) * 100) / 100;
    delete b._sums;
  }

  res.json({
    total_completions: logs.length,
    by_product_type: byProduct,
  });
});

export default router;
