/**
 * Auto Task Generation rules tests — pure module.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  deriveTasksFromEvents, deriveTasksFromIncidents,
  deriveTasksFromCorrections, deriveTasksFromQc, deriveAllTasks,
} from "../src/execution/auto-rules.js";

// ── runtime_events ──────────────────────────────────────

describe("deriveTasksFromEvents", () => {
  it("creates a task for a critical taskable event", () => {
    const drafts = deriveTasksFromEvents([
      { id: "e1", event_type: "material_delayed", severity: "critical", order_id: "ORD-1", reasoning: "供应商延期 3 天" },
    ]);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].source_ref, "runtime_event:e1");
    assert.equal(drafts[0].category, "material");
    assert.equal(drafts[0].severity, "critical");
    assert.equal(drafts[0].subject_type, "order");
    assert.equal(drafts[0].subject_id, "ORD-1");
  });

  it("ignores non-taskable event types", () => {
    const drafts = deriveTasksFromEvents([
      { id: "e2", event_type: "reschedule_applied", severity: "critical" },
      { id: "e3", event_type: "simulation_run", severity: "critical" },
    ]);
    assert.equal(drafts.length, 0);
  });

  it("ignores medium/low severity", () => {
    const drafts = deriveTasksFromEvents([
      { id: "e4", event_type: "line_slowdown", severity: "medium" },
      { id: "e5", event_type: "line_slowdown", severity: "low" },
    ]);
    assert.equal(drafts.length, 0);
  });

  it("high severity → critical task (canonical 3-level scale)", () => {
    const drafts = deriveTasksFromEvents([
      { id: "e6", event_type: "line_slowdown", severity: "high", line_id: "L1" },
    ]);
    assert.equal(drafts[0].severity, "critical");
    assert.equal(drafts[0].subject_type, "line");
  });

  it("skips events that already have an active task", () => {
    const drafts = deriveTasksFromEvents(
      [{ id: "e7", event_type: "qc_failure", severity: "critical" }],
      new Set(["runtime_event:e7"]),
    );
    assert.equal(drafts.length, 0);
  });

  it("prefers most specific subject (allocation > line > order > factory)", () => {
    const drafts = deriveTasksFromEvents([
      { id: "e8", event_type: "rework_started", severity: "critical", allocation_id: "A1", line_id: "L1", order_id: "O1", factory_id: "F1" },
    ]);
    assert.equal(drafts[0].subject_type, "allocation");
    assert.equal(drafts[0].subject_id, "A1");
  });
});

// ── incidents ───────────────────────────────────────────

describe("deriveTasksFromIncidents", () => {
  it("creates tasks for open high/critical incidents", () => {
    const drafts = deriveTasksFromIncidents([
      { id: "i1", incident_type: "equipment_failure", severity: "critical", status: "open", description: "缝纫机故障", order_id: "O1" },
    ]);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].source_ref, "incident:i1");
    assert.equal(drafts[0].category, "production_delay");
    assert.equal(drafts[0].severity, "critical");
  });

  it("ignores resolved/closed incidents", () => {
    const drafts = deriveTasksFromIncidents([
      { id: "i2", incident_type: "quality_issue", severity: "critical", status: "resolved", description: "x" },
      { id: "i3", incident_type: "quality_issue", severity: "critical", status: "closed", description: "x" },
    ]);
    assert.equal(drafts.length, 0);
  });

  it("ignores medium/low severity incidents", () => {
    const drafts = deriveTasksFromIncidents([
      { id: "i4", incident_type: "material_delay", severity: "medium", status: "open", description: "x" },
    ]);
    assert.equal(drafts.length, 0);
  });

  it("maps incident_type to category; legacy 'high' → canonical 'critical'", () => {
    const drafts = deriveTasksFromIncidents([
      { id: "i5", incident_type: "material_delay", severity: "high", status: "open", description: "缺料" },
    ]);
    assert.equal(drafts[0].category, "material");
    // 3-level canonical scale: HIGH == critical (only MEDIUM maps to warn)
    assert.equal(drafts[0].severity, "critical");
  });
});

// ── order_corrections ───────────────────────────────────

describe("deriveTasksFromCorrections", () => {
  it("creates task only for critical deviation", () => {
    const drafts = deriveTasksFromCorrections([
      { allocation_id: "A1", order_id: "O1", risk_status: "critical", deviation_pct: -30, estimated_end_date: "2026-06-20" },
      { allocation_id: "A2", order_id: "O2", risk_status: "falling_behind", deviation_pct: -12 },
      { allocation_id: "A3", order_id: "O3", risk_status: "on_track", deviation_pct: 2 },
    ]);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].source_ref, "correction:A1");
    assert.equal(drafts[0].subject_type, "allocation");
    assert.equal(drafts[0].category, "production_delay");
  });

  it("dedups against existing tasks", () => {
    const drafts = deriveTasksFromCorrections(
      [{ allocation_id: "A1", risk_status: "critical", deviation_pct: -30 }],
      new Set(["correction:A1"]),
    );
    assert.equal(drafts.length, 0);
  });
});

// ── qc_inspections ──────────────────────────────────────

describe("deriveTasksFromQc", () => {
  it("creates task for failed inspection", () => {
    const drafts = deriveTasksFromQc([
      { id: "q1", order_id: "O1", inspection_type: "final", result: "fail", total_defects: 20, total_qty_inspected: 200, defect_rate_pct: 10 },
    ]);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].source_ref, "qc:q1");
    assert.equal(drafts[0].category, "quality");
    assert.equal(drafts[0].severity, "critical"); // rate >= 10
  });

  it("lower defect rate → warn", () => {
    const drafts = deriveTasksFromQc([
      { id: "q2", order_id: "O1", result: "fail", defect_rate_pct: 4 },
    ]);
    assert.equal(drafts[0].severity, "warn");
  });

  it("ignores pass / pending / conditional", () => {
    const drafts = deriveTasksFromQc([
      { id: "q3", result: "pass" },
      { id: "q4", result: "pending" },
      { id: "q5", result: "conditional" },
    ]);
    assert.equal(drafts.length, 0);
  });
});

// ── combined ────────────────────────────────────────────

describe("deriveAllTasks", () => {
  it("combines all sources and respects taskedRefs across types", () => {
    const sources = {
      events: [{ id: "e1", event_type: "material_delayed", severity: "critical" }],
      incidents: [{ id: "i1", incident_type: "equipment_failure", severity: "high", status: "open", description: "x" }],
      corrections: [{ allocation_id: "A1", risk_status: "critical", deviation_pct: -30 }],
      inspections: [{ id: "q1", result: "fail", defect_rate_pct: 12 }],
    };
    const all = deriveAllTasks(sources, new Set());
    assert.equal(all.length, 4);

    const filtered = deriveAllTasks(sources, new Set(["runtime_event:e1", "qc:q1"]));
    assert.equal(filtered.length, 2);
    const refs = filtered.map((d) => d.source_ref).sort();
    assert.deepEqual(refs, ["correction:A1", "incident:i1"]);
  });

  it("handles empty/missing sources safely", () => {
    assert.deepEqual(deriveAllTasks({}, new Set()), []);
    assert.deepEqual(deriveAllTasks({ events: null, incidents: undefined }, new Set()), []);
  });
});
