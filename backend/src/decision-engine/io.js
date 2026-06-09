/**
 * Decision Engine I/O — build context from the existing engines, run the pure
 * assembler, and (optionally) persist the assessment.
 *
 * Reads only — generating a decision NEVER mutates production state. The only
 * write here is inserting the read-only decision_assessments artifact.
 *
 * Consumes: risk-engine, order_corrections, production_runtime_lines,
 * runtime_events, incidents, qc_inspections, rework_orders, order_financials,
 * material_requirements, factories.
 */

import { assembleDecision, DECISION_TYPES } from "./index.js";
import { assessById } from "../risk-engine/io.js";
import { loadAdjustmentMap } from "./learning-io.js";

/**
 * Infer the decision_type for a subject when the caller didn't specify one.
 * Deterministic priority: disruption > material > qc > delay > vip.
 */
export function inferDecisionType(signals) {
  if (signals.runtime_status === "down" || signals.runtime_status === "blocked" || signals.factory_shutdown) return "line_disruption_resolution";
  if (signals.material_shortage_count > 0 || signals.material_eta_days > 0) return "material_shortage_resolution";
  if (signals.qc_failed || signals.rework_qty > 0) return "qc_rework_resolution";
  if (signals.is_vip) return "vip_insertion";
  return "delay_resolution";
}

/**
 * Build a decision for a subject. Loads context, assembles, persists if opts.persist.
 * @param {object} supabase
 * @param {{ type: string, id: string }} subject
 * @param {object} [opts] { decision_type?, context?, persist?, now?, createdBy? }
 */
export async function evaluateDecision(supabase, subject, opts = {}) {
  const ctx = await buildContext(supabase, subject, opts);
  // Load the bounded learned-adjustment map (organizational memory). Null when
  // learning disabled / unavailable → pure deterministic scoring.
  const adjustmentMap = await loadAdjustmentMap(supabase);
  const assessment = assembleDecision(ctx, { now: opts.now, adjustmentMap });

  if (opts.persist) {
    const { data, error } = await supabase.from("decision_assessments").insert({
      subject_type: assessment.subject.type,
      subject_id: assessment.subject.id,
      decision_type: assessment.decision_type,
      urgency: assessment.urgency,
      current_state: assessment.current_state,
      options: assessment.options,
      recommended_option_id: assessment.recommended_option_id,
      recommendation_reason: assessment.recommendation_reason,
      confidence_score: assessment.confidence_score,
      if_no_action: assessment.if_no_action,
      created_by: opts.createdBy ?? "system",
    }).select("id, computed_at").single();
    if (error) throw error;
    assessment.id = data.id;
    assessment.computed_at = data.computed_at;
  }

  return assessment;
}

/**
 * Gather all signals for a subject into the normalized context the pure
 * engine expects. One parallel load per source — no N+1.
 */
export async function buildContext(supabase, subject, opts = {}) {
  const overrideCtx = opts.context ?? {};

  // Risk assessment (canonical) — tolerate failure.
  let risk = null;
  try { risk = await assessById(supabase, subject.type === "incident" ? "factory" : subject.type, subject.id); }
  catch { risk = null; }

  // Resolve allocation/order linkage + financials + corrections + runtime in parallel.
  const [corrRes, runtimeRes, qcRes, reworkRes, finRes, matReqRes, factoriesRes, linesRes] = await Promise.all([
    subject.type === "allocation"
      ? supabase.from("order_corrections").select("deviation_pct, estimated_end_date, risk_status, factory_id, order_id").eq("allocation_id", subject.id).order("computed_at", { ascending: false }).limit(1)
      : subject.type === "order"
      ? supabase.from("order_corrections").select("deviation_pct, estimated_end_date, risk_status, factory_id, order_id, allocation_id").eq("order_id", subject.id).order("computed_at", { ascending: false }).limit(1)
      : Promise.resolve({ data: [] }),
    subject.type === "line"
      ? supabase.from("production_runtime_lines").select("runtime_status, overload_pct, current_efficiency, factory_id").eq("line_id", subject.id).maybeSingle()
      : subject.type === "allocation"
      ? supabase.from("production_runtime_lines").select("runtime_status, overload_pct, current_efficiency, factory_id").eq("current_allocation_id", subject.id).maybeSingle()
      : Promise.resolve({ data: null }),
    (subject.type === "order")
      ? supabase.from("qc_inspections").select("result, defect_rate_pct, total_qty_inspected, total_defects").eq("order_id", subject.id).order("created_at", { ascending: false }).limit(1)
      : Promise.resolve({ data: [] }),
    (subject.type === "order")
      ? supabase.from("rework_orders").select("rework_qty, status").eq("order_id", subject.id).in("status", ["pending", "in_progress"])
      : Promise.resolve({ data: [] }),
    (subject.type === "order")
      ? supabase.from("order_financials").select("revenue, gross_margin_pct").eq("order_id", subject.id).maybeSingle()
      : Promise.resolve({ data: null }),
    (subject.type === "order")
      ? supabase.from("material_requirements").select("qty_required, qty_available, is_critical").eq("order_id", subject.id)
      : Promise.resolve({ data: [] }),
    supabase.from("factories").select("id, name, status, quality_score, delay_score").eq("status", "active"),
    supabase.from("production_lines").select("id, name, factory_id, status").eq("status", "active"),
  ]);

  const corr = (corrRes.data ?? [])[0] ?? null;
  const runtime = runtimeRes.data ?? null;
  const qc = (qcRes.data ?? [])[0] ?? null;
  const reworks = reworkRes.data ?? [];
  const fin = finRes.data ?? null;
  const matReqs = matReqRes.data ?? [];
  const factories = factoriesRes.data ?? [];
  const lines = linesRes.data ?? [];

  // Derive delay
  const deviationPct = num(corr?.deviation_pct);
  let expectedDelay = num(overrideCtx.expected_delay_days);
  if (!expectedDelay && corr?.estimated_end_date) {
    const est = new Date(corr.estimated_end_date).getTime();
    // crude: deviation% → days proxy when no explicit end available
    expectedDelay = deviationPct < 0 ? Math.ceil(Math.abs(deviationPct) / 5) : 0;
  }
  if (!expectedDelay && runtime?.runtime_status === "blocked") expectedDelay = 3;
  if (!expectedDelay && runtime?.runtime_status === "down") expectedDelay = 5;

  // Material
  const shortages = matReqs.filter((m) => num(m.qty_available) < num(m.qty_required));
  const materialEtaDays = shortages.length ? 4 : num(overrideCtx.material_eta_days);

  // QC
  const qcFailed = qc?.result === "fail" || overrideCtx.qc_failed === true;
  const reworkQty = reworks.reduce((s, r) => s + num(r.rework_qty), 0) || num(overrideCtx.rework_qty);

  // Alternative factories/lines (exclude current; rank by score)
  const currentFactoryId = corr?.factory_id ?? runtime?.factory_id ?? null;
  const altFactories = factories
    .filter((f) => f.id !== currentFactoryId)
    .sort((a, b) => (num(b.delay_score) + num(b.quality_score)) - (num(a.delay_score) + num(a.quality_score)))
    .slice(0, 3)
    .map((f) => ({ id: f.id, name: f.name, score: Math.round((num(f.delay_score) + num(f.quality_score)) / 2), affected_orders: [] }));
  const altLines = lines
    .filter((l) => l.factory_id === currentFactoryId)
    .slice(0, 3)
    .map((l) => ({ id: l.id, name: l.name, affected_orders: [] }));

  // Signals → decision_type
  const signals = {
    runtime_status: runtime?.runtime_status,
    material_shortage_count: shortages.length,
    material_eta_days: materialEtaDays,
    qc_failed: qcFailed,
    rework_qty: reworkQty,
    is_vip: overrideCtx.is_vip === true,
    factory_shutdown: runtime?.runtime_status === "down",
  };
  const decisionType = opts.decision_type ?? overrideCtx.decision_type ?? inferDecisionType(signals);

  const revenue = num(fin?.revenue, num(overrideCtx.order_revenue, 50000));
  const marginPct = num(fin?.gross_margin_pct, num(overrideCtx.gross_margin_pct, 15));
  const estMarginImpact = Math.round(revenue * (marginPct / 100) * Math.min(1, expectedDelay * 0.03));

  return {
    subject,
    decision_type: DECISION_TYPES.includes(decisionType) ? decisionType : "delay_resolution",
    urgency: overrideCtx.urgency ?? risk?.level === "critical" ? "critical" : risk?.level === "warn" ? "high" : "medium",
    risk_score: num(risk?.score),
    expected_delay_days: expectedDelay,
    deviation_pct: deviationPct,
    qty: num(overrideCtx.qty, 1000),
    order_revenue: revenue,
    gross_margin_pct: marginPct,
    estimated_margin_impact: estMarginImpact,
    affected_orders: overrideCtx.affected_orders ?? (corr?.order_id ? [corr.order_id] : []),
    affected_lines: overrideCtx.affected_lines ?? (subject.type === "line" ? [subject.id] : []),
    affected_factories: overrideCtx.affected_factories ?? (currentFactoryId ? [currentFactoryId] : []),
    runtime_status: runtime?.runtime_status,
    overload_pct: num(runtime?.overload_pct),
    current_efficiency: num(runtime?.current_efficiency, 1),
    material_shortage_count: shortages.length,
    material_eta_days: materialEtaDays,
    has_substitute: overrideCtx.has_substitute ?? shortages.some((m) => !m.is_critical),
    partial_available: overrideCtx.partial_available ?? matReqs.some((m) => num(m.qty_available) > 0),
    qc_failed: qcFailed,
    defect_rate_pct: num(qc?.defect_rate_pct, 10),
    rework_qty: reworkQty,
    alternative_factories: altFactories,
    alternative_lines: altLines,
    ...stripContextOnly(overrideCtx),
  };
}

/** Load a stored assessment by id (for the apply flow + history detail). */
export async function getAssessment(supabase, id) {
  const { data, error } = await supabase.from("decision_assessments").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}

function stripContextOnly(c) {
  // allow callers to inject summary etc. but not clobber subject/decision_type
  const { subject: _s, decision_type: _d, ...rest } = c ?? {};
  return rest;
}
function num(x, fallback = 0) { const n = Number(x); return Number.isFinite(n) ? n : fallback; }
