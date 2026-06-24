/**
 * Piece-wage TRIAL calculation — pure, no I/O.
 *
 * 计件工资试算:工人扫码报工的件数 × 工序工价 = 计件金额。
 *
 * This is the wedge of the whole pilot: a worker scans because the scan becomes
 * money. We compute it here from report rows + the rate table, aggregate by
 * worker / line / operation / day, flag any output with no rate (缺工价), and
 * provide reconciliation against the factory's existing manual wage sheet.
 *
 * TRIAL ONLY — advisory numbers for parallel-run reconciliation, never the
 * authoritative payroll. See migration 015.
 */

const GLOBAL_LINE = "__global__";

/**
 * Resolve the unit price for an operation on a line.
 * Line-specific active rate wins; otherwise the global (line_id = null) rate.
 * @returns {number|null} unit price, or null if none configured.
 */
export function resolveRate(rates, operation, lineId) {
  if (!operation) return null;
  let global = null;
  let specific = null;
  for (const r of rates ?? []) {
    if (r.active === false) continue;
    if (r.operation !== operation) continue;
    if (r.line_id == null) { global = r; }
    else if (lineId != null && r.line_id === lineId) { specific = r; }
  }
  const chosen = specific ?? global;
  return chosen ? Number(chosen.unit_price) : null;
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Compute piece wages from report rows.
 *
 * @param {Array<{reported_by, operation, line_id, order_id, output_qty, date}>} rows
 * @param {Array<{operation, line_id, unit_price, active}>} rates
 * @returns {{
 *   by_worker: Array<{worker, output_qty, amount, missing_rate_qty}>,
 *   by_line:   Array<{line_id, output_qty, amount}>,
 *   by_operation: Array<{operation, output_qty, amount, has_rate}>,
 *   total: { output_qty, amount, missing_rate_qty },
 *   missing_rates: Array<{operation, line_id}>,   // distinct ops with output but no rate
 *   lines_count: number
 * }}
 */
export function computePieceWages(rows, rates) {
  const workers = new Map();
  const lines = new Map();
  const ops = new Map();
  const missing = new Map();   // key op|line -> {operation, line_id}
  let totalQty = 0, totalAmount = 0, totalMissingQty = 0;

  for (const row of rows ?? []) {
    const qty = Number(row.output_qty) || 0;
    if (qty === 0) continue;
    const rate = resolveRate(rates, row.operation, row.line_id);
    const hasRate = rate != null;
    const amount = hasRate ? qty * rate : 0;

    totalQty += qty;
    totalAmount += amount;
    if (!hasRate) {
      totalMissingQty += qty;
      const mk = `${row.operation ?? ""}|${row.line_id ?? GLOBAL_LINE}`;
      if (!missing.has(mk)) missing.set(mk, { operation: row.operation ?? null, line_id: row.line_id ?? null });
    }

    const w = row.reported_by ?? "(未署名)";
    const ws = workers.get(w) ?? { worker: w, output_qty: 0, amount: 0, missing_rate_qty: 0 };
    ws.output_qty += qty; ws.amount += amount; if (!hasRate) ws.missing_rate_qty += qty;
    workers.set(w, ws);

    const lk = row.line_id ?? GLOBAL_LINE;
    const ls = lines.get(lk) ?? { line_id: row.line_id ?? null, output_qty: 0, amount: 0 };
    ls.output_qty += qty; ls.amount += amount;
    lines.set(lk, ls);

    const ok = row.operation ?? "(未填工序)";
    const os = ops.get(ok) ?? { operation: ok, output_qty: 0, amount: 0, has_rate: hasRate };
    os.output_qty += qty; os.amount += amount; os.has_rate = os.has_rate && hasRate;
    ops.set(ok, os);
  }

  const fix = (o) => ({ ...o, amount: round2(o.amount) });
  return {
    by_worker: [...workers.values()].map(fix).sort((a, b) => b.amount - a.amount),
    by_line: [...lines.values()].map(fix),
    by_operation: [...ops.values()].map(fix),
    total: { output_qty: totalQty, amount: round2(totalAmount), missing_rate_qty: totalMissingQty },
    missing_rates: [...missing.values()],
    lines_count: lines.size,
  };
}

/**
 * Reconcile computed per-worker amounts against the factory's manual wage sheet.
 * This is the gate that must hit <1% before anyone is paid from the system.
 *
 * @param {Array<{worker, amount}>} computed
 * @param {Record<string, number>} manualByWorker   worker -> manual amount
 * @returns {{
 *   rows: Array<{worker, computed, manual, diff, diff_pct}>,
 *   total: { computed, manual, diff, diff_pct },
 *   max_abs_diff_pct: number
 * }}
 */
export function reconcile(computed, manualByWorker) {
  const manual = manualByWorker ?? {};
  const workers = new Set([...(computed ?? []).map((c) => c.worker), ...Object.keys(manual)]);
  let cTot = 0, mTot = 0, maxPct = 0;
  const rows = [];
  for (const w of workers) {
    const c = round2(Number((computed ?? []).find((x) => x.worker === w)?.amount) || 0);
    const m = round2(Number(manual[w]) || 0);
    const diff = round2(c - m);
    const diffPct = m !== 0 ? round2((diff / m) * 100) : (c !== 0 ? 100 : 0);
    cTot += c; mTot += m;
    if (Math.abs(diffPct) > maxPct) maxPct = Math.abs(diffPct);
    rows.push({ worker: w, computed: c, manual: m, diff, diff_pct: diffPct });
  }
  rows.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  const totDiff = round2(cTot - mTot);
  return {
    rows,
    total: { computed: round2(cTot), manual: round2(mTot), diff: totDiff, diff_pct: mTot !== 0 ? round2((totDiff / mTot) * 100) : 0 },
    max_abs_diff_pct: round2(maxPct),
  };
}
