/**
 * Risk Engine I/O — gather signals from Supabase + call pure assessor.
 *
 * This is the ONLY file in the risk-engine that touches the database. All
 * scoring logic lives in pure modules (rules.js, index.js).
 *
 * Performance note: a single order assessment fans out to ~5 reads. Routes
 * needing many assessments (today briefing, war room KPI) should call
 * `assessOrderBatch()` / `assessLineBatch()` to amortize.
 */

import {
  assess, assessOrder, assessAllocation, assessLine, assessFactory, assessCustomer,
} from "./index.js";

const ANOMALY_LOOKBACK_HOURS = 24;
const REWORK_ACTIVE_STATUSES = ["pending", "in_progress"];

// ════════════════════════════════════════════════════════════
// Per-subject (single)
// ════════════════════════════════════════════════════════════

export async function assessOrderById(supabase, orderId) {
  const signals = await gatherOrderSignals(supabase, orderId);
  return assessOrder({ id: orderId }, signals);
}

export async function assessAllocationById(supabase, allocationId) {
  const signals = await gatherAllocationSignals(supabase, allocationId);
  return assessAllocation({ id: allocationId }, signals);
}

export async function assessLineById(supabase, lineId) {
  const signals = await gatherLineSignals(supabase, lineId);
  return assessLine({ id: lineId }, signals);
}

export async function assessFactoryById(supabase, factoryId) {
  const signals = await gatherFactorySignals(supabase, factoryId);
  return assessFactory({ id: factoryId }, signals);
}

export async function assessCustomerById(supabase, customerId) {
  const signals = await gatherCustomerSignals(supabase, customerId);
  return assessCustomer({ id: customerId }, signals);
}

/** Generic dispatcher for the HTTP route. */
export async function assessById(supabase, subjectType, subjectId) {
  switch (subjectType) {
    case "order":      return assessOrderById(supabase, subjectId);
    case "allocation": return assessAllocationById(supabase, subjectId);
    case "line":       return assessLineById(supabase, subjectId);
    case "factory":    return assessFactoryById(supabase, subjectId);
    case "customer":   return assessCustomerById(supabase, subjectId);
    default: throw new Error(`Unsupported subject_type: ${subjectType}`);
  }
}

// ════════════════════════════════════════════════════════════
// Batch — amortize reads across many subjects of the same type
// ════════════════════════════════════════════════════════════

export async function assessAllocationBatch(supabase, allocationIds) {
  if (!allocationIds?.length) return [];
  const all = await gatherAllocationSignalsBatch(supabase, allocationIds);
  return allocationIds.map((id) => {
    const s = all.get(id) ?? {};
    return assessAllocation({ id }, s);
  });
}

export async function assessLineBatch(supabase, lineIds) {
  if (!lineIds?.length) return [];
  const all = await gatherLineSignalsBatch(supabase, lineIds);
  return lineIds.map((id) => assessLine({ id }, all.get(id) ?? {}));
}

// ════════════════════════════════════════════════════════════
// Signal gatherers
// ════════════════════════════════════════════════════════════

async function gatherOrderSignals(supabase, orderId) {
  const [orderRes, corrRes, qcRes, reworkRes, allocRes, anomalyRes] = await Promise.all([
    supabase.from("orders").select("id, order_number, due_date, customer_id, customers(risk_level)")
      .eq("id", orderId).maybeSingle(),
    supabase.from("order_corrections").select("deviation_pct, risk_status")
      .eq("order_id", orderId).order("date", { ascending: false }).limit(1),
    supabase.from("qc_inspections").select("result, inspected_at")
      .eq("order_id", orderId).gte("inspected_at", isoDaysAgo(30)),
    supabase.from("rework_orders").select("id, status")
      .eq("order_id", orderId).in("status", REWORK_ACTIVE_STATUSES),
    supabase.from("production_allocations").select("factory_id, planned_end_date")
      .eq("order_id", orderId),
    supabase.from("runtime_events").select("severity")
      .eq("order_id", orderId).gte("occurred_at", isoHoursAgo(ANOMALY_LOOKBACK_HOURS)),
  ]);

  const order = orderRes.data ?? null;
  const correction = corrRes.data?.[0] ?? null;
  const qcs = qcRes.data ?? [];
  const reworks = reworkRes.data ?? [];
  const allocations = allocRes.data ?? [];
  const anomalies = anomalyRes.data ?? [];

  return {
    buffer_days: order?.due_date ? daysBetween(new Date(), new Date(order.due_date)) : null,
    deviation_pct: correction?.deviation_pct ?? null,
    qc_failure_count: qcs.filter((q) => q.result === "fail").length,
    active_rework_count: reworks.length,
    material_shortage_count: null,                  // future: join material_requirements
    runtime_risk: null,                             // future: aggregate from allocations' runtime_lines
    customer_risk_level: order?.customers?.risk_level ?? null,
    recent_anomalies: anomalies,
  };
}

async function gatherAllocationSignals(supabase, allocationId) {
  const [allocRes, corrRes, runtimeRes, anomalyRes] = await Promise.all([
    supabase.from("production_allocations").select("id, order_id, factory_id, planned_end_date")
      .eq("id", allocationId).maybeSingle(),
    supabase.from("order_corrections").select("deviation_pct")
      .eq("allocation_id", allocationId).order("date", { ascending: false }).limit(1),
    // Find the runtime_line currently running this allocation
    supabase.from("production_runtime_lines")
      .select("runtime_status, overload_pct, current_efficiency")
      .eq("current_allocation_id", allocationId).maybeSingle(),
    supabase.from("runtime_events").select("severity")
      .eq("allocation_id", allocationId).gte("occurred_at", isoHoursAgo(ANOMALY_LOOKBACK_HOURS)),
  ]);

  const alloc = allocRes.data ?? null;
  const correction = corrRes.data?.[0] ?? null;
  const runtime = runtimeRes.data ?? null;

  return {
    buffer_days: alloc?.planned_end_date ? daysBetween(new Date(), new Date(alloc.planned_end_date)) : null,
    deviation_pct: correction?.deviation_pct ?? null,
    active_rework_count: null,                       // future: scoped count
    runtime_status: runtime?.runtime_status ?? null,
    overload_pct: runtime?.overload_pct ?? null,
    current_efficiency: runtime?.current_efficiency ?? null,
    recent_anomalies: anomalyRes.data ?? [],
  };
}

async function gatherAllocationSignalsBatch(supabase, allocationIds) {
  const [allocRes, corrRes, runtimeRes, anomalyRes] = await Promise.all([
    supabase.from("production_allocations").select("id, order_id, factory_id, planned_end_date")
      .in("id", allocationIds),
    supabase.from("order_corrections").select("allocation_id, deviation_pct, date")
      .in("allocation_id", allocationIds).order("date", { ascending: false }),
    supabase.from("production_runtime_lines")
      .select("current_allocation_id, runtime_status, overload_pct, current_efficiency")
      .in("current_allocation_id", allocationIds),
    supabase.from("runtime_events").select("allocation_id, severity")
      .in("allocation_id", allocationIds).gte("occurred_at", isoHoursAgo(ANOMALY_LOOKBACK_HOURS)),
  ]);

  const allocs = new Map((allocRes.data ?? []).map((a) => [a.id, a]));
  // Keep most recent correction per allocation
  const latestCorr = new Map();
  for (const c of corrRes.data ?? []) if (!latestCorr.has(c.allocation_id)) latestCorr.set(c.allocation_id, c);
  const runtimes = new Map((runtimeRes.data ?? []).map((r) => [r.current_allocation_id, r]));
  const anomGroups = new Map();
  for (const e of anomalyRes.data ?? []) {
    const arr = anomGroups.get(e.allocation_id) ?? [];
    arr.push(e);
    anomGroups.set(e.allocation_id, arr);
  }

  const out = new Map();
  for (const id of allocationIds) {
    const a = allocs.get(id);
    const r = runtimes.get(id);
    out.set(id, {
      buffer_days: a?.planned_end_date ? daysBetween(new Date(), new Date(a.planned_end_date)) : null,
      deviation_pct: latestCorr.get(id)?.deviation_pct ?? null,
      runtime_status: r?.runtime_status ?? null,
      overload_pct: r?.overload_pct ?? null,
      current_efficiency: r?.current_efficiency ?? null,
      recent_anomalies: anomGroups.get(id) ?? [],
    });
  }
  return out;
}

async function gatherLineSignals(supabase, lineId) {
  const [runtimeRes, anomalyRes] = await Promise.all([
    supabase.from("production_runtime_lines").select("*").eq("line_id", lineId).maybeSingle(),
    supabase.from("runtime_events").select("severity")
      .eq("line_id", lineId).gte("occurred_at", isoHoursAgo(ANOMALY_LOOKBACK_HOURS)),
  ]);
  const r = runtimeRes.data;
  return {
    runtime_status: r?.runtime_status ?? null,
    overload_pct: r?.overload_pct ?? null,
    current_efficiency: r?.current_efficiency ?? null,
    recent_anomalies: anomalyRes.data ?? [],
  };
}

async function gatherLineSignalsBatch(supabase, lineIds) {
  const [runtimeRes, anomalyRes] = await Promise.all([
    supabase.from("production_runtime_lines").select("*").in("line_id", lineIds),
    supabase.from("runtime_events").select("line_id, severity")
      .in("line_id", lineIds).gte("occurred_at", isoHoursAgo(ANOMALY_LOOKBACK_HOURS)),
  ]);
  const runtimes = new Map((runtimeRes.data ?? []).map((r) => [r.line_id, r]));
  const anomGroups = new Map();
  for (const e of anomalyRes.data ?? []) {
    const arr = anomGroups.get(e.line_id) ?? [];
    arr.push(e);
    anomGroups.set(e.line_id, arr);
  }
  const out = new Map();
  for (const id of lineIds) {
    const r = runtimes.get(id);
    out.set(id, {
      runtime_status: r?.runtime_status ?? null,
      overload_pct: r?.overload_pct ?? null,
      current_efficiency: r?.current_efficiency ?? null,
      recent_anomalies: anomGroups.get(id) ?? [],
    });
  }
  return out;
}

async function gatherFactorySignals(supabase, factoryId) {
  const [factRes, runtimeRes, anomalyRes] = await Promise.all([
    supabase.from("factories").select("delay_score, quality_score, cooperation_score")
      .eq("id", factoryId).maybeSingle(),
    supabase.from("production_runtime_lines").select("runtime_risk")
      .eq("factory_id", factoryId).eq("runtime_risk", "red"),
    supabase.from("runtime_events").select("severity")
      .eq("factory_id", factoryId).gte("occurred_at", isoHoursAgo(ANOMALY_LOOKBACK_HOURS)),
  ]);
  const f = factRes.data;
  return {
    delay_score: f?.delay_score ?? null,
    quality_score: f?.quality_score ?? null,
    cooperation_score: f?.cooperation_score ?? null,
    active_red_lines_count: (runtimeRes.data ?? []).length,
    recent_anomalies: anomalyRes.data ?? [],
  };
}

async function gatherCustomerSignals(supabase, customerId) {
  const { data } = await supabase.from("customers").select("risk_level, payment_cycle_days")
    .eq("id", customerId).maybeSingle();
  return {
    risk_level: data?.risk_level ?? null,
    payment_overdue_days: null,   // future: join invoices
  };
}

// ── Date helpers ──

function isoHoursAgo(hours) { return new Date(Date.now() - hours * 3600 * 1000).toISOString(); }
function isoDaysAgo(days)   { return new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10); }
function daysBetween(a, b)  { return Math.ceil((b.getTime() - a.getTime()) / 86400000); }
