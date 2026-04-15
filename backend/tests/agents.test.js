/**
 * Agent tests v2 — confidence (statistics), automation (rules engine)
 * Run: node --test backend/tests/agents.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeMemoryConfidence, scoreScenarioConfidence, detectAnomaly, analyzeTrend } from "../src/agents/confidence.js";
import { evaluateRules, getBuiltinRules } from "../src/agents/automator.js";
import { createAction } from "../src/agents/types.js";

// ── Confidence Engine (Statistics) ───────────────────────

describe("Confidence Engine v2", () => {
  it("returns low confidence with no data", () => {
    const result = computeMemoryConfidence([]);
    assert.ok(result.score <= 0.4);
    assert.ok(result.reason.includes("无历史数据"));
  });

  it("returns higher confidence with good data", () => {
    const profile = [
      { metric_type: "delay_avg", value: 1.5, sample_count: 20, trend: "stable", computed_at: new Date().toISOString() },
      { metric_type: "throughput_avg", value: 300, sample_count: 15, trend: "improving", computed_at: new Date().toISOString() },
      { metric_type: "on_time_rate", value: 85, sample_count: 20, trend: "stable", computed_at: new Date().toISOString() },
    ];
    const result = computeMemoryConfidence(profile);
    assert.ok(result.score > 0.5);
    assert.ok(result.breakdown.consistency > 0);
    assert.ok(result.breakdown.trend > 0);
  });

  it("penalizes declining trends", () => {
    const good = [{ metric_type: "delay_avg", value: 1, sample_count: 10, trend: "stable", computed_at: new Date().toISOString() }];
    const bad = [
      { metric_type: "delay_avg", value: 5, sample_count: 10, trend: "declining", computed_at: new Date().toISOString() },
      { metric_type: "on_time_rate", value: 40, sample_count: 10, trend: "declining", computed_at: new Date().toISOString() },
      { metric_type: "rework_rate", value: 20, sample_count: 10, trend: "declining", computed_at: new Date().toISOString() },
    ];
    const goodResult = computeMemoryConfidence(good);
    const badResult = computeMemoryConfidence(bad);
    assert.ok(goodResult.score > badResult.score);
  });

  it("scoreScenarioConfidence adjusts for risk level", () => {
    const memory = [{ metric_type: "delay_avg", value: 1, sample_count: 10, trend: "stable", computed_at: new Date().toISOString() }];
    const safe = scoreScenarioConfidence({ risk_level: "SAFE" }, memory);
    const high = scoreScenarioConfidence({ risk_level: "HIGH" }, memory);
    assert.ok(safe.confidence_score > high.confidence_score);
  });
});

// ── Anomaly Detection (z-score) ──────────────────────────

describe("Anomaly Detection", () => {
  it("detects outlier in dataset", () => {
    const data = [100, 102, 98, 101, 99, 100, 103, 97];
    const result = detectAnomaly(150, data);
    assert.ok(result.isAnomaly, "150 should be anomaly in ~100 dataset");
    assert.ok(result.zScore > 2);
  });

  it("does not flag normal value", () => {
    const data = [100, 102, 98, 101, 99, 100, 103, 97];
    const result = detectAnomaly(101, data);
    assert.ok(!result.isAnomaly);
  });

  it("handles insufficient data gracefully", () => {
    const result = detectAnomaly(100, [50, 60]);
    assert.ok(!result.isAnomaly);
    assert.ok(result.reason.includes("数据不足"));
  });
});

// ── Trend Analysis (linear regression) ───────────────────

describe("Trend Analysis", () => {
  it("detects increasing trend", () => {
    const result = analyzeTrend([10, 12, 15, 18, 20]);
    assert.equal(result.direction, "increasing");
    assert.ok(result.slope > 0);
    assert.ok(result.prediction > 20);
  });

  it("detects decreasing trend", () => {
    const result = analyzeTrend([20, 18, 15, 12, 10]);
    assert.equal(result.direction, "decreasing");
    assert.ok(result.slope < 0);
  });

  it("detects stable trend", () => {
    const result = analyzeTrend([100, 100.05, 99.95, 100.02, 99.98]);
    assert.equal(result.direction, "stable");
  });

  it("handles insufficient data", () => {
    const result = analyzeTrend([5, 10]);
    assert.equal(result.direction, "unknown");
  });
});

// ── Automation Rules Engine (json-rules-engine) ──────────

describe("Automation Rules Engine v2", () => {
  it("triggers on critical risk_status", async () => {
    const contexts = [{ entity_type: "order", entity_id: "A1", risk_status: "critical", deviation_pct: 100, days_behind: 0, forecast_delay_days: 0, missing_report: false, material_shortage: false, days_to_start: 999, margin_pct: 100, utilization_pct: 0 }];
    const { triggered } = await evaluateRules(contexts);
    assert.ok(triggered.length > 0);
    assert.ok(triggered.some((t) => t.trigger_type === "critical_risk"));
  });

  it("triggers on missing report", async () => {
    const contexts = [{ entity_type: "factory", entity_id: "F1", missing_report: true, risk_status: "on_track", deviation_pct: 100, days_behind: 0, forecast_delay_days: 0, material_shortage: false, days_to_start: 999, margin_pct: 100, utilization_pct: 0 }];
    const { triggered } = await evaluateRules(contexts);
    assert.ok(triggered.some((t) => t.trigger_type === "missing_report"));
  });

  it("triggers on forecast delay", async () => {
    const contexts = [{ entity_type: "order", entity_id: "A2", forecast_delay_days: 5, risk_status: "on_track", deviation_pct: 100, days_behind: 0, missing_report: false, material_shortage: false, days_to_start: 999, margin_pct: 100, utilization_pct: 0 }];
    const { triggered } = await evaluateRules(contexts);
    assert.ok(triggered.some((t) => t.trigger_type === "forecast_delay"));
  });

  it("triggers on low margin", async () => {
    const contexts = [{ entity_type: "order", entity_id: "A3", margin_pct: 5, risk_status: "on_track", deviation_pct: 100, days_behind: 0, forecast_delay_days: 0, missing_report: false, material_shortage: false, days_to_start: 999, utilization_pct: 0 }];
    const { triggered } = await evaluateRules(contexts);
    assert.ok(triggered.some((t) => t.trigger_type === "low_margin"));
  });

  it("does NOT trigger when all is fine", async () => {
    const contexts = [{ entity_type: "order", entity_id: "A4", risk_status: "on_track", deviation_pct: 100, days_behind: 0, forecast_delay_days: 0, missing_report: false, material_shortage: false, days_to_start: 999, margin_pct: 20, utilization_pct: 50 }];
    const { triggered } = await evaluateRules(contexts);
    assert.equal(triggered.length, 0);
  });

  it("loads custom rules", async () => {
    const customRules = [{
      name: "Test Rule",
      trigger_type: "test_trigger",
      condition_json: { all: [{ fact: "entity_type", operator: "equal", value: "test" }] },
      actions_json: ["test_action"],
      priority: 50,
    }];
    const contexts = [{ entity_type: "test", risk_status: "on_track", deviation_pct: 100, days_behind: 0, forecast_delay_days: 0, missing_report: false, material_shortage: false, days_to_start: 999, margin_pct: 100, utilization_pct: 0 }];
    const { triggered } = await evaluateRules(contexts, customRules);
    assert.ok(triggered.some((t) => t.trigger_type === "test_trigger"));
  });

  it("exports builtin rules", () => {
    const rules = getBuiltinRules();
    assert.ok(rules.length >= 7);
    assert.ok(rules[0].name);
    assert.ok(rules[0].conditions);
    assert.ok(Array.isArray(rules[0].actions));
  });
});

// ── Agent Types ──────────────────────────────────────────

describe("Agent Types", () => {
  it("createAction works with automator agent", () => {
    const action = createAction({
      agent: "automator",
      action_type: "create_incident",
      target_type: "order",
      target_id: "A1",
      summary: "自动升级事故",
      urgency: "critical",
      confidence: 0.85,
    });
    assert.equal(action.agent, "automator");
    assert.equal(action.urgency, "critical");
  });
});
