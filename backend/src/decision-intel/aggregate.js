/**
 * Decision Intelligence Aggregation — pure, deterministic, zero-safe.
 *
 * Turns decision history (assessments + logs + feedback + learning) into
 * management metrics: are AI recommendations trusted? which options work?
 * which recommendations get overridden? is the engine learning?
 *
 * Input is a bundle of raw rows (loaded once, parallel, by io.js). Output is
 * stable arrays + numbers with NO nulls — every metric defaults to 0 / [].
 *
 * Current vs previous window: the loader fetches 2×window of assessments/logs
 * so this module can compute week-over-week trends without a second query.
 */

const APPLIED_STATUSES = new Set(["applied", "partial"]);

/**
 * @param {object} bundle  { assessments, logs, feedback, learning }
 *   - assessments: decision_assessments rows (id, decision_type, recommended_option_id,
 *       confidence_score, options[], computed_at)
 *   - logs: decision_logs rows (decision_id, selected_option_id, action_status,
 *       override_reason, result_summary{option_type,...}, selected_at)
 *   - feedback: decision_option_feedback rows (decision_id, option_id, feedback_type, created_at)
 *   - learning: decision_learning rows
 * @param {object} opts { now: Date, windowDays: number }
 */
export function aggregate(bundle, opts = {}) {
  const now = opts.now ?? new Date();
  const windowDays = Number(opts.windowDays ?? 7);
  const winMs = windowDays * 86400000;
  const curStart = now.getTime() - winMs;
  const prevStart = now.getTime() - 2 * winMs;

  const allAssessments = arr(bundle.assessments);
  const allLogs = arr(bundle.logs);
  const feedback = arr(bundle.feedback);
  const learning = arr(bundle.learning);

  const inCur = (row, f) => { const t = ts(row?.[f]); return t != null && t >= curStart && t <= now.getTime(); };
  const inPrev = (row, f) => { const t = ts(row?.[f]); return t != null && t >= prevStart && t < curStart; };

  const assessments = allAssessments.filter((a) => inCur(a, "computed_at"));
  const logs = allLogs.filter((l) => inCur(l, "selected_at"));
  const prevLogs = allLogs.filter((l) => inPrev(l, "selected_at"));
  const prevAssessments = allAssessments.filter((a) => inPrev(a, "computed_at"));

  // Index recommended option id per assessment (for acceptance/override calc)
  const recById = new Map(allAssessments.map((a) => [a.id, a.recommended_option_id]));

  return {
    window: { days: windowDays, from: new Date(curStart).toISOString(), to: now.toISOString() },
    summary: buildSummary(assessments, logs, prevAssessments, prevLogs, feedback, recById),
    options: buildOptionRanking(logs, feedback),
    overrides: buildOverrides(logs, recById, allAssessments),
    learning: buildLearning(learning),
    feedback: buildFeedback(feedback, assessments, logs),
    trends: buildTrends(allAssessments, allLogs, now, windowDays, recById),
  };
}

// ── Summary ─────────────────────────────────────────────

function buildSummary(assessments, logs, prevAssessments, prevLogs, feedback, recById) {
  const evaluated = assessments.length;
  const applied = logs.filter((l) => APPLIED_STATUSES.has(l.action_status)).length;
  const failed = logs.filter((l) => l.action_status === "failed").length;
  const dismissed = logs.filter((l) => l.action_status === "dismissed").length;

  // acceptance = selected option == recommended option
  const decided = logs.filter((l) => recById.has(l.decision_id));
  const accepted = decided.filter((l) => l.selected_option_id === recById.get(l.decision_id)).length;
  const overridden = decided.filter((l) => l.selected_option_id !== recById.get(l.decision_id)).length;

  // executed = applied + failed (decisions that actually ran)
  const executed = applied + failed;

  // avg confidence over assessments
  const confs = assessments.map((a) => num(a.confidence_score)).filter((c) => c > 0);

  // previous-window acceptance for trend
  const prevDecided = prevLogs.filter((l) => l.decision_id != null);
  // (prev acceptance needs recById too — reuse the same map which spans both windows)
  const prevAccepted = prevDecided.filter((l) => l.selected_option_id === recByIdLookup(l, prevAssessments)).length;
  const prevAcceptanceRate = pct(prevAccepted, prevDecided.length);

  const acceptanceRate = pct(accepted, decided.length);

  return {
    decisions_evaluated: evaluated,
    decisions_applied: applied,
    total_selected: logs.length,
    recommendation_acceptance_rate: acceptanceRate,
    override_rate: pct(overridden, decided.length),
    apply_success_rate: pct(applied, executed),
    failed_rate: pct(failed, logs.length),
    dismissed_count: dismissed,
    avg_confidence: confs.length ? round2(confs.reduce((s, c) => s + c, 0) / confs.length) : 0,
    prev_decisions_evaluated: prevAssessments.length,
    acceptance_trend: trendDir(acceptanceRate, prevAcceptanceRate),
    prev_acceptance_rate: prevAcceptanceRate,
  };
}

function recByIdLookup(log, assessments) {
  const a = assessments.find((x) => x.id === log.decision_id);
  return a?.recommended_option_id ?? null;
}

// ── Option ranking ──────────────────────────────────────

function buildOptionRanking(logs, feedback) {
  const map = new Map();
  const ensure = (ot) => {
    if (!map.has(ot)) map.set(ot, { option_type: ot, selected: 0, applied: 0, failed: 0, dismissed: 0, helpful: 0, not_helpful: 0 });
    return map.get(ot);
  };
  for (const l of logs) {
    const ot = l.result_summary?.option_type ?? optTypeFromId(l.selected_option_id);
    if (!ot) continue;
    const row = ensure(ot);
    row.selected++;
    if (APPLIED_STATUSES.has(l.action_status)) row.applied++;
    else if (l.action_status === "failed") row.failed++;
    else if (l.action_status === "dismissed") row.dismissed++;
  }
  for (const f of feedback) {
    const ot = optTypeFromId(f.option_id);
    if (!ot || !map.has(ot)) continue;
    const row = map.get(ot);
    if (f.feedback_type === "helpful") row.helpful++;
    else if (f.feedback_type === "not_helpful" || f.feedback_type === "wrong_recommendation") row.not_helpful++;
  }
  return [...map.values()]
    .map((r) => ({
      ...r,
      success_rate: pct(r.applied, r.applied + r.failed),
      feedback_score: pct(r.helpful, r.helpful + r.not_helpful),
    }))
    .sort((a, b) => b.selected - a.selected);
}

// ── Overrides ───────────────────────────────────────────

function buildOverrides(logs, recById, allAssessments) {
  // recommended option_type per assessment id
  const recTypeById = new Map();
  for (const a of allAssessments) {
    const recOpt = (a.options ?? []).find((o) => o.id === a.recommended_option_id);
    if (recOpt) recTypeById.set(a.id, recOpt.option_type);
  }
  const counts = new Map();   // recommended option_type → { recommended, overridden }
  for (const l of logs) {
    const recId = recById.get(l.decision_id);
    const recType = recTypeById.get(l.decision_id);
    if (!recType) continue;
    if (!counts.has(recType)) counts.set(recType, { option_type: recType, recommended: 0, overridden: 0 });
    const c = counts.get(recType);
    c.recommended++;
    if (recId && l.selected_option_id !== recId) c.overridden++;
  }
  return [...counts.values()]
    .map((c) => ({ ...c, override_rate: pct(c.overridden, c.recommended) }))
    .sort((a, b) => b.override_rate - a.override_rate || b.overridden - a.overridden);
}

// ── Learning ────────────────────────────────────────────

function buildLearning(learning) {
  const rows = learning.map((r) => ({
    decision_type: r.decision_type,
    option_type: r.option_type,
    adjustment: num(r.adjustment),
    sample_size: num(r.sample_size),
    effectiveness: num(r.effectiveness),
    reason: r.reason ?? null,
  }));
  const positives = rows.filter((r) => r.adjustment > 0).sort((a, b) => b.adjustment - a.adjustment);
  const negatives = rows.filter((r) => r.adjustment < 0).sort((a, b) => a.adjustment - b.adjustment);
  return {
    all: rows.sort((a, b) => Math.abs(b.adjustment) - Math.abs(a.adjustment)),
    top_positive: positives.slice(0, 8),
    top_negative: negatives.slice(0, 8),
    learned_count: rows.filter((r) => r.adjustment !== 0).length,
  };
}

// ── Feedback ────────────────────────────────────────────

function buildFeedback(feedback, assessments, logs) {
  const counts = { helpful: 0, not_helpful: 0, wrong_recommendation: 0, missing_option: 0, inaccurate_impact: 0 };
  for (const f of feedback) {
    if (counts[f.feedback_type] != null) counts[f.feedback_type]++;
  }
  const totalFeedback = Object.values(counts).reduce((s, c) => s + c, 0);
  // "no feedback" = applied/selected decisions without any feedback row
  const decidedWithFeedback = new Set(feedback.map((f) => f.decision_id));
  const noFeedback = logs.filter((l) => !decidedWithFeedback.has(l.decision_id)).length;
  return {
    ...counts,
    total_feedback: totalFeedback,
    no_feedback: noFeedback,
    helpful_rate: pct(counts.helpful, totalFeedback),
  };
}

// ── Trends (daily buckets) ──────────────────────────────

function buildTrends(allAssessments, allLogs, now, windowDays, recById) {
  const days = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    days.push({ date: new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10), evaluated: 0, applied: 0, accepted: 0, overridden: 0, decided: 0 });
  }
  const idx = new Map(days.map((d, i) => [d.date, i]));
  for (const a of allAssessments) {
    const k = (a.computed_at ?? "").slice(0, 10);
    const i = idx.get(k);
    if (i != null) days[i].evaluated++;
  }
  for (const l of allLogs) {
    const k = (l.selected_at ?? "").slice(0, 10);
    const i = idx.get(k);
    if (i == null) continue;
    if (APPLIED_STATUSES.has(l.action_status)) days[i].applied++;
    const recId = recById.get(l.decision_id);
    if (recId != null) {
      days[i].decided++;
      if (l.selected_option_id === recId) days[i].accepted++;
      else days[i].overridden++;
    }
  }
  // Add per-day acceptance/success rates (zero-safe)
  const withRates = days.map((d) => ({
    ...d,
    acceptance_rate: pct(d.accepted, d.decided),
    override_rate: pct(d.overridden, d.decided),
  }));
  return { days: withRates };
}

// ── Helpers (zero-safe) ─────────────────────────────────

function arr(x) { return Array.isArray(x) ? x : []; }
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }
function ts(d) { if (!d) return null; const t = new Date(d).getTime(); return Number.isFinite(t) ? t : null; }
function pct(n, d) { return d > 0 ? Math.round((n / d) * 1000) / 10 : 0; }
function round2(x) { return Math.round(x * 100) / 100; }
function trendDir(cur, prev) {
  if (prev === 0) return cur > 0 ? "up" : "flat";
  const change = (cur - prev) / prev;
  if (change > 0.05) return "up";
  if (change < -0.05) return "down";
  return "flat";
}
// Option ids: opt_{option_type}_{slug}; option_type may contain underscores.
const KNOWN_OPTION_TYPES = [
  "create_rework_plan", "expedite_material", "substitute_material",
  "reassign_factory", "reassign_line", "delay_customer", "partial_start",
  "add_qc_check", "split_order", "keep_current", "overtime",
].sort((a, b) => b.length - a.length);
function optTypeFromId(id) {
  if (!id) return null;
  const body = String(id).replace(/^opt_/, "");
  return KNOWN_OPTION_TYPES.find((t) => body === t || body.startsWith(t + "_")) ?? null;
}
