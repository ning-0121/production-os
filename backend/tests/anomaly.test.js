/**
 * Anomaly Detector tests
 * Run: node --test backend/tests/anomaly.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runAnomalyDetector } from "../src/agents/anomaly-detector.js";

function mkReports(allocId, outputs, factoryId = "f1") {
  return outputs.map((v, i) => ({
    factory_id: factoryId,
    allocation_id: allocId,
    order_id: "o1",
    actual_output: v,
    date: `2026-04-${String(i + 1).padStart(2, "0")}`,
  }));
}

describe("Anomaly Detector", () => {
  it("returns no anomalies when sample is too small", () => {
    const result = runAnomalyDetector({ reports: mkReports("a1", [100, 110]) });
    assert.equal(result.anomalies.length, 0);
    assert.equal(result.actions.length, 0);
    assert.equal(result.stats.groups_with_stats, 0);
  });

  it("returns no anomalies on stable production", () => {
    const result = runAnomalyDetector({
      reports: mkReports("a1", [100, 102, 98, 101, 99, 100, 103]),
    });
    assert.equal(result.anomalies.length, 0);
  });

  it("flags a sharp output drop as low-output anomaly", () => {
    // 6 stable days then a crash to 20
    const result = runAnomalyDetector({
      reports: mkReports("a1", [100, 102, 98, 101, 99, 103, 20]),
    });
    assert.equal(result.anomalies.length, 1);
    assert.equal(result.anomalies[0].type, "output_low");
    assert.ok(result.anomalies[0].z_score < -2);
    assert.equal(result.actions[0].agent, "anomaly-detector");
    assert.equal(result.actions[0].action_type, "investigate_dip");
  });

  it("flags a sharp output spike as high-output anomaly", () => {
    const result = runAnomalyDetector({
      reports: mkReports("a1", [100, 102, 98, 101, 99, 103, 500]),
    });
    assert.equal(result.anomalies.length, 1);
    assert.equal(result.anomalies[0].type, "output_high");
    assert.ok(result.anomalies[0].z_score > 2);
    assert.equal(result.actions[0].action_type, "verify_data");
  });

  it("flags persistent dip when last 3 reports are below mean", () => {
    // High then 3 sub-mean days, but not enough to trigger z>=2
    const result = runAnomalyDetector({
      reports: mkReports("a1", [120, 130, 125, 115, 110, 95, 90, 92]),
    });
    const dip = result.anomalies.find((a) => a.type === "persistent_dip");
    assert.ok(dip, "expected a persistent_dip anomaly");
    assert.equal(dip.window_days, 3);
  });

  it("groups by allocation_id independently", () => {
    const reports = [
      ...mkReports("a1", [100, 100, 100, 100, 100, 100, 10]),
      ...mkReports("a2", [50, 51, 49, 50, 50, 50, 50], "f2"),
    ];
    const result = runAnomalyDetector({ reports });
    assert.equal(result.anomalies.length, 1);
    assert.equal(result.anomalies[0].key, "a1");
  });

  it("ignores flat-line series (std=0)", () => {
    const result = runAnomalyDetector({
      reports: mkReports("a1", [100, 100, 100, 100, 100, 100, 100]),
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
      ...mkReports("a1", [100, 102, 98, 101, 99, 103]),
      { factory_id: "f1", allocation_id: "a1", actual_output: null, date: "2026-04-07" },
      { factory_id: "f1", allocation_id: "a1", actual_output: "x", date: "2026-04-08" },
    ];
    const result = runAnomalyDetector({ reports });
    assert.equal(result.anomalies.length, 0);
  });
});
