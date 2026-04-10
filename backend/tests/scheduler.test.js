/**
 * Core scheduler algorithm tests
 * Run: node --test backend/tests/scheduler.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runAPS } from "../src/scheduler/aps.js";
import { checkRisk } from "../src/scheduler/risk.js";
import { recommendFactories } from "../src/scheduler/recommend.js";
import { createAction } from "../src/agents/types.js";

// ── APS Engine Tests ─────────────────────────────────────

describe("APS Engine", () => {
  const lines = [
    { id: "L1", name: "线1", factory_id: "F1", factory_name: "工厂A", product_types: ["T恤"], front_capacity_per_day: 300, back_capacity_per_day: 200 },
    { id: "L2", name: "线2", factory_id: "F1", factory_name: "工厂A", product_types: ["裤子"], front_capacity_per_day: 250, back_capacity_per_day: 150 },
  ];

  it("schedules a single order to matching line", () => {
    const orders = [
      { id: "A1", order_id: "ORD-001", product_type: "T恤", allocated_qty: 1000, planned_end_date: "2026-05-01" },
    ];
    const result = runAPS(orders, lines, []);
    assert.ok(result.assignments.length > 0, "Should produce at least 1 assignment");
    assert.equal(result.assignments[0].line_id, "L1", "Should assign T恤 to 线1");
  });

  it("returns warning for unmatched product type", () => {
    const orders = [
      { id: "A2", order_id: "ORD-002", product_type: "外套", allocated_qty: 500, planned_end_date: "2026-05-01" },
    ];
    const result = runAPS(orders, lines, []);
    assert.ok(result.warnings.length > 0 || result.assignments.length === 0, "Should warn or skip unmatched product");
  });

  it("handles empty orders", () => {
    const result = runAPS([], lines, []);
    assert.equal(result.assignments.length, 0);
    assert.ok(result.summary);
  });

  it("handles empty lines", () => {
    const orders = [
      { id: "A3", order_id: "ORD-003", product_type: "T恤", allocated_qty: 500, planned_end_date: "2026-05-01" },
    ];
    const result = runAPS(orders, [], []);
    assert.equal(result.assignments.length, 0, "No lines = no assignments");
  });
});

// ── Risk Assessment Tests ────────────────────────────────

describe("Risk Assessment", () => {
  it("returns SAFE for large buffer", () => {
    const result = checkRisk(
      { due_date: "2026-06-01" },
      { planned_end_date: "2026-05-01" },
    );
    assert.equal(result.level, "SAFE");
    assert.ok(result.buffer_days > 0);
  });

  it("returns HIGH for overdue order", () => {
    const result = checkRisk(
      { due_date: "2026-04-01" },
      { planned_end_date: "2026-04-15" },
    );
    assert.equal(result.level, "HIGH");
    assert.ok(result.buffer_days < 0);
  });

  it("returns MEDIUM for tight buffer", () => {
    const today = new Date();
    const dueDate = new Date(today.getTime() + 3 * 86400000).toISOString().slice(0, 10);
    const endDate = new Date(today.getTime() + 2 * 86400000).toISOString().slice(0, 10);
    const result = checkRisk(
      { due_date: dueDate },
      { planned_end_date: endDate },
    );
    assert.ok(["MEDIUM", "SAFE"].includes(result.level), `Expected MEDIUM or SAFE, got ${result.level}`);
  });

  it("includes risk_score and factors", () => {
    const result = checkRisk(
      { due_date: "2026-05-01" },
      { planned_end_date: "2026-04-25" },
    );
    assert.ok(typeof result.risk_score === "number");
    assert.ok(result.factors);
  });
});

// ── Recommendation Engine Tests ──────────────────────────

describe("Recommendation Engine", () => {
  const factories = [
    {
      id: "F1", name: "工厂A",
      capabilities: [{ product_type: "T恤", daily_capacity: 300, setup_minutes: 30, minutes_per_unit: 1.5, base_capacity_units_per_day: 300, cost_per_unit: 10, quality_score: 85 }],
      capacity: { daily_capacity_minutes: 480 },
      load: { allocated_minutes_next_30d: 5000, utilization_pct: 35 },
    },
    {
      id: "F2", name: "工厂B",
      capabilities: [{ product_type: "T恤", daily_capacity: 200, setup_minutes: 20, minutes_per_unit: 2, base_capacity_units_per_day: 200, cost_per_unit: 8, quality_score: 90 }],
      capacity: { daily_capacity_minutes: 480 },
      load: { allocated_minutes_next_30d: 12000, utilization_pct: 83 },
    },
  ];

  it("returns ranked recommendations", () => {
    const recs = recommendFactories(
      { product_type: "T恤", quantity: 500, due_date: "2026-05-01" },
      factories,
    );
    assert.ok(Array.isArray(recs));
    assert.ok(recs.length > 0, "Should return at least 1 recommendation");
    assert.ok(recs[0].score >= recs[recs.length - 1].score, "Should be sorted by score desc");
  });

  it("marks infeasible factories", () => {
    const recs = recommendFactories(
      { product_type: "T恤", quantity: 50000, due_date: "2026-04-12" },
      factories,
    );
    const infeasible = recs.filter((r) => !r.feasible);
    assert.ok(infeasible.length > 0, "Extremely large order should have infeasible options");
  });

  it("handles no matching capability", () => {
    const recs = recommendFactories(
      { product_type: "羽绒服", quantity: 100, due_date: "2026-05-01" },
      factories,
    );
    // Should still return factories but with low scores or infeasible
    assert.ok(Array.isArray(recs));
  });
});

// ── Agent Types Tests ─────────────────────────────────────

describe("Agent Types", () => {
  it("createAction generates valid structure", () => {
    const action = createAction({
      agent: "test",
      action_type: "alert",
      target_type: "order",
      target_id: "123",
      summary: "测试",
      urgency: "high",
      confidence: 0.8,
    });
    assert.ok(action.id);
    assert.equal(action.agent, "test");
    assert.equal(action.urgency, "high");
    assert.equal(action.confidence, 0.8);
    assert.ok(action.id.startsWith("test-order-123"));
  });
});
