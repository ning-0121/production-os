/**
 * Cross-channel output reconciliation (V8 pilot).
 *
 * Production output reaches the system through two parallel channels:
 *   - Excel / manual daily reports  → daily_production_reports.actual_output
 *   - Phone floor reports           → shopfloor_reports.output_qty (per work order)
 *
 * If both report the same (allocation, day) we must NOT add them on top of each
 * other (double-count) and we must NOT count only one table (under-count when a
 * line is phone-only). Policy: **phone floor reports are authoritative** — when a
 * given (allocation, date) has any phone output, it wins for that day; otherwise
 * the Excel/manual figure is used. Output is summed per allocation across days.
 *
 * Pure function — no I/O, fully testable. The caller loads both row sets.
 */

function bucketByAllocationDate(rows, valueKey) {
  // Map<allocation_id, Map<date, summedValue>>
  const m = new Map();
  for (const r of rows ?? []) {
    if (!r.allocation_id || !r.date) continue;
    const date = String(r.date).slice(0, 10);
    if (!m.has(r.allocation_id)) m.set(r.allocation_id, new Map());
    const dm = m.get(r.allocation_id);
    dm.set(date, (dm.get(date) ?? 0) + Number(r[valueKey] ?? 0));
  }
  return m;
}

/**
 * @param {Array<{allocation_id, date, actual_output}>} excelRows   daily_production_reports
 * @param {Array<{allocation_id, date, output_qty}>}   phoneRows   shopfloor output reports
 * @returns {{
 *   byAllocation: Record<string, { actual_cumulative: number, report_days: number,
 *                                  phone_days: number, excel_days: number }>,
 *   overlaps: Array<{ allocation_id, date, phone: number, excel: number }>
 * }}
 */
export function reconcileOutput(excelRows, phoneRows) {
  const phone = bucketByAllocationDate(phoneRows, "output_qty");
  const excel = bucketByAllocationDate(excelRows, "actual_output");

  const allocIds = new Set([...phone.keys(), ...excel.keys()]);
  const byAllocation = {};
  const overlaps = [];

  for (const id of allocIds) {
    const pdm = phone.get(id) ?? new Map();
    const edm = excel.get(id) ?? new Map();
    const dates = new Set([...pdm.keys(), ...edm.keys()]);

    let actual_cumulative = 0;
    let phone_days = 0;
    let excel_days = 0;
    for (const d of dates) {
      const hasP = pdm.has(d);
      const hasE = edm.has(d);
      if (hasP && hasE) {
        overlaps.push({ allocation_id: id, date: d, phone: pdm.get(d), excel: edm.get(d) });
      }
      // Phone wins for the day; Excel only counts when there's no phone data.
      actual_cumulative += hasP ? pdm.get(d) : edm.get(d);
      if (hasP) phone_days++; else excel_days++;
    }
    byAllocation[id] = { actual_cumulative, report_days: dates.size, phone_days, excel_days };
  }

  return { byAllocation, overlaps };
}
