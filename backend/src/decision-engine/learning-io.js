/**
 * Decision Learning I/O — recompute the cached effectiveness table from history,
 * and load it for evaluate-time scoring.
 *
 * Mirrors the escalation-sweep pattern: a (cron-callable) recompute aggregates
 * decision_logs + decision_option_feedback into decision_learning; evaluate
 * reads that small table (fast, no N+1).
 */

import { computeEffectiveness, buildAdjustmentMap } from "./learning.js";

/**
 * Recompute learning rows from history and upsert into decision_learning.
 * Idempotent + safe to re-run.
 * @returns {{ updated: number, rows: Array }}
 */
export async function recomputeLearning(supabase, opts = {}) {
  // Join logs → assessment to get decision_type + option_type. We pull the
  // assessment fields we need; option_type comes from result_summary.
  const [logsRes, fbRes] = await Promise.all([
    supabase
      .from("decision_logs")
      .select("decision_id, selected_option_id, action_status, override_reason, result_summary, decision_assessments(decision_type)")
      .limit(10000),
    supabase
      .from("decision_option_feedback")
      .select("decision_id, option_id, feedback_type, decision_assessments(decision_type)")
      .limit(10000),
  ]);
  if (logsRes.error) throw logsRes.error;
  if (fbRes.error) throw fbRes.error;

  // Normalize join shape → flat rows the pure module expects.
  const logs = (logsRes.data ?? []).map((l) => ({
    decision_type: l.decision_assessments?.decision_type ?? "unknown",
    option_type: l.result_summary?.option_type ?? optionTypeFromId(l.selected_option_id),
    action_status: l.action_status,
    override_reason: l.override_reason,
    result_summary: l.result_summary,
  }));
  const feedback = (fbRes.data ?? []).map((f) => ({
    decision_type: f.decision_assessments?.decision_type ?? "unknown",
    option_type: optionTypeFromId(f.option_id),
    feedback_type: f.feedback_type,
  }));

  const rows = computeEffectiveness(logs, feedback);

  // Upsert each row
  let updated = 0;
  for (const r of rows) {
    const { error } = await supabase.from("decision_learning").upsert({
      decision_type: r.decision_type,
      option_type: r.option_type,
      selected_count: r.selected_count,
      applied_count: r.applied_count,
      failed_count: r.failed_count,
      dismissed_count: r.dismissed_count,
      helpful_count: r.helpful_count,
      not_helpful_count: r.not_helpful_count,
      override_in_count: r.override_in_count,
      override_out_count: r.override_out_count,
      exec_success_rate: r.exec_success_rate,
      feedback_ratio: r.feedback_ratio,
      effectiveness: r.effectiveness,
      sample_size: r.sample_size,
      adjustment: r.adjustment,
      reason: r.reason,
      recomputed_at: (opts.now ?? new Date()).toISOString(),
    }, { onConflict: "decision_type,option_type" });
    if (!error) updated++;
    else console.error("[learning] upsert failed:", error.message);
  }

  return { updated, rows };
}

/**
 * Load the current learned-adjustment map for evaluate-time scoring.
 * Returns null if learning is disabled or the table is unavailable (→ pure base).
 */
export async function loadAdjustmentMap(supabase) {
  if (process.env.DECISION_LEARNING_DISABLED === "true") return null;
  const { data, error } = await supabase.from("decision_learning").select("*");
  if (error) {
    console.error(JSON.stringify({ level: "WARN", source: "decision-learning", error: error.message }));
    return null;
  }
  return buildAdjustmentMap(data ?? []);
}

/** List learning rows for inspection (GET endpoint). */
export async function listLearning(supabase) {
  const { data, error } = await supabase
    .from("decision_learning")
    .select("*")
    .order("decision_type", { ascending: true })
    .order("adjustment", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

// Option ids are `opt_{option_type}_{slug}` (see options.js). option_type can
// itself contain underscores, so match against the known set (longest first).
const KNOWN_OPTION_TYPES = [
  "create_rework_plan", "expedite_material", "substitute_material",
  "reassign_factory", "reassign_line", "delay_customer", "partial_start",
  "add_qc_check", "split_order", "keep_current", "overtime",
].sort((a, b) => b.length - a.length);

function optionTypeFromId(id) {
  if (!id) return null;
  const body = String(id).replace(/^opt_/, "");
  return KNOWN_OPTION_TYPES.find((t) => body === t || body.startsWith(t + "_")) ?? null;
}
