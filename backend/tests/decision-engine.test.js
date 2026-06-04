/**
 * Decision Engine tests — pure modules (options + scoring + index).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { generateOptions } from "../src/decision-engine/options.js";
import { scoreAll, scoreOption, pickRecommendation } from "../src/decision-engine/scoring.js";
import { assembleDecision, DECISION_TYPES } from "../src/decision-engine/index.js";
import { schemas } from "../src/middleware/validate.js";

// ── Fixtures ────────────────────────────────────────────

function delayCtx(over = {}) {
  return {
    subject: { type: "allocation", id: "A1" },
    decision_type: "delay_resolution",
    urgency: "high",
    risk_score: 75,
    expected_delay_days: 5,
    qty: 1000,
    order_revenue: 50000,
    gross_margin_pct: 18,
    affected_orders: ["ORD-1"],
    alternative_factories: [{ id: "F2", name: "工厂B", score: 82, affected_orders: ["ORD-9", "ORD-10"] }],
    alternative_lines: [{ id: "L2", name: "二线" }],
    ...over,
  };
}

// ── Option generation ───────────────────────────────────

describe("options — delay", () => {
  it("generates multiple distinct options including keep_current", () => {
    const opts = generateOptions("delay_resolution", delayCtx());
    const types = opts.map((o) => o.option_type);
    assert.ok(opts.length >= 4, `expected ≥4 options, got ${opts.length}`);
    assert.ok(types.includes("keep_current"));
    assert.ok(types.includes("overtime"));
    assert.ok(types.includes("reassign_factory"));
    assert.ok(types.includes("split_order"));
  });

  it("keep_current has zero cost and no delay reduction", () => {
    const keep = generateOptions("delay_resolution", delayCtx()).find((o) => o.option_type === "keep_current");
    assert.equal(keep.impact.cost_delta, 0);
    assert.equal(keep.impact.delay_days_delta, 0);
  });

  it("reassign_factory fully removes the delay", () => {
    const ra = generateOptions("delay_resolution", delayCtx()).find((o) => o.option_type === "reassign_factory");
    assert.equal(ra.impact.delay_days_delta, -5);
    assert.deepEqual(ra.impact.affected_orders, ["ORD-9", "ORD-10"]);
  });

  it("every option has required_actions + reasoning", () => {
    for (const o of generateOptions("delay_resolution", delayCtx())) {
      assert.ok(Array.isArray(o.required_actions) && o.required_actions.length > 0, `${o.option_type} has no actions`);
      assert.ok(Array.isArray(o.reasoning) && o.reasoning.length > 0, `${o.option_type} has no reasoning`);
    }
  });

  it("option ids are stable across calls (deterministic)", () => {
    const a = generateOptions("delay_resolution", delayCtx()).map((o) => o.id);
    const b = generateOptions("delay_resolution", delayCtx()).map((o) => o.id);
    assert.deepEqual(a, b);
  });
});

describe("options — material shortage", () => {
  const ctx = {
    subject: { type: "order", id: "O1" }, decision_type: "material_shortage_resolution",
    urgency: "high", material_eta_days: 4, order_revenue: 40000, gross_margin_pct: 15,
    has_substitute: true, partial_available: true,
  };
  it("offers wait / expedite / substitute / partial", () => {
    const types = generateOptions("material_shortage_resolution", ctx).map((o) => o.option_type);
    assert.ok(types.includes("keep_current"));
    assert.ok(types.includes("expedite_material"));
    assert.ok(types.includes("substitute_material"));
    assert.ok(types.includes("partial_start"));
  });
  it("hides substitute when none available", () => {
    const types = generateOptions("material_shortage_resolution", { ...ctx, has_substitute: false }).map((o) => o.option_type);
    assert.ok(!types.includes("substitute_material"));
  });
});

describe("options — QC / rework", () => {
  const ctx = {
    subject: { type: "order", id: "O1" }, decision_type: "qc_rework_resolution",
    urgency: "high", rework_qty: 500, qty: 500, defect_rate_pct: 12,
  };
  it("offers full rework / partial rework / add final check", () => {
    const titles = generateOptions("qc_rework_resolution", ctx).map((o) => o.title);
    assert.ok(titles.some((t) => t.includes("整批返工")));
    assert.ok(titles.some((t) => t.includes("部分返工")));
    assert.ok(titles.some((t) => t.includes("终检")));
  });
});

describe("options — vip + disruption", () => {
  it("vip offers line insert + overtime", () => {
    const types = generateOptions("vip_insertion", {
      subject: { type: "order", id: "VIP" }, decision_type: "vip_insertion", urgency: "critical",
      alternative_lines: [{ id: "L2", name: "二线" }],
    }).map((o) => o.option_type);
    assert.ok(types.includes("reassign_line"));
    assert.ok(types.includes("overtime"));
  });
  it("disruption offers line move + factory move + incident", () => {
    const opts = generateOptions("line_disruption_resolution", {
      subject: { type: "line", id: "L1" }, decision_type: "line_disruption_resolution", urgency: "critical",
      expected_delay_days: 3, qty: 800,
      alternative_lines: [{ id: "L2", name: "二线" }],
      alternative_factories: [{ id: "F2", name: "工厂B", score: 80 }],
    });
    const types = opts.map((o) => o.option_type);
    assert.ok(types.includes("reassign_line"));
    assert.ok(types.includes("reassign_factory"));
    assert.ok(opts.some((o) => o.required_actions.some((a) => a.action_type === "create_incident")));
  });
});

// ── Scoring ─────────────────────────────────────────────

describe("scoring", () => {
  it("prefers lower delay when cost is acceptable (reassign > overtime > split > keep)", () => {
    const scored = scoreAll(generateOptions("delay_resolution", delayCtx()), delayCtx());
    const byType = Object.fromEntries(scored.map((o) => [o.option_type, o.total_score]));
    assert.ok(byType.reassign_factory > byType.keep_current);
    assert.ok(byType.overtime > byType.keep_current);
    assert.ok(byType.split_order > byType.keep_current);
    // reassign (delay→0) should be the top action
    const top = scored[0];
    assert.ok(["reassign_factory", "overtime"].includes(top.option_type), `top was ${top.option_type}`);
  });

  it("keep_current is penalized when there is real delay", () => {
    const ctx = delayCtx();
    const keep = scoreOption(generateOptions("delay_resolution", ctx).find((o) => o.option_type === "keep_current"), ctx);
    const ot = scoreOption(generateOptions("delay_resolution", ctx).find((o) => o.option_type === "overtime"), ctx);
    assert.ok(keep.total_score < ot.total_score);
  });

  it("all sub-scores are 0..100 and confidence 0..1", () => {
    for (const o of scoreAll(generateOptions("delay_resolution", delayCtx()), delayCtx())) {
      for (const k of ["feasibility_score", "risk_score", "cost_score", "total_score"]) {
        assert.ok(o[k] >= 0 && o[k] <= 100, `${o.option_type}.${k}=${o[k]}`);
      }
      assert.ok(o.confidence_score >= 0 && o.confidence_score <= 1);
    }
  });

  it("pickRecommendation returns a real option id + reason", () => {
    const scored = scoreAll(generateOptions("delay_resolution", delayCtx()), delayCtx());
    const rec = pickRecommendation(scored);
    assert.ok(scored.some((o) => o.id === rec.recommended_option_id));
    assert.match(rec.recommendation_reason, /推荐/);
  });

  it("recommends an action over do-nothing when delay exists", () => {
    const scored = scoreAll(generateOptions("delay_resolution", delayCtx()), delayCtx());
    const rec = pickRecommendation(scored);
    const recOpt = scored.find((o) => o.id === rec.recommended_option_id);
    assert.notEqual(recOpt.option_type, "keep_current");
  });
});

// ── Assemble ────────────────────────────────────────────

describe("assembleDecision", () => {
  it("produces a full canonical assessment", () => {
    const a = assembleDecision(delayCtx(), { now: new Date("2026-06-08T00:00:00Z") });
    assert.equal(a.subject.type, "allocation");
    assert.equal(a.decision_type, "delay_resolution");
    assert.ok(a.options.length >= 4);
    assert.ok(a.recommended_option_id);
    assert.ok(a.current_state.summary.length > 0);
    assert.equal(a.current_state.expected_delay_days, 5);
    assert.equal(a.computed_at, "2026-06-08T00:00:00.000Z");
  });

  it("if_no_action mirrors the keep_current baseline", () => {
    const a = assembleDecision(delayCtx());
    assert.equal(a.if_no_action.expected_delay_days, 5);
    assert.equal(a.if_no_action.customer_risk, "high");      // delay 5 >= 3
    assert.equal(a.if_no_action.escalation_risk, "high");    // delay >= 5
    assert.ok(a.if_no_action.margin_loss > 0);
  });

  it("options are sorted by total_score desc", () => {
    const a = assembleDecision(delayCtx());
    for (let i = 1; i < a.options.length; i++) {
      assert.ok(a.options[i - 1].total_score >= a.options[i].total_score);
    }
  });

  it("deterministic — same context yields same options + recommendation", () => {
    const t = new Date("2026-06-08T00:00:00Z");
    const a = assembleDecision(delayCtx(), { now: t });
    const b = assembleDecision(delayCtx(), { now: t });
    assert.deepEqual(a.options.map((o) => [o.id, o.total_score]), b.options.map((o) => [o.id, o.total_score]));
    assert.equal(a.recommended_option_id, b.recommended_option_id);
  });

  it("null/empty-safe: minimal context does not throw", () => {
    const a = assembleDecision({ subject: { type: "order", id: "x" }, decision_type: "delay_resolution" });
    assert.ok(a.options.length >= 1);          // at least keep_current
    assert.equal(a.current_state.expected_delay_days, 0);
    assert.equal(a.if_no_action.customer_risk, "low");
  });

  it("covers all 5 decision types without throwing", () => {
    for (const dt of DECISION_TYPES) {
      const a = assembleDecision({ subject: { type: "order", id: "x" }, decision_type: dt, expected_delay_days: 3, material_eta_days: 4, rework_qty: 100, qty: 300, has_substitute: true, partial_available: true, alternative_lines: [{ id: "L2", name: "x" }], alternative_factories: [{ id: "F2", name: "y", score: 70 }] });
      assert.ok(a.options.length >= 2, `${dt} produced too few options`);
      assert.ok(a.recommended_option_id, `${dt} has no recommendation`);
    }
  });
});

// ── Schemas ─────────────────────────────────────────────

describe("decision schemas", () => {
  it("evaluateDecision requires a valid subject", () => {
    assert.ok(schemas.evaluateDecision.safeParse({ subject: { type: "order", id: "O1" } }).success);
    assert.ok(!schemas.evaluateDecision.safeParse({ subject: { type: "alien", id: "O1" } }).success);
    assert.ok(!schemas.evaluateDecision.safeParse({ subject: { type: "order" } }).success);
  });
  it("applyDecisionOption defaults mode to apply", () => {
    const r = schemas.applyDecisionOption.safeParse({});
    assert.ok(r.success);
    assert.equal(r.data.mode, "apply");
  });
  it("applyDecisionOption rejects bad mode", () => {
    assert.ok(!schemas.applyDecisionOption.safeParse({ mode: "nuke" }).success);
  });
  it("decisionFeedback validates", () => {
    assert.ok(schemas.decisionFeedback.safeParse({ option_id: "o1", feedback_type: "helpful" }).success);
    assert.ok(!schemas.decisionFeedback.safeParse({ option_id: "o1", feedback_type: "love" }).success);
  });
});
