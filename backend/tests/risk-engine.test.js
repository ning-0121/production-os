/**
 * Risk Engine tests — pure modules only (scales / rules / index).
 *
 * Coverage targets:
 *   - Canonical scale: thresholds, color mapping, legacy translation (incl. inverse)
 *   - Rules: each contributes proportionally and produces a readable reason
 *   - Per-subject assessors: end-to-end with synthetic signals
 *   - Edge cases: empty signals, conflicting signals, score capping
 *   - Determinism: same inputs → same outputs every time
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  LEVELS, COLORS, SCORE_THRESHOLDS, SCORE_MAX,
  levelFromScore, colorForLevel, translateLegacy, toLegacy,
} from "../src/risk-engine/scales.js";

import {
  scoreBufferDays, scoreDeviationPct, scoreQcFailures, scoreActiveRework,
  scoreMaterialShortage, scoreRuntimeStatus, scoreOverload, scoreEfficiency,
  scoreFactoryScore, scoreCustomerRisk, scorePaymentOverdue,
  scoreRecentAnomalies, aggregateScore, pickTopReasons,
} from "../src/risk-engine/rules.js";

import {
  assessOrder, assessAllocation, assessLine, assessFactory, assessCustomer,
  assess, SUPPORTED_SUBJECT_TYPES,
} from "../src/risk-engine/index.js";

// ════════════════════════════════════════════════════════════
// Scales
// ════════════════════════════════════════════════════════════

describe("scales — canonical scale shape", () => {
  it("exports exactly the 3 canonical levels in order", () => {
    assert.deepEqual(LEVELS, ["ok", "warn", "critical"]);
  });
  it("each level has a distinct color", () => {
    assert.equal(COLORS.ok, "green");
    assert.equal(COLORS.warn, "amber");
    assert.equal(COLORS.critical, "red");
  });
  it("levelFromScore respects thresholds", () => {
    assert.equal(levelFromScore(0), "ok");
    assert.equal(levelFromScore(SCORE_THRESHOLDS.ok_max), "ok");
    assert.equal(levelFromScore(SCORE_THRESHOLDS.ok_max + 0.1), "warn");
    assert.equal(levelFromScore(SCORE_THRESHOLDS.warn_max), "warn");
    assert.equal(levelFromScore(SCORE_THRESHOLDS.warn_max + 0.1), "critical");
    assert.equal(levelFromScore(SCORE_MAX), "critical");
    assert.equal(levelFromScore(SCORE_MAX + 50), "critical");   // clamp
    assert.equal(levelFromScore(-10), "ok");                     // clamp
    assert.equal(levelFromScore(null), "ok");                    // null safe
  });
  it("colorForLevel matches the table", () => {
    assert.equal(colorForLevel("ok"), "green");
    assert.equal(colorForLevel("warn"), "amber");
    assert.equal(colorForLevel("critical"), "red");
    assert.equal(colorForLevel("unknown"), "green");             // safe fallback
  });
});

describe("scales — legacy enum translation", () => {
  it("translates all legacy enums exhaustively", () => {
    const cases = {
      SAFE: "ok", MEDIUM: "warn", HIGH: "critical",
      on_track: "ok", falling_behind: "warn",
      green: "ok", amber: "warn", red: "critical",
      low: "ok", medium: "warn", high: "critical",
      info: "ok",
      critical: "critical", warn: "warn", ok: "ok",
    };
    for (const [legacy, canonical] of Object.entries(cases)) {
      assert.equal(translateLegacy(legacy), canonical, `${legacy} should map to ${canonical}`);
    }
  });
  it("returns null for unknown legacy values", () => {
    assert.equal(translateLegacy("alien"), null);
    assert.equal(translateLegacy(null), null);
    assert.equal(translateLegacy(undefined), null);
  });
  it("inverse mapping is correct for each target table", () => {
    assert.equal(toLegacy("ok", "runtime_risk"), "green");
    assert.equal(toLegacy("warn", "runtime_risk"), "amber");
    assert.equal(toLegacy("critical", "runtime_risk"), "red");
    assert.equal(toLegacy("ok", "risk_status"), "on_track");
    assert.equal(toLegacy("warn", "risk_status"), "falling_behind");
    assert.equal(toLegacy("critical", "risk_level"), "HIGH");
  });
  it("toLegacy throws on unknown target", () => {
    assert.throws(() => toLegacy("ok", "fake_target"));
  });
});

// ════════════════════════════════════════════════════════════
// Rules
// ════════════════════════════════════════════════════════════

describe("rules — scoreBufferDays", () => {
  it("returns null for non-numeric", () => {
    assert.equal(scoreBufferDays(null), null);
    assert.equal(scoreBufferDays(undefined), null);
    assert.equal(scoreBufferDays("abc"), null);
  });
  it("is graded, not stepped — overdue > very tight > tight > comfortable", () => {
    const overdue = scoreBufferDays(-3);
    const tight = scoreBufferDays(1);
    const moderate = scoreBufferDays(4);
    const comfortable = scoreBufferDays(20);
    assert.ok(overdue.weight > tight.weight);
    assert.ok(tight.weight > moderate.weight);
    assert.ok(comfortable.direction === "lowers" || comfortable.weight === 0);
  });
  it("reason includes the actual number", () => {
    const r = scoreBufferDays(-5);
    assert.match(r.reason, /5/);
  });
});

describe("rules — scoreDeviationPct", () => {
  it("only penalizes when behind", () => {
    const ahead = scoreDeviationPct(15);
    const onPace = scoreDeviationPct(2);
    const slightlyBehind = scoreDeviationPct(-8);
    const veryBehind = scoreDeviationPct(-30);
    assert.equal(ahead.weight, 0);
    assert.equal(onPace.weight, 0);
    assert.ok(slightlyBehind.weight > 0);
    assert.ok(veryBehind.weight > slightlyBehind.weight);
  });
});

describe("rules — runtime + line signals", () => {
  it("runtime_status follows a clear severity ordering", () => {
    const down = scoreRuntimeStatus("down").weight;
    const blocked = scoreRuntimeStatus("blocked").weight;
    const rework = scoreRuntimeStatus("rework").weight;
    const running = scoreRuntimeStatus("running").weight;
    assert.ok(down > blocked);
    assert.ok(blocked > rework);
    assert.equal(running, 0);
  });
  it("overload_pct is graded", () => {
    assert.ok(scoreOverload(125).weight > scoreOverload(110).weight);
    assert.ok(scoreOverload(110).weight > scoreOverload(100).weight);
    assert.equal(scoreOverload(50).weight, 0);
  });
  it("low efficiency penalizes; high efficiency lowers", () => {
    const veryLow = scoreEfficiency(0.4);
    const normal = scoreEfficiency(0.9);
    assert.ok(veryLow.weight > 0);
    assert.equal(normal.direction, "lowers");
  });
});

describe("rules — customer + qc + anomaly", () => {
  it("customer high adds substantial weight", () => {
    assert.ok(scoreCustomerRisk("high").weight >= 50);
    assert.equal(scoreCustomerRisk("low").direction, "lowers");
  });
  it("qc fail count scales", () => {
    assert.ok(scoreQcFailures(3).weight > scoreQcFailures(1).weight);
    assert.equal(scoreQcFailures(0), null);
  });
  it("recent critical anomalies dominate high anomalies", () => {
    const crit = scoreRecentAnomalies([{ severity: "critical" }]);
    const high = scoreRecentAnomalies([{ severity: "high" }]);
    assert.ok(crit.weight > high.weight);
  });
});

describe("rules — aggregation + capping + top reasons", () => {
  it("score is capped at 100 even with many raises", () => {
    const signals = [
      { weight: 50, direction: "raises", reason: "a" },
      { weight: 40, direction: "raises", reason: "b" },
      { weight: 30, direction: "raises", reason: "c" },
    ];
    const { score } = aggregateScore(signals);
    assert.equal(score, 100);
  });
  it("lowers offsets gently — never overrides red", () => {
    const signals = [
      { weight: 80, direction: "raises", reason: "fire" },
      { weight: 200, direction: "lowers", reason: "good factory" }, // huge lower
    ];
    const { score } = aggregateScore(signals);
    // Even with massive "lowers", score should still be > 0 / not -100
    assert.ok(score >= 20);
    assert.ok(score < 80);
  });
  it("pickTopReasons returns highest-weight raises", () => {
    const signals = [
      { weight: 50, direction: "raises", reason: "biggest" },
      { weight: 10, direction: "raises", reason: "smallest" },
      { weight: 30, direction: "raises", reason: "middle" },
      { weight: 100, direction: "lowers", reason: "praise" },
    ];
    const reasons = pickTopReasons(signals, 2);
    assert.deepEqual(reasons, ["biggest", "middle"]);
  });
});

// ════════════════════════════════════════════════════════════
// Per-subject assessors
// ════════════════════════════════════════════════════════════

describe("assessOrder — story coverage", () => {
  it("healthy order is ok/green", () => {
    const r = assessOrder({ id: "ord1" }, {
      buffer_days: 20, deviation_pct: 2, qc_failure_count: 0, active_rework_count: 0,
      customer_risk_level: "low",
    });
    assert.equal(r.level, "ok");
    assert.equal(r.color, "green");
    assert.ok(r.score <= 30);
  });

  it("overdue + behind + qc fails → critical/red", () => {
    const r = assessOrder({ id: "ord2" }, {
      buffer_days: -2, deviation_pct: -25, qc_failure_count: 3,
      active_rework_count: 1, customer_risk_level: "high",
    });
    assert.equal(r.level, "critical");
    assert.equal(r.color, "red");
    assert.ok(r.score >= 70);
    assert.ok(r.top_reasons.length > 0);
  });

  it("borderline → warn/amber", () => {
    const r = assessOrder({ id: "ord3" }, {
      buffer_days: 4, deviation_pct: -12, qc_failure_count: 0,
    });
    assert.equal(r.level, "warn");
    assert.equal(r.color, "amber");
  });

  it("legacy runtime_risk='red' is translated into a contribution", () => {
    const r = assessOrder({ id: "ord4" }, {
      buffer_days: 10, deviation_pct: 0, runtime_risk: "red",
    });
    const sig = r.signals.find((s) => s.kind === "runtime_line_risk");
    assert.ok(sig);
    assert.equal(sig.weight, 25);
  });

  it("never throws on empty signals", () => {
    const r = assessOrder({ id: "ord5" }, {});
    assert.equal(r.level, "ok");
    assert.equal(r.subject.id, "ord5");
  });

  it("is deterministic — same input → same score", () => {
    const input = { id: "x" };
    const sig = { buffer_days: 3, deviation_pct: -8, qc_failure_count: 1 };
    const a = assessOrder(input, sig);
    const b = assessOrder(input, sig);
    assert.equal(a.score, b.score);
    assert.equal(a.level, b.level);
  });
});

describe("assessLine — runtime grading", () => {
  it("down line is critical", () => {
    const r = assessLine({ id: "l1" }, { runtime_status: "down" });
    assert.equal(r.level, "critical");
  });
  it("blocked overloaded line is critical", () => {
    const r = assessLine({ id: "l2" }, {
      runtime_status: "blocked", overload_pct: 130, current_efficiency: 0.5,
    });
    assert.equal(r.level, "critical");
  });
  it("running with good efficiency is ok", () => {
    const r = assessLine({ id: "l3" }, {
      runtime_status: "running", overload_pct: 60, current_efficiency: 0.95,
    });
    assert.equal(r.level, "ok");
  });
});

describe("assessFactory — score-driven grading", () => {
  it("low scores escalate", () => {
    const r = assessFactory({ id: "f1" }, {
      delay_score: 40, quality_score: 50, cooperation_score: 60,
      active_red_lines_count: 2,
    });
    assert.ok(["warn", "critical"].includes(r.level));
  });
  it("high scores stay ok", () => {
    const r = assessFactory({ id: "f2" }, {
      delay_score: 92, quality_score: 95, cooperation_score: 90,
      active_red_lines_count: 0,
    });
    assert.equal(r.level, "ok");
  });
});

describe("assessCustomer", () => {
  it("high risk + payment overdue is critical", () => {
    const r = assessCustomer({ id: "c1" }, { risk_level: "high", payment_overdue_days: 65 });
    assert.equal(r.level, "critical");
  });
});

describe("assessAllocation", () => {
  it("uses runtime + correction signals", () => {
    const r = assessAllocation({ id: "a1" }, {
      buffer_days: 1, deviation_pct: -20,
      runtime_status: "blocked", overload_pct: 105, current_efficiency: 0.6,
    });
    assert.equal(r.level, "critical");
  });
});

// ════════════════════════════════════════════════════════════
// Dispatcher contract
// ════════════════════════════════════════════════════════════

describe("dispatcher", () => {
  it("exports the full list of supported subject types", () => {
    assert.deepEqual(
      [...SUPPORTED_SUBJECT_TYPES].sort(),
      ["allocation", "customer", "factory", "line", "order"],
    );
  });
  it("dispatches by subject_type string", () => {
    const r = assess("order", { id: "o" }, { buffer_days: 10 });
    assert.equal(r.subject.type, "order");
  });
  it("throws on unknown subject_type", () => {
    assert.throws(() => assess("nonsense", { id: "x" }, {}));
  });
  it("every assessment has the canonical envelope shape", () => {
    const r = assess("line", { id: "l" }, { runtime_status: "running" });
    const requiredKeys = ["subject", "level", "score", "color", "signals", "top_reasons", "computed_at"];
    for (const k of requiredKeys) assert.ok(k in r, `missing key ${k}`);
    assert.ok(["ok", "warn", "critical"].includes(r.level));
    assert.ok(["green", "amber", "red"].includes(r.color));
    assert.ok(Array.isArray(r.signals));
    assert.ok(Array.isArray(r.top_reasons));
  });
});
