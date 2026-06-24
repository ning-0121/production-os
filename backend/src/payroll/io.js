/**
 * Piece-wage I/O — loads shopfloor output reports + rates, runs the pure calc.
 *
 * 报工件数来自 shopfloor_reports(report_type='output')，工序/产线/订单来自其工单，
 * 工价来自 piece_rates。日期按工厂本地时区(Asia/Shanghai)取整天，避免晚班跨 UTC 零点。
 */

import { computePieceWages } from "./piece-rate.js";

// Factory-local (Asia/Shanghai, +08:00) day boundaries for a YYYY-MM-DD date.
function dayBounds(date) {
  return { start: `${date}T00:00:00+08:00`, end: `${date}T23:59:59.999+08:00` };
}

export async function loadActiveRates(supabase) {
  const { data, error } = await supabase
    .from("piece_rates")
    .select("id, operation, line_id, unit_price, currency, active")
    .eq("active", true);
  if (error) throw error;
  return data ?? [];
}

/**
 * Build the per-report rows the pure calc expects for a given day (+ optional line).
 */
export async function loadPieceWageRows(supabase, { date, line_id } = {}) {
  const { start, end } = dayBounds(date);
  const { data: reports, error } = await supabase
    .from("shopfloor_reports")
    .select("work_order_id, output_qty, reported_by, reported_at")
    .eq("report_type", "output")
    .gte("reported_at", start)
    .lte("reported_at", end);
  if (error) throw error;
  const rep = reports ?? [];
  if (rep.length === 0) return [];

  const woIds = [...new Set(rep.map((r) => r.work_order_id))];
  const { data: wos, error: woErr } = await supabase
    .from("shopfloor_work_orders")
    .select("id, operation, line_id, order_id")
    .in("id", woIds);
  if (woErr) throw woErr;
  const woById = new Map((wos ?? []).map((w) => [w.id, w]));

  let rows = rep.map((r) => {
    const wo = woById.get(r.work_order_id) ?? {};
    return {
      reported_by: r.reported_by,
      operation: wo.operation ?? null,
      line_id: wo.line_id ?? null,
      order_id: wo.order_id ?? null,
      output_qty: r.output_qty,
      date,
    };
  });
  if (line_id) rows = rows.filter((r) => r.line_id === line_id);
  return rows;
}

/** Full piece-wage trial summary for a day (+ optional line). */
export async function computeDailyPieceWages(supabase, { date, line_id } = {}) {
  const [rows, rates] = await Promise.all([
    loadPieceWageRows(supabase, { date, line_id }),
    loadActiveRates(supabase),
  ]);
  const summary = computePieceWages(rows, rates);
  return { date, line_id: line_id ?? null, report_rows: rows.length, ...summary };
}

/**
 * Set (or replace) the active rate for an operation (+ optional line). Keeps the
 * "one active rate per operation/line" invariant by deactivating the prior one.
 */
export async function setPieceRate(supabase, { operation, line_id = null, unit_price, currency = "CNY", note, actor }) {
  if (!operation) throw new Error("operation required");
  if (!(Number(unit_price) >= 0)) throw new Error("unit_price must be >= 0");

  // Deactivate any existing active rate for the same (operation, line).
  let q = supabase.from("piece_rates").update({ active: false, updated_at: new Date().toISOString() })
    .eq("operation", operation).eq("active", true);
  q = line_id == null ? q.is("line_id", null) : q.eq("line_id", line_id);
  await q;

  const { data, error } = await supabase.from("piece_rates")
    .insert({ operation, line_id, unit_price: Number(unit_price), currency, note: note ?? null, active: true, created_by: actor ?? null })
    .select().single();
  if (error) throw error;
  return data;
}
