/**
 * P3 Agent tests — memory, confidence, forecast, automation
 * Run: node --test backend/tests/agents.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeMemoryConfidence, scoreScenarioConfidence } from "../src/agents/confidence.js";
import { evaluateRules } from "../src/agents/automator.js";
import { createAction } from "../src/agents/types.js";

// ── Confidence Engine Tests ──────────────────────────────

describe("Confidence Engine", () => {
  it("returns low confidence with no data", () => {
    const result = computeMemoryConfidence([]);
    assert.ok(result.score <= 0.4, `Expected low score, got ${result.score}`);
    assert.ok(result.reason.includes("无历史数据"));
  });

  it("returns higher confidence with good data", () => {
    const profile = [
      { metric_type: "delay_avg", value: 1.5, sample_count: 20, trend: "stable", computed_at: new Date().toISOString() },
      { metric_type: "throughput_avg", value: 300, sample_count: 15, trend: "improving", computed_at: new Date().toISOString() },
      { metric_type: "on_time_rate", value: 85, sample_count: 20, trend: "stable", computed_at: new Date().toISOString() },
    ];
    const result = computeMemoryConfidence(profile);
    assert.ok(result.score > 0.5, `Expected higher score, got ${result.score}`);
    assert.ok(result.breakdown.volume > 50);
  });

  it("penalizes declining trends", () => {
    const good = [
      { metric_type: "delay_avg", value: 1, sample_count: 10, trend: "stable", computed_at: new Date().toISOString() },
    ];
    const bad = [
      { metric_type: "delay_avg", value: 5, sample_count: 10, trend: "declining", computed_at: new Date().toISOString() },
      { metric_type: "on_time_rate", value: 40, sample_count: 10, trend: "declining", computed_at: new Date().toISOString() },
      { metric_type: "rework_rate", value: 20, sample_count: 10, trend: "declining", computed_at: new Date().toISOString() },
    ];
    const goodResult = computeMemoryConfidence(good);
    const badResult = computeMemoryConfidence(bad);
    assert.ok(goodResult.score > badResult.score, "Declining trends should lower confidence");
  });

  it("scoreScenarioConfidence adjusts for risk level", () => {
    const memory = [
      { metric_type: "delay_avg", value: 1, sample_count: 10, trend: "stable", computed_at: new Date().toISOString() },
    ];
    const safe = scoreScenarioConfidence({ risk_level: "SAFE" }, memory);
    const high = scoreScenarioConfidence({ risk_level: "HIGH" }, memory);
    assert.ok(safe.confidence_score > high.confidence_score, "HIGH risk should have lower confidence");
  });

  it("penalizes factories with high delay_avg", () => {
    const goodMem = [{ metric_type: "delay_avg", value: 0.5, sample_count: 10, trend: "stable", computed_at: new Date().toISOString() }];
    const badMem = [{ metric_type: "delay_avg", value: 5, sample_count: 10, trend: "stable", computed_at: new Date().toISOString() }];
    const good = scoreScenarioConfidence({ risk_level: "SAFE" }, goodMem);
    const bad = scoreScenarioConfidence({ risk_level: "SAFE" }, badMem);
    assert.ok(good.confidence_score > bad.confidence_score, "High delay factory should have lower confidence");
  });
});

// ── Automation Rule Engine Tests ─────────────────────────

describe("Automation Rules", () => {
  it("triggers on critical risk_status", () => {
    const contexts = [
      { entity_type: "order", entity_id: "A1", risk_status: "critical" },
    ];
    const { triggered } = evaluateRules(contexts);
    assert.ok(triggered.length > 0, "Should trigger for critical status");
    assert.ok(triggered.some((t) => t.trigger_type === "risk_status_critical"));
  });

  it("triggers on missing report", () => {
    const contexts = [
      { entity_type: "factory", entity_id: "F1", missing_report: true },
    ];
    const { triggered } = evaluateRules(contexts);
    assert.ok(triggered.some((t) => t.trigger_type === "missing_report"));
  });

  it("triggers on forecast delay", () => {
    const contexts = [
      { entity_type: "order", entity_id: "A2", forecast_delay_days: 5 },
    ];
    const { triggered } = evaluateRules(contexts);
    assert.ok(triggered.some((t) => t.trigger_type === "forecast_delay"));
  });

  it("does NOT trigger when all is fine", () => {
    const contexts = [
      { entity_type: "order", entity_id: "A3", risk_status: "on_track", forecast_delay_days: 0 },
    ];
    const { triggered } = evaluateRules(contexts);
    assert.equal(triggered.length, 0, "Should not trigger when everything is OK");
  });

  it("sorts by priority (critical first)", () => {
    const contexts = [
      { entity_type: "factory", entity_id: "F1", missing_report: true },
      { entity_type: "order", entity_id: "A1", risk_status: "critical" },
    ];
    const { triggered } = evaluateRules(contexts);
    assert.ok(triggered.length >= 2);
    assert.ok(triggered[0].priority >= triggered[1].priority, "Higher priority should come first");
  });
});

// ── Memory Integration Test ──────────────────────────────

describe("Agent Types Consistency", () => {
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
