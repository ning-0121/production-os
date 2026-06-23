/**
 * Correction Engine
 *
 * Computes deviation and risk status for all active allocations
 * by comparing planned vs actual production progress. Actual output is
 * reconciled across BOTH input channels (Excel/manual daily reports + phone
 * floor reports), with phone authoritative per day — see reconcile.js — so a
 * line/day reported through both is never double-counted, and a phone-only line
 * is still counted. Upserts results into the order_corrections table.
 */

import { reconcileOutput } from "./reconcile.js";

export async function computeCorrections(supabase) {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  // 1. Load all active allocations (confirmed or in_progress)
  const { data: allocations, error: allocErr } = await supabase
    .from("production_allocations")
    .select("id, order_id, factory_id, allocated_qty, planned_start_date, planned_end_date, status")
    .in("status", ["confirmed", "in_progress"]);

  if (allocErr) throw new Error(`Failed to load allocations: ${allocErr.message}`);

  const allocs = allocations ?? [];
  if (allocs.length === 0) return { processed: 0, corrections: [] };

  // 2. Load all daily production reports for these allocations
  const allocationIds = allocs.map((a) => a.id);
  const { data: allReports, error: repErr } = await supabase
    .from("daily_production_reports")
    .select("allocation_id, actual_output, date")
    .in("allocation_id", allocationIds);

  if (repErr) throw new Error(`Failed to load reports: ${repErr.message}`);

  // 2b. Load phone floor output for the same allocations (shopfloor_reports →
  //     work order → allocation). Phone is authoritative per day in reconcile().
  const { data: wos } = await supabase
    .from("shopfloor_work_orders")
    .select("id, allocation_id")
    .in("allocation_id", allocationIds);
  const woToAlloc = new Map((wos ?? []).filter((w) => w.allocation_id).map((w) => [w.id, w.allocation_id]));
  let phoneRows = [];
  if (woToAlloc.size > 0) {
    const { data: sfReports } = await supabase
      .from("shopfloor_reports")
      .select("work_order_id, output_qty, reported_at")
      .eq("report_type", "output")
      .in("work_order_id", [...woToAlloc.keys()]);
    phoneRows = (sfReports ?? []).map((r) => ({
      allocation_id: woToAlloc.get(r.work_order_id),
      date: String(r.reported_at ?? "").slice(0, 10),
      output_qty: r.output_qty,
    }));
  }

  // Reconcile both channels (phone wins per day; no double-count, no under-count).
  const { byAllocation, overlaps } = reconcileOutput(allReports ?? [], phoneRows);
  if (overlaps.length > 0) {
    console.warn(JSON.stringify({
      level: "INFO", msg: "Cross-channel output overlap reconciled (phone authoritative)",
      overlap_days: overlaps.length,
    }));
  }

  // 3. Compute corrections for each allocation
  const corrections = [];

  for (const alloc of allocs) {
    const aggr = byAllocation[alloc.id] ?? { actual_cumulative: 0, report_days: 0 };
    const actual_cumulative = aggr.actual_cumulative;

    // Calculate planned cumulative: how much SHOULD have been done by today
    const startDate = new Date(alloc.planned_start_date);
    const endDate = new Date(alloc.planned_end_date);
    const totalDays = Math.max(1, Math.ceil((endDate - startDate) / 86400000));
    const elapsedDays = Math.max(0, Math.ceil((today - startDate) / 86400000));
    const dailyPlanned = alloc.allocated_qty / totalDays;
    const planned_cumulative = Math.min(alloc.allocated_qty, dailyPlanned * elapsedDays);

    // Deviation percentage
    const deviation_pct = planned_cumulative > 0
      ? Math.round((actual_cumulative / planned_cumulative) * 1000) / 10
      : actual_cumulative > 0 ? 100 : 0;

    // Estimate end date based on average daily actual rate
    const reportDays = aggr.report_days;
    const avg_daily_actual = reportDays > 0 ? actual_cumulative / reportDays : 0;
    const remaining_qty = Math.max(0, alloc.allocated_qty - actual_cumulative);
    const days_to_complete = avg_daily_actual > 0 ? Math.ceil(remaining_qty / avg_daily_actual) : null;
    const estimated_end_date = days_to_complete != null
      ? new Date(today.getTime() + days_to_complete * 86400000).toISOString().slice(0, 10)
      : null;

    // Risk status
    let risk_status;
    if (deviation_pct >= 80) {
      risk_status = "on_track";
    } else if (deviation_pct >= 60) {
      risk_status = "falling_behind";
    } else {
      risk_status = "critical";
    }

    // Generate recommendations
    const recommendations = [];
    if (risk_status === "falling_behind") {
      recommendations.push("Consider adding overtime shifts to recover schedule");
      recommendations.push("Review daily output targets with factory manager");
    }
    if (risk_status === "critical") {
      recommendations.push("Escalate to production manager immediately");
      recommendations.push("Evaluate splitting order to secondary factory");
      recommendations.push("Negotiate deadline extension with client if possible");
    }
    if (estimated_end_date && estimated_end_date > alloc.planned_end_date) {
      recommendations.push(`Estimated completion ${estimated_end_date} exceeds planned end ${alloc.planned_end_date}`);
    }

    corrections.push({
      allocation_id: alloc.id,
      order_id: alloc.order_id,
      factory_id: alloc.factory_id,
      planned_cumulative: Math.round(planned_cumulative),
      actual_cumulative,
      deviation_pct,
      risk_status,
      estimated_end_date,
      recommendations,
      computed_at: new Date().toISOString(),
    });
  }

  // 7. Upsert into order_corrections table
  if (corrections.length > 0) {
    const { error: upsertErr } = await supabase
      .from("order_corrections")
      .upsert(corrections, { onConflict: "allocation_id" });

    if (upsertErr) throw new Error(`Failed to upsert corrections: ${upsertErr.message}`);
  }

  // Return summary
  const summary = {
    processed: corrections.length,
    on_track: corrections.filter((c) => c.risk_status === "on_track").length,
    falling_behind: corrections.filter((c) => c.risk_status === "falling_behind").length,
    critical: corrections.filter((c) => c.risk_status === "critical").length,
    overlap_days_reconciled: overlaps.length,
    computed_at: new Date().toISOString(),
    corrections,
  };

  return summary;
}
