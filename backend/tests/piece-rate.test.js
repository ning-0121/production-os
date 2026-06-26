/**
 * Piece-wage trial calculation (Wedge S1) — pure module tests.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveRate, computePieceWages, reconcile,
  normalizeName, normalizeOperation, detectDuplicates, buildPilotReport,
} from "../src/payroll/piece-rate.js";

const RATES = [
  { operation: "平车", line_id: null, unit_price: 0.8, active: true },
  { operation: "平车", line_id: "L1", unit_price: 0.9, active: true },   // line-specific override
  { operation: "锁眼", line_id: null, unit_price: 0.3, active: true },
  { operation: "包装", line_id: null, unit_price: 0.2, active: false },  // inactive
];

describe("resolveRate", () => {
  it("prefers line-specific over global", () => {
    assert.equal(resolveRate(RATES, "平车", "L1"), 0.9);
  });
  it("falls back to global when no line-specific", () => {
    assert.equal(resolveRate(RATES, "平车", "L2"), 0.8);
    assert.equal(resolveRate(RATES, "锁眼", "L1"), 0.3);
  });
  it("ignores inactive rates → null", () => {
    assert.equal(resolveRate(RATES, "包装", "L1"), null);
  });
  it("returns null for unknown operation / missing operation", () => {
    assert.equal(resolveRate(RATES, "绣花", "L1"), null);
    assert.equal(resolveRate(RATES, null, "L1"), null);
  });
});

describe("computePieceWages", () => {
  const rows = [
    { reported_by: "张三", operation: "平车", line_id: "L1", output_qty: 100, date: "2026-06-25" }, // 100×0.9=90
    { reported_by: "张三", operation: "锁眼", line_id: "L1", output_qty: 200, date: "2026-06-25" }, // 200×0.3=60
    { reported_by: "李四", operation: "平车", line_id: "L2", output_qty: 50,  date: "2026-06-25" }, // 50×0.8=40
    { reported_by: "王五", operation: "绣花", line_id: "L1", output_qty: 30,  date: "2026-06-25" }, // no rate
    { reported_by: "李四", operation: "平车", line_id: "L2", output_qty: 0,   date: "2026-06-25" }, // zero → skipped
  ];
  const r = computePieceWages(rows, RATES);

  it("totals output and amount, tracks missing-rate qty", () => {
    assert.equal(r.total.output_qty, 380);     // 100+200+50+30
    assert.equal(r.total.amount, 190);         // 90+60+40
    assert.equal(r.total.missing_rate_qty, 30);
  });
  it("aggregates by worker (sorted by amount desc)", () => {
    assert.equal(r.by_worker[0].worker, "张三");
    assert.equal(r.by_worker[0].amount, 150);
    const lisi = r.by_worker.find((w) => w.worker === "李四");
    assert.equal(lisi.amount, 40);
    const wangwu = r.by_worker.find((w) => w.worker === "王五");
    assert.equal(wangwu.amount, 0);
    assert.equal(wangwu.missing_rate_qty, 30);
  });
  it("reports the distinct missing-rate operation", () => {
    assert.equal(r.missing_rates.length, 1);
    assert.equal(r.missing_rates[0].operation, "绣花");
  });
  it("handles empty input", () => {
    const e = computePieceWages([], RATES);
    assert.equal(e.total.amount, 0);
    assert.deepEqual(e.by_worker, []);
  });
});

describe("reconcile against manual wage sheet", () => {
  const computed = [{ worker: "张三", amount: 150 }, { worker: "李四", amount: 40 }];
  it("computes per-worker diff and max abs pct (the <1% gate)", () => {
    const r = reconcile(computed, { "张三": 148, "李四": 40 });
    assert.equal(r.total.computed, 190);
    assert.equal(r.total.manual, 188);
    assert.equal(r.total.diff, 2);
    const zs = r.rows.find((x) => x.worker === "张三");
    assert.ok(Math.abs(zs.diff_pct - 1.35) < 0.01);   // 2/148
    assert.ok(r.max_abs_diff_pct >= 1.35);
  });
  it("flags a worker present only in one source", () => {
    const r = reconcile([{ worker: "张三", amount: 150 }], { "张三": 150, "赵六": 80 });
    const zl = r.rows.find((x) => x.worker === "赵六");
    assert.equal(zl.computed, 0);
    assert.equal(zl.manual, 80);
    assert.equal(zl.diff, -80);
  });
});

// ── Pilot data-quality (Wedge S1 pilot) ─────────────────────
describe("normalizeName / normalizeOperation", () => {
  it("folds full-width, drops whitespace so one worker isn't split", () => {
    assert.equal(normalizeName("张三 "), "张三");
    assert.equal(normalizeName("张　三"), "张三");
    assert.equal(normalizeName("张三"), normalizeName("张三 "));
  });
  it("normalizes operations (fold + strip + lower)", () => {
    assert.equal(normalizeOperation("平 车"), "平车");
    assert.equal(normalizeOperation("Sewing "), "sewing");
  });
});

describe("detectDuplicates", () => {
  it("flags same wo+worker+qty within the window as duplicate", () => {
    const r = detectDuplicates([
      { id: "1", work_order_id: "wo1", reported_by: "张三", output_qty: 50, reported_at: "2026-06-25T01:00:00Z" },
      { id: "2", work_order_id: "wo1", reported_by: "张三", output_qty: 50, reported_at: "2026-06-25T01:00:30Z" }, // +30s dup
      { id: "3", work_order_id: "wo1", reported_by: "张三", output_qty: 50, reported_at: "2026-06-25T05:00:00Z" }, // hours later: not dup
    ]);
    assert.equal(r.duplicate_count, 1);
    assert.equal(r.duplicates[0].id, "2");
  });
  it("different qty / worker are not duplicates", () => {
    const r = detectDuplicates([
      { work_order_id: "wo1", reported_by: "张三", output_qty: 50, reported_at: "2026-06-25T01:00:00Z" },
      { work_order_id: "wo1", reported_by: "张三", output_qty: 60, reported_at: "2026-06-25T01:00:30Z" },
      { work_order_id: "wo1", reported_by: "李四", output_qty: 50, reported_at: "2026-06-25T01:00:40Z" },
    ]);
    assert.equal(r.duplicate_count, 0);
  });
});

describe("buildPilotReport", () => {
  const rates = [{ operation: "平车", line_id: null, unit_price: 0.8, active: true }];
  const joined = [
    { id: "1", work_order_id: "wo1", reported_by: "张三 ", operation: "平 车", line_id: "L1", output_qty: 100, reported_at: "2026-06-25T01:00:00Z" },
    { id: "2", work_order_id: "wo1", reported_by: "张　三", operation: "平车", line_id: "L1", output_qty: 100, reported_at: "2026-06-25T01:00:20Z" }, // dup + name variant
    { id: "3", work_order_id: "wo2", reported_by: "", operation: "锁眼", line_id: "L1", output_qty: 40, reported_at: "2026-06-25T02:00:00Z" }, // missing worker + missing rate
  ];
  const rep = buildPilotReport(joined, rates);

  it("normalization merges the name variants into one worker", () => {
    const zhang = rep.by_worker.find((w) => w.worker === "张三");
    assert.ok(zhang, "张三 should be a single normalized worker");
    assert.equal(zhang.output_qty, 200);    // both 平车 reports merged
    assert.equal(zhang.amount, 160);        // 200 × 0.8
  });
  it("counts missing worker, missing rate, duplicates", () => {
    assert.equal(rep.missing_worker_count, 1);       // the 锁眼 report
    assert.equal(rep.missing_piece_rate_count, 1);   // 锁眼 has no rate
    assert.equal(rep.duplicate_report_count, 1);     // the +20s repeat
  });
  it("returns reconciliation rows with blank manual columns (trial only)", () => {
    const row = rep.reconciliation_rows[0];
    assert.ok("system_output" in row && "system_amount" in row);
    assert.equal(row.manual_output, null);
    assert.equal(row.manual_amount, null);
  });
});
