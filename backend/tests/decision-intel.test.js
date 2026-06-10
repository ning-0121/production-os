/**
 * Decision Intelligence aggregation + insights tests — pure modules.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { aggregate } from "../src/decision-intel/aggregate.js";
import { generateInsights } from "../src/decision-intel/insights.js";

const NOW = new Date("2026-06-08T00:00:00Z");
const daysAgo = (d) => new Date(NOW.getTime() - d * 86400000).toISOString();

// Helpers to build rows
function assessment(o = {}) {
  return {
    id: o.id ?? "d1",
    decision_type: o.decision_type ?? "delay_resolution",
    recommended_option_id: o.recommended_option_id ?? "opt_reassign_factory_x",
    confidence_score: o.confidence_score ?? 0.8,
    options: o.options ?? [
      { id: "opt_reassign_factory_x", option_type: "reassign_factory" },
      { id: "opt_overtime_y", option_type: "overtime" },
    ],
    computed_at: o.computed_at ?? daysAgo(1),
  };
}
function log(o = {}) {
  return {
    decision_id: o.decision_id ?? "d1",
    selected_option_id: o.selected_option_id ?? "opt_reassign_factory_x",
    action_status: o.action_status ?? "applied",
    override_reason: o.override_reason ?? null,
    result_summary: o.result_summary ?? { option_type: optType(o.selected_option_id ?? "opt_reassign_factory_x") },
    selected_at: o.selected_at ?? daysAgo(1),
  };
}
function optType(id) {
  return id.includes("reassign_factory") ? "reassign_factory"
    : id.includes("overtime") ? "overtime"
    : id.includes("split_order") ? "split_order" : "keep_current";
}
function fb(o = {}) {
  return { decision_id: o.decision_id ?? "d1", option_id: o.option_id ?? "opt_reassign_factory_x", feedback_type: o.feedback_type ?? "helpful", created_at: o.created_at ?? daysAgo(1) };
}

// ── Zero-safety ─────────────────────────────────────────

describe("intel aggregate — zero-safe", () => {
  it("empty bundle → full zero contract", () => {
    const r = aggregate({}, { now: NOW, windowDays: 7 });
    assert.equal(r.summary.decisions_evaluated, 0);
    assert.equal(r.summary.recommendation_acceptance_rate, 0);
    assert.equal(r.summary.apply_success_rate, 0);
    assert.deepEqual(r.options, []);
    assert.deepEqual(r.overrides, []);
    assert.equal(r.learning.learned_count, 0);
    assert.equal(r.trends.days.length, 7);
  });
  it("null arrays tolerated", () => {
    const r = aggregate({ assessments: null, logs: undefined, feedback: null, learning: null }, { now: NOW, windowDays: 30 });
    assert.equal(r.summary.decisions_evaluated, 0);
    assert.equal(r.trends.days.length, 30);
  });
  it("never divides by zero", () => {
    const r = aggregate({ logs: [] }, { now: NOW, windowDays: 7 });
    assert.equal(r.summary.override_rate, 0);
    assert.equal(r.summary.failed_rate, 0);
  });
});

// ── Acceptance / override ───────────────────────────────

describe("intel aggregate — acceptance & override", () => {
  it("counts accepted when selected == recommended", () => {
    const bundle = {
      assessments: [assessment({ id: "d1" }), assessment({ id: "d2" })],
      logs: [
        log({ decision_id: "d1", selected_option_id: "opt_reassign_factory_x" }), // accepted
        log({ decision_id: "d2", selected_option_id: "opt_overtime_y" }),         // overridden
      ],
    };
    const r = aggregate(bundle, { now: NOW, windowDays: 7 }).summary;
    assert.equal(r.recommendation_acceptance_rate, 50);
    assert.equal(r.override_rate, 50);
  });

  it("apply success rate = applied / (applied+failed)", () => {
    const bundle = {
      assessments: [assessment({ id: "d1" })],
      logs: [
        log({ decision_id: "d1", action_status: "applied" }),
        log({ decision_id: "d1", action_status: "failed" }),
        log({ decision_id: "d1", action_status: "applied" }),
      ],
    };
    const r = aggregate(bundle, { now: NOW, windowDays: 7 }).summary;
    assert.equal(r.decisions_applied, 2);
    assert.equal(r.apply_success_rate, 66.7);
  });

  it("avg confidence over assessments", () => {
    const bundle = { assessments: [assessment({ id: "a", confidence_score: 0.6 }), assessment({ id: "b", confidence_score: 0.9 })] };
    const r = aggregate(bundle, { now: NOW, windowDays: 7 }).summary;
    assert.equal(r.avg_confidence, 0.75);
  });
});

// ── Windows / trend ─────────────────────────────────────

describe("intel aggregate — windows", () => {
  it("acceptance trend vs previous window", () => {
    const bundle = {
      assessments: [assessment({ id: "d1" }), assessment({ id: "p1", computed_at: daysAgo(9) })],
      logs: [
        log({ decision_id: "d1", selected_option_id: "opt_reassign_factory_x", selected_at: daysAgo(1) }), // cur accepted 100%
        log({ decision_id: "p1", selected_option_id: "opt_overtime_y", selected_at: daysAgo(9) }),         // prev overridden 0%
      ],
    };
    const r = aggregate(bundle, { now: NOW, windowDays: 7 }).summary;
    assert.equal(r.recommendation_acceptance_rate, 100);
    assert.equal(r.prev_acceptance_rate, 0);
    assert.equal(r.acceptance_trend, "up");
  });
  it("excludes out-of-window rows", () => {
    const bundle = { assessments: [assessment({ id: "d1", computed_at: daysAgo(2) }), assessment({ id: "old", computed_at: daysAgo(40) })] };
    const r = aggregate(bundle, { now: NOW, windowDays: 7 }).summary;
    assert.equal(r.decisions_evaluated, 1);
  });
});

// ── Option ranking ──────────────────────────────────────

describe("intel aggregate — option ranking", () => {
  it("ranks by selected count + computes success/feedback", () => {
    const bundle = {
      logs: [
        log({ selected_option_id: "opt_reassign_factory_x", action_status: "applied" }),
        log({ selected_option_id: "opt_reassign_factory_x", action_status: "applied" }),
        log({ selected_option_id: "opt_reassign_factory_x", action_status: "failed" }),
        log({ selected_option_id: "opt_overtime_y", action_status: "applied" }),
      ],
      feedback: [fb({ option_id: "opt_reassign_factory_x", feedback_type: "helpful" })],
    };
    const r = aggregate(bundle, { now: NOW, windowDays: 7 }).options;
    assert.equal(r[0].option_type, "reassign_factory");
    assert.equal(r[0].selected, 3);
    assert.equal(r[0].success_rate, 66.7);   // 2 applied / 3 executed
    assert.equal(r[0].helpful, 1);
  });
});

// ── Overrides ───────────────────────────────────────────

describe("intel aggregate — overrides", () => {
  it("computes override rate per recommended option_type", () => {
    const bundle = {
      assessments: [assessment({ id: "d1" }), assessment({ id: "d2" }), assessment({ id: "d3" })],
      logs: [
        log({ decision_id: "d1", selected_option_id: "opt_reassign_factory_x" }),  // accepted
        log({ decision_id: "d2", selected_option_id: "opt_overtime_y" }),          // overridden
        log({ decision_id: "d3", selected_option_id: "opt_overtime_y" }),          // overridden
      ],
    };
    const r = aggregate(bundle, { now: NOW, windowDays: 7 }).overrides;
    const reassign = r.find((o) => o.option_type === "reassign_factory");
    assert.equal(reassign.recommended, 3);
    assert.equal(reassign.overridden, 2);
    assert.equal(reassign.override_rate, 66.7);
  });
});

// ── Learning ────────────────────────────────────────────

describe("intel aggregate — learning", () => {
  it("splits positive/negative adjustments", () => {
    const bundle = {
      learning: [
        { decision_type: "delay_resolution", option_type: "overtime", adjustment: 8, sample_size: 6, effectiveness: 0.83, reason: "+" },
        { decision_type: "delay_resolution", option_type: "split_order", adjustment: -10, sample_size: 5, effectiveness: 0.2, reason: "-" },
        { decision_type: "qc_rework_resolution", option_type: "keep_current", adjustment: 0, sample_size: 1, effectiveness: 0.5, reason: "样本不足" },
      ],
    };
    const r = aggregate(bundle, { now: NOW, windowDays: 7 }).learning;
    assert.equal(r.learned_count, 2);
    assert.equal(r.top_positive[0].option_type, "overtime");
    assert.equal(r.top_negative[0].option_type, "split_order");
  });
});

// ── Feedback ────────────────────────────────────────────

describe("intel aggregate — feedback", () => {
  it("counts types + no-feedback", () => {
    const bundle = {
      logs: [log({ decision_id: "d1" }), log({ decision_id: "d2" })],
      feedback: [fb({ decision_id: "d1", feedback_type: "helpful" }), fb({ decision_id: "d1", feedback_type: "wrong_recommendation" })],
    };
    const r = aggregate(bundle, { now: NOW, windowDays: 7 }).feedback;
    assert.equal(r.helpful, 1);
    assert.equal(r.wrong_recommendation, 1);
    assert.equal(r.total_feedback, 2);
    assert.equal(r.no_feedback, 1);   // d2 has no feedback
  });
});

// ── Insights ────────────────────────────────────────────

describe("intel insights", () => {
  it("calm card when no decisions", () => {
    const agg = aggregate({}, { now: NOW, windowDays: 7 });
    const cards = generateInsights(agg);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].severity, "ok");
  });

  it("emits acceptance + best-option insights", () => {
    const bundle = {
      assessments: Array.from({ length: 4 }, (_, i) => assessment({ id: `d${i}` })),
      logs: [
        log({ decision_id: "d0", selected_option_id: "opt_reassign_factory_x", action_status: "applied" }),
        log({ decision_id: "d1", selected_option_id: "opt_reassign_factory_x", action_status: "applied" }),
        log({ decision_id: "d2", selected_option_id: "opt_reassign_factory_x", action_status: "applied" }),
        log({ decision_id: "d3", selected_option_id: "opt_overtime_y", action_status: "applied" }),
      ],
    };
    const agg = aggregate(bundle, { now: NOW, windowDays: 7 });
    const cards = generateInsights(agg);
    assert.ok(cards.some((c) => c.text.includes("采纳率")));
    assert.ok(cards.every((c) => ["ok", "warn", "critical"].includes(c.severity)));
    assert.ok(cards.every((c) => typeof c.text === "string" && c.text.length > 0));
  });

  it("flags frequently-overridden recommendation", () => {
    const bundle = {
      assessments: Array.from({ length: 4 }, (_, i) => assessment({ id: `d${i}` })),
      logs: Array.from({ length: 4 }, (_, i) => log({ decision_id: `d${i}`, selected_option_id: "opt_overtime_y" })), // all override reassign
    };
    const agg = aggregate(bundle, { now: NOW, windowDays: 7 });
    const cards = generateInsights(agg);
    assert.ok(cards.some((c) => c.text.includes("改选") || c.text.includes("否决")));
  });
});
