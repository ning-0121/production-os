/**
 * Decision Learning tests — pure module + scoring integration.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeEffectiveness, buildAdjustmentMap, lookupAdjustment,
  MAX_NUDGE, MIN_SAMPLES,
} from "../src/decision-engine/learning.js";
import { scoreOption, scoreAll } from "../src/decision-engine/scoring.js";
import { generateOptions } from "../src/decision-engine/options.js";

// ── Helpers ─────────────────────────────────────────────

function log(dt, ot, status, override = null) {
  return { decision_type: dt, option_type: ot, action_status: status, override_reason: override, result_summary: { option_type: ot } };
}
function fb(dt, ot, type) { return { decision_type: dt, option_type: ot, feedback_type: type }; }

// ── computeEffectiveness ────────────────────────────────

describe("computeEffectiveness", () => {
  it("cold start: below MIN_SAMPLES → zero adjustment", () => {
    const rows = computeEffectiveness([
      log("delay_resolution", "overtime", "applied"),
      log("delay_resolution", "overtime", "applied"),
    ], []);  // only 2 < 3
    const ot = rows.find((r) => r.option_type === "overtime");
    assert.equal(ot.sample_size, 2);
    assert.equal(ot.adjustment, 0);
    assert.match(ot.reason, /样本不足/);
  });

  it("high success → positive bounded nudge", () => {
    const rows = computeEffectiveness([
      log("delay_resolution", "overtime", "applied"),
      log("delay_resolution", "overtime", "applied"),
      log("delay_resolution", "overtime", "applied"),
      log("delay_resolution", "overtime", "partial"),
    ], [fb("delay_resolution", "overtime", "helpful")]);
    const ot = rows.find((r) => r.option_type === "overtime");
    assert.ok(ot.sample_size >= MIN_SAMPLES);
    assert.ok(ot.adjustment > 0);
    assert.ok(ot.adjustment <= MAX_NUDGE);
    assert.equal(ot.exec_success_rate, 1);   // 4 applied/partial, 0 failed
  });

  it("repeated failures → negative bounded nudge", () => {
    const rows = computeEffectiveness([
      log("delay_resolution", "split_order", "failed"),
      log("delay_resolution", "split_order", "failed"),
      log("delay_resolution", "split_order", "failed"),
      log("delay_resolution", "split_order", "applied"),
    ], [fb("delay_resolution", "split_order", "not_helpful")]);
    const ot = rows.find((r) => r.option_type === "split_order");
    assert.ok(ot.adjustment < 0);
    assert.ok(ot.adjustment >= -MAX_NUDGE);
  });

  it("adjustment never exceeds ±MAX_NUDGE even with perfect/awful history", () => {
    const perfect = computeEffectiveness(
      Array.from({ length: 20 }, () => log("d", "overtime", "applied")),
      Array.from({ length: 20 }, () => fb("d", "overtime", "helpful")),
    ).find((r) => r.option_type === "overtime");
    assert.equal(perfect.adjustment, MAX_NUDGE);

    const awful = computeEffectiveness(
      Array.from({ length: 20 }, () => log("d", "overtime", "failed")),
      Array.from({ length: 20 }, () => fb("d", "overtime", "wrong_recommendation")),
    ).find((r) => r.option_type === "overtime");
    assert.equal(awful.adjustment, -MAX_NUDGE);
  });

  it("neutral history (no exec, no feedback) → no nudge", () => {
    const rows = computeEffectiveness([
      log("d", "keep_current", "dismissed"),
      log("d", "keep_current", "dismissed"),
      log("d", "keep_current", "dismissed"),
    ], []);
    const ot = rows.find((r) => r.option_type === "keep_current");
    assert.equal(ot.exec_success_rate, 0.5);   // no applied/failed
    assert.equal(ot.feedback_ratio, 0.5);
    assert.equal(ot.adjustment, 0);
  });

  it("counts overrides", () => {
    const rows = computeEffectiveness([
      log("d", "overtime", "applied", "chosen over recommendation"),
      log("d", "overtime", "applied"),
      log("d", "overtime", "applied"),
    ], []);
    const ot = rows.find((r) => r.option_type === "overtime");
    assert.equal(ot.override_in_count, 1);
  });

  it("deterministic — same input twice → identical rows", () => {
    const input = [log("d", "overtime", "applied"), log("d", "overtime", "failed"), log("d", "overtime", "applied")];
    const a = computeEffectiveness(input, []);
    const b = computeEffectiveness(input, []);
    assert.deepEqual(a, b);
  });

  it("handles null/empty safely", () => {
    assert.deepEqual(computeEffectiveness(null, null), []);
    assert.deepEqual(computeEffectiveness([], []), []);
  });
});

// ── buildAdjustmentMap + lookup ─────────────────────────

describe("adjustment map", () => {
  it("keys by decision_type|option_type", () => {
    const rows = [{ decision_type: "delay_resolution", option_type: "overtime", adjustment: 8, reason: "x", sample_size: 5, effectiveness: 0.83 }];
    const m = buildAdjustmentMap(rows);
    const a = lookupAdjustment(m, "delay_resolution", "overtime");
    assert.equal(a.adjustment, 8);
    assert.equal(a.sample_size, 5);
  });
  it("missing key → zero", () => {
    const m = buildAdjustmentMap([]);
    assert.equal(lookupAdjustment(m, "x", "y").adjustment, 0);
    assert.equal(lookupAdjustment(null, "x", "y").adjustment, 0);
  });
});

// ── scoring integration ─────────────────────────────────

describe("scoring with learned adjustment", () => {
  const ctx = {
    subject: { type: "allocation", id: "A1" }, decision_type: "delay_resolution",
    urgency: "high", expected_delay_days: 5, qty: 1000, order_revenue: 50000, gross_margin_pct: 18,
    alternative_factories: [{ id: "F2", name: "B", score: 80 }],
  };

  it("no adjustment map → behaves like pure base (learning=null)", () => {
    const opt = generateOptions("delay_resolution", ctx).find((o) => o.option_type === "overtime");
    const scored = scoreOption(opt, ctx);
    assert.equal(scored.learning, null);
    assert.equal(scored.total_score, scored.base_score);
  });

  it("positive nudge raises total_score and records trace", () => {
    const opt = generateOptions("delay_resolution", ctx).find((o) => o.option_type === "overtime");
    const base = scoreOption(opt, ctx);
    const nudged = scoreOption(opt, ctx, { adjustment: 10, reason: "good history", sample_size: 6 });
    assert.equal(nudged.total_score, Math.min(100, base.base_score + 10));
    assert.ok(nudged.learning);
    assert.equal(nudged.learning.delta, 10);
    assert.equal(nudged.learning.reason, "good history");
  });

  it("nudge is clamped to 0..100", () => {
    const opt = generateOptions("delay_resolution", ctx).find((o) => o.option_type === "keep_current");
    const nudged = scoreOption(opt, ctx, { adjustment: -50, reason: "bad", sample_size: 9 });
    assert.ok(nudged.total_score >= 0);
  });

  it("scoreAll applies map by decision_type|option_type", () => {
    const map = buildAdjustmentMap([
      { decision_type: "delay_resolution", option_type: "split_order", adjustment: 11, reason: "great", sample_size: 8, effectiveness: 0.95 },
    ]);
    const scored = scoreAll(generateOptions("delay_resolution", ctx), ctx, map);
    const split = scored.find((o) => o.option_type === "split_order");
    assert.ok(split.learning);
    assert.equal(split.learning.delta, 11);
    // others get no learning trace
    const keep = scored.find((o) => o.option_type === "keep_current");
    assert.equal(keep.learning, null);
  });

  it("learning can change recommendation but only within bounds", () => {
    // Without learning, reassign/overtime top. Give split_order a big boost +
    // tank reassign; verify split can climb but ordering still reflects base+nudge.
    const map = buildAdjustmentMap([
      { decision_type: "delay_resolution", option_type: "split_order", adjustment: 12, reason: "+", sample_size: 10, effectiveness: 1 },
      { decision_type: "delay_resolution", option_type: "reassign_factory", adjustment: -12, reason: "-", sample_size: 10, effectiveness: 0 },
    ]);
    const baseScored = scoreAll(generateOptions("delay_resolution", ctx), ctx);
    const learnedScored = scoreAll(generateOptions("delay_resolution", ctx), ctx, map);
    const splitBase = baseScored.find((o) => o.option_type === "split_order").total_score;
    const splitLearned = learnedScored.find((o) => o.option_type === "split_order").total_score;
    assert.equal(splitLearned, Math.min(100, splitBase + 12));
  });
});
