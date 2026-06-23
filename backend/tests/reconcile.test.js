/**
 * Cross-channel output reconciliation (V8) — phone-authoritative merge.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reconcileOutput } from "../src/scheduler/reconcile.js";

describe("reconcileOutput", () => {
  it("counts Excel-only allocations", () => {
    const { byAllocation } = reconcileOutput(
      [{ allocation_id: "a", date: "2026-06-01", actual_output: 100 },
       { allocation_id: "a", date: "2026-06-02", actual_output: 120 }],
      [],
    );
    assert.equal(byAllocation.a.actual_cumulative, 220);
    assert.equal(byAllocation.a.report_days, 2);
    assert.equal(byAllocation.a.excel_days, 2);
    assert.equal(byAllocation.a.phone_days, 0);
  });

  it("counts phone-only allocations (no longer under-counts)", () => {
    const { byAllocation } = reconcileOutput(
      [],
      [{ allocation_id: "a", date: "2026-06-01", output_qty: 80 },
       { allocation_id: "a", date: "2026-06-01", output_qty: 20 }],  // two reports same day
    );
    assert.equal(byAllocation.a.actual_cumulative, 100);
    assert.equal(byAllocation.a.report_days, 1);
    assert.equal(byAllocation.a.phone_days, 1);
  });

  it("phone wins on an overlapping day (no double-count)", () => {
    const { byAllocation, overlaps } = reconcileOutput(
      [{ allocation_id: "a", date: "2026-06-01", actual_output: 90 }],   // Excel says 90
      [{ allocation_id: "a", date: "2026-06-01", output_qty: 100 }],     // phone says 100
    );
    // Authoritative = phone 100, NOT 190.
    assert.equal(byAllocation.a.actual_cumulative, 100);
    assert.equal(overlaps.length, 1);
    assert.deepEqual(overlaps[0], { allocation_id: "a", date: "2026-06-01", phone: 100, excel: 90 });
  });

  it("mixes per-day: phone where present, Excel where not", () => {
    const { byAllocation } = reconcileOutput(
      [{ allocation_id: "a", date: "2026-06-01", actual_output: 90 },    // overlap → ignored
       { allocation_id: "a", date: "2026-06-02", actual_output: 70 }],   // excel-only day → counted
      [{ allocation_id: "a", date: "2026-06-01", output_qty: 100 }],     // phone day
    );
    assert.equal(byAllocation.a.actual_cumulative, 170);   // 100 (phone d1) + 70 (excel d2)
    assert.equal(byAllocation.a.report_days, 2);
  });

  it("normalizes timestamp dates and ignores rows without allocation/date", () => {
    const { byAllocation } = reconcileOutput(
      [{ allocation_id: "a", date: "2026-06-01T13:00:00Z", actual_output: 50 },
       { allocation_id: null, date: "2026-06-01", actual_output: 999 },
       { allocation_id: "a", date: null, actual_output: 999 }],
      [],
    );
    assert.equal(byAllocation.a.actual_cumulative, 50);
    assert.equal(byAllocation.a.report_days, 1);
  });

  it("handles empty input", () => {
    const { byAllocation, overlaps } = reconcileOutput([], []);
    assert.deepEqual(byAllocation, {});
    assert.equal(overlaps.length, 0);
  });
});
