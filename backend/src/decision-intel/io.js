/**
 * Decision Intelligence I/O — load the 4 decision tables ONCE in parallel
 * (no N+1), hand to the pure aggregator + insights.
 *
 * Loads 2×window of assessments + logs so the aggregator can compute
 * week-over-week trends without a second round trip. Feedback + learning are
 * small, loaded whole. Tolerates a missing table (returns []).
 */

import { aggregate } from "./aggregate.js";
import { generateInsights } from "./insights.js";

export function parseWindow(windowStr) {
  const m = String(windowStr ?? "7d").match(/^(\d+)d$/);
  return m ? Math.min(180, Math.max(1, Number(m[1]))) : 7;
}

export async function loadIntelligence(supabase, opts = {}) {
  const windowDays = parseWindow(opts.window);
  const now = opts.now ?? new Date();
  const sinceIso = new Date(now.getTime() - 2 * windowDays * 86400000).toISOString();

  const [assessRes, logsRes, fbRes, learnRes] = await Promise.all([
    supabase.from("decision_assessments")
      .select("id, decision_type, recommended_option_id, confidence_score, options, computed_at")
      .gte("computed_at", sinceIso),
    supabase.from("decision_logs")
      .select("decision_id, selected_option_id, action_status, override_reason, result_summary, selected_at")
      .gte("selected_at", sinceIso),
    supabase.from("decision_option_feedback")
      .select("decision_id, option_id, feedback_type, created_at")
      .gte("created_at", sinceIso),
    supabase.from("decision_learning").select("*"),
  ]);

  const bundle = {
    assessments: safe("decision_assessments", assessRes),
    logs: safe("decision_logs", logsRes),
    feedback: safe("decision_option_feedback", fbRes),
    learning: safe("decision_learning", learnRes),
  };

  const agg = aggregate(bundle, { now, windowDays });
  const insights = generateInsights(agg);
  return { ...agg, insights };
}

function safe(name, res) {
  if (res?.error) {
    console.error(JSON.stringify({ level: "WARN", source: "decision-intel", table: name, error: res.error.message }));
    return [];
  }
  return res?.data ?? [];
}
