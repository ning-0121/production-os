/**
 * Import Gateway tests — pure modules (dictionary / recognizer / normalizer / resolver).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { normalizeHeader, matchScore } from "../src/import-gateway/dictionary.js";
import { recognizeColumns, detectImportType } from "../src/import-gateway/recognizer.js";
import { normalizeRow, dedupKey } from "../src/import-gateway/normalizer.js";
import { similarity } from "../src/import-gateway/resolver.js";

// ── Dictionary ─────────────────────────────────────────────

describe("Dictionary normalizeHeader", () => {
  it("strips punctuation and whitespace", () => {
    assert.equal(normalizeHeader("订单号 (PO)"), "订单号po");
    assert.equal(normalizeHeader("  Today Qty  "), "todayqty");
    assert.equal(normalizeHeader("累计-产量"), "累计产量");
  });
  it("handles null / empty", () => {
    assert.equal(normalizeHeader(null), "");
    assert.equal(normalizeHeader(""), "");
  });
});

describe("Dictionary matchScore", () => {
  it("exact match scores 1.0", () => {
    assert.equal(matchScore("订单号", "order_no"), 1.0);
    assert.equal(matchScore("PO", "order_no"), 1.0);
  });
  it("substring match scores high", () => {
    assert.ok(matchScore("订单号 ABC", "order_no") >= 0.7);
    assert.ok(matchScore("Order Number Today", "order_no") >= 0.7);
  });
  it("unrelated headers score 0", () => {
    assert.equal(matchScore("天气", "order_no"), 0);
    assert.equal(matchScore("temperature", "actual_output"), 0);
  });
});

// ── Recognizer ─────────────────────────────────────────────

describe("Recognizer detectImportType", () => {
  it("detects daily_report from Chinese headers", () => {
    const r = detectImportType(["日期", "订单号", "今日产量", "累计产量", "车间"]);
    assert.equal(r.import_type, "daily_report");
    assert.ok(r.confidence > 0);
  });
  it("detects qc from QC-flavored headers", () => {
    const r = detectImportType(["日期", "订单号", "抽检数量", "不良数", "缺陷代码"]);
    assert.equal(r.import_type, "qc");
  });
  it("detects rework", () => {
    const r = detectImportType(["日期", "订单号", "返工数量", "返工原因", "责任方"]);
    assert.equal(r.import_type, "rework");
  });
  it("detects hanging_line", () => {
    const r = detectImportType(["日期", "产线", "工序号", "小时产量", "操作员"]);
    assert.equal(r.import_type, "hanging_line");
  });
  it("falls back to daily_report when ambiguous", () => {
    const r = detectImportType(["random", "headers"]);
    assert.equal(r.import_type, "daily_report");
  });
});

describe("Recognizer recognizeColumns", () => {
  it("maps Chinese daily-report columns", () => {
    const r = recognizeColumns({
      headers: ["日期", "订单号", "今日产量", "累计产量", "车间", "异常"],
      importType: "daily_report",
    });
    const byHeader = Object.fromEntries(r.mappings.map((m) => [m.external_header, m.internal_field]));
    assert.equal(byHeader["日期"], "date");
    assert.equal(byHeader["订单号"], "order_no");
    assert.equal(byHeader["今日产量"], "actual_output");
    assert.equal(byHeader["累计产量"], "cumulative_output");
    assert.equal(byHeader["车间"], "line_name");
    assert.equal(byHeader["异常"], "is_abnormal");
    assert.equal(r.unmapped_headers.length, 0);
  });

  it("maps English daily-report columns", () => {
    const r = recognizeColumns({
      headers: ["Date", "PO", "Qty Today", "Cumulative", "Line", "Note"],
      importType: "daily_report",
    });
    const byHeader = Object.fromEntries(r.mappings.map((m) => [m.external_header, m.internal_field]));
    assert.equal(byHeader["Date"], "date");
    assert.equal(byHeader["PO"], "order_no");
    assert.equal(byHeader["Qty Today"], "actual_output");
    assert.equal(byHeader["Line"], "line_name");
    assert.equal(byHeader["Note"], "note");
  });

  it("does not double-claim the same internal field", () => {
    const r = recognizeColumns({
      headers: ["订单号", "PO"],   // both map to order_no
      importType: "daily_report",
    });
    const mapped = r.mappings.filter((m) => m.internal_field === "order_no");
    assert.equal(mapped.length, 1, "only one column should claim order_no");
  });

  it("flags needs_user_confirmation when required field is missing", () => {
    const r = recognizeColumns({
      headers: ["产线", "异常"],   // no date, no actual_output
      importType: "daily_report",
    });
    assert.ok(r.needs_user_confirmation);
    assert.ok(r.missing_required.includes("date") || r.missing_required.includes("actual_output"));
  });

  it("auto-accepts only when confidence ≥ 0.9", () => {
    const r = recognizeColumns({
      headers: ["日期"],
      importType: "daily_report",
    });
    const date = r.mappings.find((m) => m.external_header === "日期");
    assert.equal(date?.internal_field, "date");
    assert.ok(date?.auto_accepted);
  });

  it("respects learned mappings over dictionary", () => {
    const r = recognizeColumns({
      headers: ["产出"],
      learnedByHeader: { "产出": [{ internal_field: "actual_output", confidence: 0.98 }] },
      importType: "daily_report",
    });
    const m = r.mappings.find((x) => x.external_header === "产出");
    assert.equal(m?.internal_field, "actual_output");
    assert.equal(m?.source, "learned");
  });
});

// ── Normalizer ─────────────────────────────────────────────

describe("Normalizer normalizeRow", () => {
  const mappings = [
    { external_header: "日期", internal_field: "date" },
    { external_header: "订单号", internal_field: "order_no" },
    { external_header: "今日产量", internal_field: "actual_output" },
    { external_header: "累计", internal_field: "cumulative_output" },
  ];

  it("coerces types correctly", () => {
    const r = normalizeRow({
      mappings,
      rawRow: { 日期: "2026-05-11", 订单号: "ORD-101", 今日产量: "500", 累计: 1500 },
      importType: "daily_report",
    });
    assert.equal(r.normalized.date, "2026-05-11");
    assert.equal(r.normalized.order_no, "ORD-101");
    assert.equal(r.normalized.actual_output, 500);
    assert.equal(r.normalized.cumulative_output, 1500);
    assert.equal(r.errors.length, 0);
  });

  it("parses Chinese date formats", () => {
    const r = normalizeRow({
      mappings,
      rawRow: { 日期: "2026年5月11日", 今日产量: 100 },
      importType: "daily_report",
    });
    assert.equal(r.normalized.date, "2026-05-11");
  });

  it("parses Excel serial date numbers", () => {
    // 2026-05-11 is roughly serial 46153 (days since 1899-12-30)
    const r = normalizeRow({
      mappings,
      rawRow: { 日期: 46153, 今日产量: 100 },
      importType: "daily_report",
    });
    assert.match(r.normalized.date, /^2026-/);
  });

  it("rejects negative actual_output", () => {
    const r = normalizeRow({
      mappings,
      rawRow: { 日期: "2026-05-11", 今日产量: -50 },
      importType: "daily_report",
    });
    assert.ok(r.errors.some((e) => e.code === "negative_output"));
  });

  it("rejects cumulative regression", () => {
    const r = normalizeRow({
      mappings,
      rawRow: { 日期: "2026-05-11", 今日产量: 100, 累计: 800 },
      importType: "daily_report",
      context: { running_max_cumulative: 1000 },
    });
    assert.ok(r.errors.some((e) => e.code === "cumulative_regression"));
  });

  it("warns on output spike", () => {
    const r = normalizeRow({
      mappings,
      rawRow: { 日期: "2026-05-11", 今日产量: 5000 },
      importType: "daily_report",
      context: { running_mean: 500 },
    });
    assert.ok(r.warnings.some((w) => w.code === "spike"));
  });

  it("warns on output dip", () => {
    const r = normalizeRow({
      mappings,
      rawRow: { 日期: "2026-05-11", 今日产量: 50 },
      importType: "daily_report",
      context: { running_mean: 500 },
    });
    assert.ok(r.warnings.some((w) => w.code === "dip"));
  });

  it("normalizes QC result strings", () => {
    const qcMaps = [
      { external_header: "日期", internal_field: "date" },
      { external_header: "结果", internal_field: "result" },
    ];
    const pass = normalizeRow({ mappings: qcMaps, rawRow: { 日期: "2026-05-11", 结果: "合格" }, importType: "qc" });
    const fail = normalizeRow({ mappings: qcMaps, rawRow: { 日期: "2026-05-11", 结果: "不合格" }, importType: "qc" });
    const cond = normalizeRow({ mappings: qcMaps, rawRow: { 日期: "2026-05-11", 结果: "Conditional pass" }, importType: "qc" });
    assert.equal(pass.normalized.result, "pass");
    assert.equal(fail.normalized.result, "fail");
    assert.equal(cond.normalized.result, "conditional");
  });

  it("rejects QC defects > inspected", () => {
    const qcMaps = [
      { external_header: "日期", internal_field: "date" },
      { external_header: "抽检", internal_field: "total_qty_inspected" },
      { external_header: "不良", internal_field: "total_defects" },
    ];
    const r = normalizeRow({
      mappings: qcMaps,
      rawRow: { 日期: "2026-05-11", 抽检: 100, 不良: 150 },
      importType: "qc",
    });
    assert.ok(r.errors.some((e) => e.code === "defects_exceed_inspected"));
  });

  it("rejects rework qty ≤ 0", () => {
    const r = normalizeRow({
      mappings: [
        { external_header: "返工数量", internal_field: "rework_qty" },
      ],
      rawRow: { 返工数量: 0 },
      importType: "rework",
    });
    assert.ok(r.errors.some((e) => e.code === "invalid_rework_qty"));
  });

  it("coerces Chinese boolean for is_abnormal", () => {
    const r = normalizeRow({
      mappings: [
        { external_header: "异常", internal_field: "is_abnormal" },
        { external_header: "今日产量", internal_field: "actual_output" },
      ],
      rawRow: { 异常: "是", 今日产量: 100 },
      importType: "daily_report",
    });
    assert.equal(r.normalized.is_abnormal, true);
  });
});

describe("Normalizer dedupKey", () => {
  it("builds stable keys for daily reports", () => {
    const k1 = dedupKey({ date: "2026-05-11", factory_name: "工厂A", line_name: "线1", order_no: "ORD-1", stage: "sewing" }, "daily_report");
    const k2 = dedupKey({ date: "2026-05-11", factory_name: "工厂A", line_name: "线1", order_no: "ORD-1", stage: "sewing" }, "daily_report");
    assert.equal(k1, k2);
  });
});

// ── Resolver similarity ─────────────────────────────────────

describe("Resolver similarity", () => {
  it("returns 1.0 for exact match", () => {
    assert.equal(similarity("工厂A", "工厂A"), 1);
  });
  it("handles whitespace + case differences", () => {
    assert.ok(similarity("Factory A", "factory  a") > 0.9);
  });
  it("scores fuzzy matches reasonably", () => {
    const s = similarity("工厂A 一号车间", "工厂A1号车间");
    assert.ok(s > 0.6 && s < 1);
  });
  it("returns 0 for unrelated", () => {
    assert.ok(similarity("apple", "zebra") < 0.3);
  });
});
