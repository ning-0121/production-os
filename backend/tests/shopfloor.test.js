/**
 * Shopfloor tests — pure state machine + report builders.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { transition, legalActions, isTerminal, progressPct, ACTION_EVENT } from "../src/shopfloor/state-machine.js";
import {
  outputEvent, outputLineDelta, blockedEvent, blockedLineDelta, blockedTaskDraft, defectEvent,
} from "../src/shopfloor/report-builders.js";
import { schemas } from "../src/middleware/validate.js";

function wo(o = {}) {
  return {
    id: "w1", order_id: "ORD-1", allocation_id: "A1", factory_id: "F1", line_id: "L1",
    operation: "sewing", planned_qty: 1000, completed_qty: 0, defect_qty: 0,
    status: "pending", version: 0, ...o,
  };
}

// ── State machine ───────────────────────────────────────

describe("shopfloor state machine", () => {
  it("pending → in_progress via start, sets actual_start_at", () => {
    const r = transition(wo(), "start", { actor: "lead" });
    assert.equal(r.to, "in_progress");
    assert.ok(r.patch.actual_start_at);
    assert.equal(r.event_type, "start_work");
  });

  it("in_progress → paused → in_progress", () => {
    const p = transition(wo({ status: "in_progress" }), "pause", { actor: "x" });
    assert.equal(p.to, "paused");
    const r = transition(wo({ status: "paused" }), "resume", { actor: "x" });
    assert.equal(r.to, "in_progress");
  });

  it("complete sets actual_end_at + clears block", () => {
    const r = transition(wo({ status: "in_progress" }), "complete", { actor: "x" });
    assert.equal(r.to, "completed");
    assert.ok(r.patch.actual_end_at);
    assert.equal(r.patch.block_reason, null);
  });

  it("block requires a reason", () => {
    assert.throws(() => transition(wo({ status: "in_progress" }), "block", { actor: "x" }), /requires block_reason/);
    const r = transition(wo({ status: "in_progress" }), "block", { actor: "x", block_reason: "material_shortage" });
    assert.equal(r.to, "blocked");
    assert.equal(r.patch.block_reason, "material_shortage");
  });

  it("blocked → in_progress via resume clears reason", () => {
    const r = transition(wo({ status: "blocked", block_reason: "machine_issue" }), "resume", { actor: "x" });
    assert.equal(r.to, "in_progress");
    assert.equal(r.patch.block_reason, null);
  });

  it("rejects illegal transitions", () => {
    assert.throws(() => transition(wo({ status: "pending" }), "complete", {}), /Illegal transition/);
    assert.throws(() => transition(wo({ status: "completed" }), "start", {}), /Illegal transition/);
    assert.throws(() => transition(wo({ status: "pending" }), "pause", {}), /Illegal transition/);
  });

  it("first start preserves an existing actual_start_at", () => {
    const r = transition(wo({ status: "paused", actual_start_at: "2026-06-01T00:00:00Z" }), "resume", {});
    // resume doesn't touch actual_start_at
    assert.equal(r.patch.actual_start_at, undefined);
  });

  it("helpers", () => {
    assert.deepEqual(legalActions("pending").sort(), ["block", "start"]);
    assert.equal(isTerminal("completed"), true);
    assert.equal(isTerminal("blocked"), false);
    assert.equal(progressPct(wo({ planned_qty: 200, completed_qty: 50 })), 25);
    assert.equal(progressPct(wo({ planned_qty: 0, completed_qty: 5 })), 0);   // zero-safe
    assert.equal(progressPct(wo({ planned_qty: 100, completed_qty: 250 })), 100); // capped
    assert.ok(ACTION_EVENT.block === "report_blocked");
  });
});

// ── Report builders ─────────────────────────────────────

describe("output report builders", () => {
  it("outputEvent carries piece_output_updated payload + line/order refs", () => {
    const ev = outputEvent(wo({ completed_qty: 500 }), { output_qty: 200, defect_qty: 0, reported_by: "lead" });
    assert.equal(ev.event_type, "line_status_changed");
    assert.equal(ev.payload.kind, "piece_output_updated");
    assert.equal(ev.payload.output_qty, 200);
    assert.equal(ev.payload.completed_qty, 500);
    assert.equal(ev.line_id, "L1");
    assert.equal(ev.order_id, "ORD-1");
    assert.equal(ev.severity, "info");
  });

  it("very low output flags high severity", () => {
    const ev = outputEvent(wo({ planned_qty: 1000, completed_qty: 50 }), { output_qty: 50 });
    assert.equal(ev.severity, "high");
  });

  it("outputLineDelta sets running + counts", () => {
    const d = outputLineDelta(wo({ completed_qty: 480, planned_qty: 600 }));
    assert.equal(d.runtime_status, "running");
    assert.equal(d.actual_output_today, 480);
    assert.equal(d.expected_output_today, 600);
    assert.equal(d.line_id, "L1");
  });
});

describe("blocked report builders", () => {
  it("material_shortage → critical material_delayed event", () => {
    const ev = blockedEvent(wo(), { reason: "material_shortage", reported_by: "lead" });
    assert.equal(ev.event_type, "material_delayed");
    assert.equal(ev.severity, "critical");
    assert.equal(ev.payload.kind, "work_blocked");
  });

  it("waiting_instruction → high line_slowdown (not critical)", () => {
    const ev = blockedEvent(wo(), { reason: "waiting_instruction" });
    assert.equal(ev.event_type, "line_slowdown");
    assert.equal(ev.severity, "high");
  });

  it("blockedLineDelta marks line blocked", () => {
    assert.equal(blockedLineDelta(wo()).runtime_status, "blocked");
  });

  it("severe block → task draft with idempotent source_ref", () => {
    const draft = blockedTaskDraft(wo(), { reason: "material_shortage" });
    assert.ok(draft);
    assert.equal(draft.category, "material");
    assert.equal(draft.severity, "critical");
    assert.equal(draft.source_ref, "shopfloor_block:w1");
    assert.equal(draft.subject_type, "allocation");
  });

  it("quality block → warn quality task", () => {
    const draft = blockedTaskDraft(wo(), { reason: "quality_issue" });
    assert.equal(draft.category, "quality");
    assert.equal(draft.severity, "warn");
  });

  it("non-severe block → no task", () => {
    assert.equal(blockedTaskDraft(wo(), { reason: "waiting_instruction" }), null);
    assert.equal(blockedTaskDraft(wo(), { reason: "other" }), null);
  });
});

describe("defect report builder", () => {
  it("high defect rate → high severity qc_failure", () => {
    const ev = defectEvent(wo({ planned_qty: 1000 }), { defect_qty: 150 });
    assert.equal(ev.event_type, "qc_failure");
    assert.equal(ev.severity, "high");
    assert.equal(ev.payload.defect_rate_pct, 15);
  });
  it("low defect rate → medium", () => {
    const ev = defectEvent(wo({ planned_qty: 1000 }), { defect_qty: 20 });
    assert.equal(ev.severity, "medium");
  });
});

// ── Schemas ─────────────────────────────────────────────

describe("shopfloor schemas", () => {
  it("reportOutput requires non-negative output", () => {
    assert.ok(schemas.reportOutput.safeParse({ output_qty: 100 }).success);
    assert.ok(schemas.reportOutput.safeParse({ output_qty: 100, defect_qty: 5, note: "ok" }).success);
    assert.ok(!schemas.reportOutput.safeParse({ output_qty: -1 }).success);
    assert.ok(!schemas.reportOutput.safeParse({}).success);
  });
  it("reportBlocked requires a valid reason enum", () => {
    assert.ok(schemas.reportBlocked.safeParse({ reason: "material_shortage" }).success);
    assert.ok(!schemas.reportBlocked.safeParse({ reason: "aliens" }).success);
  });
  it("workOrderTransition validates action", () => {
    assert.ok(schemas.workOrderTransition.safeParse({ action: "start" }).success);
    assert.ok(!schemas.workOrderTransition.safeParse({ action: "explode" }).success);
  });
  it("createWorkOrder defaults planned_qty to 0", () => {
    const r = schemas.createWorkOrder.safeParse({ operation: "sewing" });
    assert.ok(r.success);
    assert.equal(r.data.planned_qty, 0);
  });
});

// ── reportOutput optimistic-concurrency safety (V8 pilot guard) ──
// Regression guard: on a version conflict the count update must fail BEFORE any
// report row or runtime event is written, and the caller must see a conflict —
// never a false success that silently drops the operator's count.

describe("reportOutput conflict safety", () => {
  // Minimal chainable Supabase stub. The versioned UPDATE resolves to `null`
  // (0 rows) to simulate a concurrent update; we assert nothing else was written.
  function makeStub({ wo }) {
    const writes = { reports: 0, events: 0, runtime: 0 };
    function builder(table) {
      let mode = "select";
      const b = {
        select() { return b; },
        update() { mode = "update"; return b; },
        eq() { return b; },
        insert() {
          if (table === "shopfloor_reports") writes.reports++;
          else if (table === "shopfloor_events") writes.events++;
          else writes.runtime++;
          return Promise.resolve({ data: null, error: null });
        },
        maybeSingle() {
          if (table === "shopfloor_work_orders" && mode === "select") {
            return Promise.resolve({ data: wo, error: null });
          }
          if (table === "shopfloor_work_orders" && mode === "update") {
            return Promise.resolve({ data: null, error: null }); // conflict: 0 rows
          }
          return Promise.resolve({ data: null, error: null });
        },
        single() { return b.maybeSingle(); },
      };
      return b;
    }
    return { from: (t) => builder(t), __writes: writes };
  }

  it("returns {ok:false, conflict:true} and writes nothing on version conflict", async () => {
    process.env.SUPABASE_URL ||= "http://localhost";
    process.env.SUPABASE_SERVICE_KEY ||= "dummy";
    const { reportOutput } = await import("../src/shopfloor/service.js");

    const stub = makeStub({ wo: { id: "wo1", version: 3, status: "in_progress", completed_qty: 10, defect_qty: 0, line_id: "l1" } });
    const res = await reportOutput(stub, "wo1", { output_qty: 50 }, { actor: "tester" });

    assert.equal(res.ok, false);
    assert.equal(res.conflict, true);
    assert.equal(stub.__writes.reports, 0, "no shopfloor_reports row on conflict");
    assert.equal(stub.__writes.events, 0, "no shopfloor_events row on conflict");
    assert.equal(stub.__writes.runtime, 0, "no runtime event on conflict");
  });
});
