/**
 * Anomaly detector + corrector fusion + routing tests
 * Run: node --test backend/tests/anomaly.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runAnomalyDetector, ANOMALY_ROUTING } from "../src/agents/anomaly-detector.js";
import { runCorrector } from "../src/agents/corrector.js";
import { schemas } from "../src/middleware/validate.js";

const ALLOC_A = "11111111-1111-4111-8111-111111111111";
const ALLOC_B = "22222222-2222-4222-8222-222222222222";

function mkReports(allocId, outputs, factoryId = "f1", orderId = "o1") {
  return outputs.map((v, i) => ({
    factory_id: factoryId,
    allocation_id: allocId,
    order_id: orderId,
    actual_output: v,
    date: `2026-04-${String(i + 1).padStart(2, "0")}`,
  }));
}

// ── Detector basics ─────────────────────────────────────

describe("Anomaly Detector — basics", () => {
  it("returns no anomalies when sample is too small", () => {
    const result = runAnomalyDetector({ reports: mkReports(ALLOC_A, [100, 110]) });
    assert.equal(result.anomalies.length, 0);
    assert.equal(result.actions.length, 0);
  });

  it("returns no anomalies on stable production", () => {
    const result = runAnomalyDetector({
      reports: mkReports(ALLOC_A, [100, 102, 98, 101, 99, 100, 103]),
    });
    assert.equal(result.anomalies.length, 0);
  });

  it("ignores flat-line series (std=0)", () => {
    const result = runAnomalyDetector({
      reports: mkReports(ALLOC_A, [100, 100, 100, 100, 100, 100, 100]),
    });
    assert.equal(result.anomalies.length, 0);
  });

  it("handles empty input safely", () => {
    const result = runAnomalyDetector({ reports: [] });
    assert.equal(result.anomalies.length, 0);
    assert.equal(result.stats.reports_scanned, 0);
  });

  it("ignores reports with non-numeric output", () => {
    const reports = [
      ...mkReports(ALLOC_A, [100, 102, 98, 101, 99, 103]),
      { factory_id: "f1", allocation_id: ALLOC_A, actual_output: null, date: "2026-04-07" },
      { factory_id: "f1", allocation_id: ALLOC_A, actual_output: "x", date: "2026-04-08" },
    ];
    const result = runAnomalyDetector({ reports });
    assert.equal(result.anomalies.length, 0);
  });

  it("groups by allocation_id independently", () => {
    const reports = [
      ...mkReports(ALLOC_A, [100, 100, 100, 100, 100, 100, 10]),
      ...mkReports(ALLOC_B, [50, 51, 49, 50, 50, 50, 50], "f2"),
    ];
    const result = runAnomalyDetector({ reports });
    assert.equal(result.anomalies.length, 1);
    assert.equal(result.anomalies[0].key, ALLOC_A);
  });

  it("emits deterministic anomaly id (stable across runs)", () => {
    const reports = mkReports(ALLOC_A, [100, 102, 98, 101, 99, 103, 20]);
    const r1 = runAnomalyDetector({ reports });
    const r2 = runAnomalyDetector({ reports });
    assert.equal(r1.anomalies[0].id, r2.anomalies[0].id);
    assert.match(r1.anomalies[0].id, /^anomaly:/);
  });
});

// ── Action routing per anomaly type ────────────────────

describe("Anomaly Routing", () => {
  it("output_low routes to watchlist + recalc", () => {
    const result = runAnomalyDetector({
      reports: mkReports(ALLOC_A, [100, 102, 98, 101, 99, 103, 20]),
    });
    const a = result.anomalies[0];
    assert.equal(a.type, "output_low");
    assert.equal(a.routing.suggested_action, "watchlist_and_recalc");
    assert.equal(result.actions[0].action_type, "investigate_dip");
    assert.equal(result.actions[0].params.suggested_action, "watchlist_and_recalc");
    assert.equal(result.actions[0].params.anomaly_id, a.id);
  });

  it("output_high routes to mark suspicious + review", () => {
    const result = runAnomalyDetector({
      reports: mkReports(ALLOC_A, [100, 102, 98, 101, 99, 103, 500]),
    });
    const a = result.anomalies[0];
    assert.equal(a.type, "output_high");
    assert.equal(a.routing.suggested_action, "mark_suspicious_review");
    assert.equal(result.actions[0].action_type, "verify_data");
  });

  it("persistent_dip routes to incident escalation", () => {
    const result = runAnomalyDetector({
      reports: mkReports(ALLOC_A, [120, 130, 125, 115, 110, 95, 90, 92]),
    });
    const dip = result.anomalies.find((a) => a.type === "persistent_dip");
    assert.ok(dip);
    assert.equal(dip.routing.suggested_action, "create_incident_or_escalate");
    const action = result.actions.find((act) => act.params.anomaly_id === dip.id);
    assert.equal(action.action_type, "investigate_trend");
  });

  it("severity escalates with z-score magnitude", () => {
    // Long stable history then a massive drop → critical
    const big = runAnomalyDetector({
      reports: mkReports(ALLOC_A, [100, 101, 99, 100, 102, 98, 100, 101, 99, 100, 102, 98, 100, 0]),
    });
    assert.ok(big.anomalies.length > 0);
    assert.ok(["critical", "high"].includes(big.anomalies[0].severity), `got severity=${big.anomalies[0].severity}, z=${big.anomalies[0].z_score}`);

    // Mild drop → medium
    const small = runAnomalyDetector({
      reports: mkReports(ALLOC_A, [100, 105, 95, 100, 105, 95, 70]),
    });
    assert.ok(["medium", "high"].includes(small.anomalies[0].severity));
  });

  it("ANOMALY_ROUTING table is the single source of truth", () => {
    assert.equal(ANOMALY_ROUTING.output_low.suggested_action, "watchlist_and_recalc");
    assert.equal(ANOMALY_ROUTING.output_high.suggested_action, "mark_suspicious_review");
    assert.equal(ANOMALY_ROUTING.persistent_dip.suggested_action, "create_incident_or_escalate");
  });
});

// ── Corrector fusion (deviation × anomaly) ─────────────

describe("Corrector × Anomaly fusion", () => {
  it("boosts confidence when deviation + output_low agree on same allocation", () => {
    const reports = mkReports(ALLOC_A, [100, 100, 100, 100, 100, 100, 20]);
    const allocations = [{ id: ALLOC_A, status: "in_progress", planned_start_date: "2026-04-01", order_id: "ORD-1" }];
    const corrections = [{
      allocation_id: ALLOC_A,
      order_id: "ORD-1",
      risk_status: "falling_behind",
      deviation_pct: -15,
      estimated_end_date: "2026-05-10",
      actual_cumulative: 600,
      planned_cumulative: 700,
    }];

    const baseline = runCorrector({
      reports: [],
      allocations,
      corrections,
    });
    const fused = runCorrector({ reports, allocations, corrections });

    const baseAdjust = baseline.actions.find((a) => a.action_type === "adjust_plan");
    const fusedAdjust = fused.actions.find((a) => a.action_type === "adjust_plan");
    assert.ok(fusedAdjust.confidence > baseAdjust.confidence);
    assert.equal(fusedAdjust.params.anomaly_corroborated, true);
    assert.match(fusedAdjust.summary, /统计验证/);
  });

  it("emits early-warning action when only anomaly exists (no deviation)", () => {
    const reports = mkReports(ALLOC_A, [100, 100, 100, 100, 100, 100, 20]);
    const allocations = [{ id: ALLOC_A, status: "in_progress", planned_start_date: "2026-04-01", order_id: "ORD-1" }];
    // No corrections → plan still nominally on track
    const result = runCorrector({ reports, allocations, corrections: [] });

    const warning = result.actions.find((a) => a.params?.early_warning === true);
    assert.ok(warning, "expected an early-warning action");
    assert.match(warning.summary, /早期预警/);
    assert.equal(result.stats.early_warnings, 1);
  });

  it("flags output_high as data-quality issue, not schedule escalation", () => {
    const reports = mkReports(ALLOC_A, [100, 100, 100, 100, 100, 100, 500]);
    const allocations = [{ id: ALLOC_A, status: "in_progress", planned_start_date: "2026-04-01", order_id: "ORD-1" }];
    const result = runCorrector({ reports, allocations, corrections: [] });

    const verify = result.actions.find((a) => a.action_type === "verify_data");
    assert.ok(verify, "expected a verify_data action for output_high");
    assert.equal(verify.target_type, "report");
    assert.equal(verify.params.suggested_action, "mark_suspicious_review");
    assert.equal(result.stats.data_quality_flags, 1);
  });

  it("returns empty anomaly stats when reports are stable", () => {
    const reports = mkReports(ALLOC_A, [100, 102, 98, 101, 99, 100, 103]);
    const result = runCorrector({ reports, allocations: [], corrections: [] });
    assert.equal(result.stats.anomalies_found, 0);
    assert.equal(result.stats.early_warnings, 0);
    assert.equal(result.stats.data_quality_flags, 0);
  });
});

// ── Review schema validation ───────────────────────────

describe("Anomaly review schema", () => {
  it("accepts a valid confirmed_real_issue review", () => {
    const result = schemas.reviewAnomaly.safeParse({
      review_reason: "confirmed_real_issue",
      snapshot: {
        anomaly_type: "output_low",
        allocation_id: ALLOC_A,
        report_date: "2026-04-15",
        z_score: -2.8,
        actual_output: 20,
      },
    });
    assert.ok(result.success);
  });

  it("rejects an unknown review reason", () => {
    const result = schemas.reviewAnomaly.safeParse({
      review_reason: "alien_invasion",
      snapshot: { anomaly_type: "output_low" },
    });
    assert.ok(!result.success);
  });

  it("rejects an unknown anomaly type in snapshot", () => {
    const result = schemas.reviewAnomaly.safeParse({
      review_reason: "ignored",
      snapshot: { anomaly_type: "weird" },
    });
    assert.ok(!result.success);
  });

  it("accepts data_entry_error review (false positive path)", () => {
    const result = schemas.reviewAnomaly.safeParse({
      review_reason: "data_entry_error",
      snapshot: { anomaly_type: "output_high", severity: "high" },
      notes: "Operator typed 500 instead of 50",
    });
    assert.ok(result.success);
  });
});
