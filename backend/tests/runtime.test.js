/**
 * V5-A Runtime Foundation tests
 *
 * Pure-module coverage:
 *   - graph: build, neighbors, cycle detection
 *   - propagation: BFS, decay, cycles, weight-aware, edge-type filtering
 *   - scheduler: localReschedule (overload/blocked/slowdown), insertEmergency,
 *                simulate, rollback
 *   - events: replay determinism, ordering, handler coverage
 *   - schemas: Zod validation
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildGraph, findNodeByRef, neighborsOut, neighborsIn, findCycles, graphSize } from "../src/runtime/graph.js";
import { propagateImpact, groupImpactedByType } from "../src/runtime/propagation.js";
import { localReschedule, insertEmergency, simulate, rollback, computeRisk } from "../src/runtime/scheduler.js";
import { replay, validateOrder } from "../src/runtime/events.js";
import { schemas } from "../src/middleware/validate.js";

// ── Test fixtures ─────────────────────────────────────────────

const FACTORY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LINE_1 = "11111111-1111-4111-8111-111111111111";
const LINE_2 = "22222222-2222-4222-8222-222222222222";
const ALLOC_X = "33333333-3333-4333-8333-333333333333";
const ALLOC_Y = "44444444-4444-4444-8444-444444444444";
const ALLOC_VIP = "55555555-5555-4555-8555-555555555555";

function n(id, type, ref, attrs = {}) {
  return { id, node_type: type, ref_id: ref, ref_label: ref, attrs };
}
function e(id, from, to, edge_type, weight = 1) {
  return { id, from_node: from, to_node: to, edge_type, weight };
}

function mkRuntimeLine(line_id, overrides = {}) {
  return {
    line_id,
    factory_id: FACTORY_A,
    runtime_status: "running",
    current_efficiency: 1.0,
    actual_output_today: 0,
    expected_output_today: 100,
    overload_pct: 50,
    runtime_risk: "green",
    planned_end_at: null,
    queue: [],
    version: 0,
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════
// Graph
// ════════════════════════════════════════════════════════════

describe("Runtime Graph", () => {
  it("builds adjacency from nodes + edges", () => {
    const nodes = [n("a", "material", "M1"), n("b", "order", "O1"), n("c", "line", "L1")];
    const edges = [e("e1", "a", "b", "requires"), e("e2", "b", "c", "assigned_to")];
    const g = buildGraph(nodes, edges);
    assert.equal(g.nodesById.size, 3);
    assert.equal(neighborsOut(g, "a").length, 1);
    assert.equal(neighborsIn(g, "c").length, 1);
    assert.equal(graphSize(g).edges, 2);
  });

  it("finds nodes by typed ref", () => {
    const g = buildGraph([n("a", "material", "M1")], []);
    assert.ok(findNodeByRef(g, "material", "M1"));
    assert.equal(findNodeByRef(g, "order", "M1"), null);
  });

  it("filters neighbors by edge type", () => {
    const nodes = [n("a", "line", "L1"), n("b", "order", "O1")];
    const edges = [
      e("e1", "a", "b", "assigned_to"),
      e("e2", "a", "b", "blocks"),
    ];
    const g = buildGraph(nodes, edges);
    assert.equal(neighborsOut(g, "a").length, 2);
    assert.equal(neighborsOut(g, "a", "blocks").length, 1);
  });

  it("ignores edges whose endpoints are missing", () => {
    const g = buildGraph([n("a", "line", "L1")], [e("x", "a", "ghost", "assigned_to")]);
    assert.equal(graphSize(g).edges, 0);
  });

  it("detects cycles", () => {
    const g = buildGraph(
      [n("a", "line", "L1"), n("b", "line", "L2")],
      [e("e1", "a", "b", "blocks"), e("e2", "b", "a", "blocks")]
    );
    const cycles = findCycles(g);
    assert.equal(cycles.length, 1);
    assert.equal(cycles[0].length, 2);
  });
});

// ════════════════════════════════════════════════════════════
// Propagation
// ════════════════════════════════════════════════════════════

describe("Constraint Propagation", () => {
  it("propagates from origin through requires chain", () => {
    // material → order → line — all forward-propagating
    const g = buildGraph(
      [n("M", "material", "M1"), n("O", "order", "O1"), n("L", "line", "L1")],
      [e("e1", "M", "O", "requires"), e("e2", "O", "L", "assigned_to")]
    );
    const r = propagateImpact(g, "M", "high");
    assert.equal(r.impacted.length, 2);
    assert.equal(r.impacted[0].node_id, "O");
    assert.equal(r.impacted[0].depth, 1);
    assert.equal(r.impacted[1].node_id, "L");
    assert.equal(r.impacted[1].depth, 2);
    assert.ok(r.impacted[0].impact > r.impacted[1].impact, "impact should decay with depth");
  });

  it("attenuates by edge weight", () => {
    const g = buildGraph(
      [n("A", "material", "M1"), n("B", "order", "O1"), n("C", "order", "O2")],
      [e("e1", "A", "B", "requires", 1.0), e("e2", "A", "C", "requires", 0.3)]
    );
    const r = propagateImpact(g, "A", "high");
    const b = r.impacted.find((x) => x.node_id === "B");
    const c = r.impacted.find((x) => x.node_id === "C");
    assert.ok(b.impact > c.impact, "higher-weight edge produces higher impact");
  });

  it("stops at min_impact threshold", () => {
    // Long chain with low-weight edges → propagation should bail out early
    const nodes = []; const edges = [];
    for (let i = 0; i < 10; i++) {
      nodes.push(n(`n${i}`, "order", `O${i}`));
      if (i > 0) edges.push(e(`e${i}`, `n${i - 1}`, `n${i}`, "downstream_of", 0.6));
    }
    const g = buildGraph(nodes, edges);
    const r = propagateImpact(g, "n0", "low", { min_impact: 0.05 });
    assert.ok(r.impacted.length < 9, "should stop before reaching the end");
    assert.ok(r.stats.stopped_by_threshold > 0);
  });

  it("is cycle-safe (does not infinite-loop)", () => {
    const g = buildGraph(
      [n("a", "line", "L1"), n("b", "line", "L2")],
      [e("e1", "a", "b", "blocks"), e("e2", "b", "a", "blocks")]
    );
    const r = propagateImpact(g, "a", "high");
    assert.equal(r.impacted.length, 1);
    assert.equal(r.impacted[0].node_id, "b");
  });

  it("computes cascading delay days", () => {
    const g = buildGraph(
      [n("M", "material", "M1"), n("O", "order", "O1"), n("L", "line", "L1")],
      [e("e1", "M", "O", "requires", 1.0), e("e2", "O", "L", "blocks", 1.0)]
    );
    const r = propagateImpact(g, "M", "critical", { estimated_delay_days: 5 });
    const order = r.impacted.find((x) => x.node_id === "O");
    const line = r.impacted.find((x) => x.node_id === "L");
    assert.ok(order.estimated_delay_days > 0);
    assert.ok(line.estimated_delay_days > 0);
  });

  it("returns explainable path trace", () => {
    const g = buildGraph(
      [n("M", "material", "M1"), n("O", "order", "O1"), n("L", "line", "L1")],
      [e("e1", "M", "O", "requires"), e("e2", "O", "L", "assigned_to")]
    );
    const r = propagateImpact(g, "M", "high");
    const line = r.impacted.find((x) => x.node_id === "L");
    assert.deepEqual(line.path, ["M", "O", "L"]);
    assert.deepEqual(line.edge_path, ["requires", "assigned_to"]);
    assert.match(line.reasoning, /material/);
  });

  it("groups impacted by node_type", () => {
    const g = buildGraph(
      [n("M", "material", "M1"), n("O1", "order", "OA"), n("O2", "order", "OB"), n("L", "line", "L1")],
      [e("e1", "M", "O1", "requires"), e("e2", "M", "O2", "requires"), e("e3", "O1", "L", "assigned_to")]
    );
    const r = propagateImpact(g, "M", "high");
    const groups = groupImpactedByType(r);
    assert.equal(groups.order.length, 2);
    assert.equal(groups.line.length, 1);
  });

  it("returns empty when origin has no outgoing edges", () => {
    const g = buildGraph([n("a", "order", "O1")], []);
    const r = propagateImpact(g, "a", "high");
    assert.equal(r.impacted.length, 0);
  });

  it("handles unknown origin gracefully", () => {
    const g = buildGraph([n("a", "order", "O1")], []);
    const r = propagateImpact(g, "ghost", "high");
    assert.equal(r.impacted.length, 0);
    assert.match(r.reasoning, /not found/);
  });
});

// ════════════════════════════════════════════════════════════
// Runtime Scheduler — local reschedule
// ════════════════════════════════════════════════════════════

describe("Runtime Scheduler — localReschedule", () => {
  function stateWithTwoLines() {
    return {
      lines: [
        mkRuntimeLine(LINE_1, {
          overload_pct: 120,
          queue: [
            { allocation_id: ALLOC_X, order_id: "OX", priority: 10, qty: 500, due_date: "2026-06-30", locked: false },
            { allocation_id: ALLOC_Y, order_id: "OY", priority: 80, qty: 200, due_date: "2026-05-15", locked: false },
          ],
        }),
        mkRuntimeLine(LINE_2, { overload_pct: 40, queue: [] }),
      ],
    };
  }

  it("shifts lowest-priority allocation when line is overloaded", () => {
    const plan = localReschedule(stateWithTwoLines(), {
      line_id: LINE_1, conflict_type: "overload", delay_days: 2,
    });
    assert.equal(plan.feasible, true);
    assert.equal(plan.moves.length, 1);
    assert.equal(plan.moves[0].type, "shift");
    assert.equal(plan.moves[0].allocation_id, ALLOC_X);
    assert.equal(plan.moves[0].delay_days, 2);
    assert.deepEqual(plan.affected_orders, ["OX"]);
  });

  it("reassigns to peer line when blocked + peer available", () => {
    const plan = localReschedule(stateWithTwoLines(), {
      line_id: LINE_1, conflict_type: "blocked",
    });
    assert.equal(plan.feasible, true);
    assert.equal(plan.moves[0].type, "reassign");
    assert.equal(plan.moves[0].to_line, LINE_2);
    assert.ok(plan.confidence >= 0.85, "reassign should have high confidence");
  });

  it("falls back to shift when blocked + no peer", () => {
    const state = stateWithTwoLines();
    state.lines[1].runtime_status = "down";
    const plan = localReschedule(state, { line_id: LINE_1, conflict_type: "blocked" });
    assert.equal(plan.moves[0].type, "shift");
  });

  it("splits largest allocation on slowdown if peer has room", () => {
    const state = stateWithTwoLines();
    const plan = localReschedule(state, { line_id: LINE_1, conflict_type: "slowdown" });
    assert.equal(plan.moves[0].type, "split");
    assert.equal(plan.moves[0].allocation_id, ALLOC_X);
    assert.equal(plan.moves[0].split_qty, 250);
    assert.equal(plan.moves[0].to_line, LINE_2);
  });

  it("returns no-op for empty queue", () => {
    const state = { lines: [mkRuntimeLine(LINE_1, { queue: [] })] };
    const plan = localReschedule(state, { line_id: LINE_1, conflict_type: "overload" });
    assert.equal(plan.feasible, true);
    assert.equal(plan.moves.length, 0);
  });

  it("respects locked allocations (will not displace)", () => {
    const state = {
      lines: [
        mkRuntimeLine(LINE_1, {
          queue: [{ allocation_id: ALLOC_X, order_id: "OX", priority: 10, qty: 100, due_date: "2026-06-30", locked: true }],
        }),
      ],
    };
    const plan = localReschedule(state, { line_id: LINE_1, conflict_type: "overload" });
    assert.equal(plan.moves.length, 0);
  });

  it("returns infeasible for unknown line", () => {
    const plan = localReschedule({ lines: [] }, { line_id: "ghost", conflict_type: "overload" });
    assert.equal(plan.feasible, false);
  });
});

// ════════════════════════════════════════════════════════════
// Runtime Scheduler — VIP insertion
// ════════════════════════════════════════════════════════════

describe("Runtime Scheduler — insertEmergency", () => {
  it("inserts onto least-loaded line in factory", () => {
    const state = {
      lines: [
        mkRuntimeLine(LINE_1, { overload_pct: 95 }),
        mkRuntimeLine(LINE_2, { overload_pct: 30 }),
      ],
    };
    const plan = insertEmergency(state, {
      allocation_id: ALLOC_VIP, order_id: "VIP1", factory_id: FACTORY_A,
      qty: 100, due_date: "2026-05-10", urgency: "critical",
    });
    assert.equal(plan.feasible, true);
    assert.equal(plan.moves[0].to_line, LINE_2, "should pick less-loaded line");
  });

  it("displaces lower-priority work when target is overloaded", () => {
    const state = {
      lines: [
        mkRuntimeLine(LINE_1, {
          overload_pct: 95,
          queue: [{ allocation_id: ALLOC_X, order_id: "OX", priority: 10, qty: 200, due_date: "2026-06-30" }],
        }),
        mkRuntimeLine(LINE_2, { overload_pct: 40 }),
      ],
    };
    const plan = insertEmergency(state, {
      allocation_id: ALLOC_VIP, order_id: "VIP1", factory_id: FACTORY_A,
      qty: 100, due_date: "2026-05-10", urgency: "critical",
    });
    // The VIP picks the less-loaded line (LINE_2), so no displacement is needed
    assert.equal(plan.moves[0].to_line, LINE_2);
    // But if VIP insists on the loaded line by being the only candidate,
    // displacement should kick in. Let's test that explicitly:
    const stateOneLine = { lines: [state.lines[0]] };
    const plan2 = insertEmergency(stateOneLine, {
      allocation_id: ALLOC_VIP, order_id: "VIP1", factory_id: FACTORY_A,
      qty: 100, due_date: "2026-05-10", urgency: "critical",
    });
    assert.equal(plan2.moves.length, 2, "expected VIP insert + 1 displacement");
    assert.equal(plan2.moves[1].type, "shift");
    assert.deepEqual(plan2.affected_orders.sort(), ["OX", "VIP1"]);
  });

  it("returns infeasible when no candidate line exists", () => {
    const state = { lines: [mkRuntimeLine(LINE_1, { runtime_status: "down" })] };
    const plan = insertEmergency(state, {
      allocation_id: ALLOC_VIP, order_id: "VIP1", factory_id: FACTORY_A,
      qty: 100, due_date: "2026-05-10", urgency: "critical",
    });
    assert.equal(plan.feasible, false);
  });

  it("ignores locked + higher-priority allocations when picking displacement", () => {
    const state = {
      lines: [
        mkRuntimeLine(LINE_1, {
          overload_pct: 95,
          queue: [
            { allocation_id: "lock1", order_id: "OL", priority: 5, qty: 100, due_date: "2026-06-30", locked: true },
            { allocation_id: "high1", order_id: "OH", priority: 99, qty: 100, due_date: "2026-06-30" },
          ],
        }),
      ],
    };
    const plan = insertEmergency(state, {
      allocation_id: ALLOC_VIP, order_id: "VIP1", factory_id: FACTORY_A,
      qty: 100, due_date: "2026-05-10", urgency: "critical",
    });
    // priority defaults to 100 for "critical" — only "lock1" is lower but locked,
    // and "high1" has lower priority (99 < 100) so it can be displaced
    const displace = plan.moves.find((m) => m.allocation_id === "high1");
    assert.ok(displace, "should pick the unlocked lower-priority allocation");
    assert.ok(!plan.moves.some((m) => m.allocation_id === "lock1"));
  });
});

// ════════════════════════════════════════════════════════════
// Simulation
// ════════════════════════════════════════════════════════════

describe("Runtime Scheduler — simulate", () => {
  it("applies a line_slowdown event to a clone (no input mutation)", () => {
    const state = { lines: [mkRuntimeLine(LINE_1, { current_efficiency: 1.0 })] };
    const result = simulate(state, [
      { event_type: "line_slowdown", line_id: LINE_1, payload: { efficiency_factor: 0.5 } },
    ]);
    assert.equal(result.summary.events_applied, 1);
    assert.equal(result.final_state.lines[0].current_efficiency, 0.5);
    // Source state should NOT be mutated
    assert.equal(state.lines[0].current_efficiency, 1.0);
  });

  it("propagates factory_shutdown to all lines in factory", () => {
    const state = {
      lines: [
        mkRuntimeLine(LINE_1),
        mkRuntimeLine(LINE_2),
      ],
    };
    const result = simulate(state, [
      { event_type: "factory_shutdown", payload: { factory_id: FACTORY_A } },
    ]);
    assert.ok(result.final_state.lines.every((l) => l.runtime_status === "down"));
  });

  it("recomputes risk on affected lines", () => {
    const state = { lines: [mkRuntimeLine(LINE_1)] };
    const result = simulate(state, [
      { event_type: "line_slowdown", line_id: LINE_1, payload: { efficiency_factor: 0.3 } },
    ]);
    // Efficiency dropped to 0.3 < 0.7 → risk should be amber or red
    assert.ok(["amber", "red"].includes(result.final_state.lines[0].runtime_risk));
  });

  it("skips unknown event types", () => {
    const state = { lines: [mkRuntimeLine(LINE_1)] };
    const result = simulate(state, [{ event_type: "alien_invasion", line_id: LINE_1 }]);
    assert.equal(result.summary.events_skipped, 1);
    assert.equal(result.summary.events_applied, 0);
  });
});

// ════════════════════════════════════════════════════════════
// Replay determinism
// ════════════════════════════════════════════════════════════

describe("Event Replay", () => {
  it("is deterministic — same events produce same final state", () => {
    const baseline = { lines: [mkRuntimeLine(LINE_1, { current_efficiency: 1.0 })] };
    const events = [
      { replay_seq: 1, event_type: "line_slowdown", line_id: LINE_1, payload: { efficiency_factor: 0.8 }, occurred_at: "2026-04-01" },
      { replay_seq: 2, event_type: "line_slowdown", line_id: LINE_1, payload: { efficiency_factor: 0.9 }, occurred_at: "2026-04-02" },
    ];
    const r1 = replay(events, baseline);
    const r2 = replay(events, baseline);
    assert.deepEqual(r1.final_state.lines[0], r2.final_state.lines[0]);
    assert.ok(Math.abs(r1.final_state.lines[0].current_efficiency - 0.72) < 1e-9);
  });

  it("orders by replay_seq even if events are unsorted", () => {
    const baseline = { lines: [mkRuntimeLine(LINE_1)] };
    const events = [
      { replay_seq: 2, event_type: "line_slowdown", line_id: LINE_1, payload: { efficiency_factor: 0.9 } },
      { replay_seq: 1, event_type: "line_slowdown", line_id: LINE_1, payload: { efficiency_factor: 0.5 } },
    ];
    const result = replay(events, baseline);
    // Either order, the multiplication is commutative, so we just check final value
    assert.ok(Math.abs(result.final_state.lines[0].current_efficiency - 0.45) < 1e-9);
    assert.equal(result.summary.last_seq, 2);
  });

  it("counts unhandled events", () => {
    const baseline = { lines: [mkRuntimeLine(LINE_1)] };
    const events = [{ replay_seq: 1, event_type: "alien_invasion", line_id: LINE_1 }];
    const result = replay(events, baseline);
    assert.equal(result.summary.events_unhandled, 1);
  });

  it("validates strict ordering", () => {
    const ok = validateOrder([{ replay_seq: 1 }, { replay_seq: 2 }, { replay_seq: 3 }]);
    assert.equal(ok.ok, true);
    const bad = validateOrder([{ replay_seq: 2 }, { replay_seq: 1 }]);
    assert.equal(bad.ok, false);
  });

  it("auto-creates line state from events when baseline empty", () => {
    const result = replay(
      [{ replay_seq: 1, event_type: "line_status_changed", line_id: LINE_1, factory_id: FACTORY_A, payload: { to_status: "running" } }],
      { lines: [] }
    );
    assert.equal(result.final_state.lines.length, 1);
    assert.equal(result.final_state.lines[0].runtime_status, "running");
  });

  it("removes completed allocations from queue", () => {
    const baseline = {
      lines: [mkRuntimeLine(LINE_1, {
        current_allocation_id: ALLOC_X,
        current_order_id: "OX",
        queue: [
          { allocation_id: ALLOC_X, order_id: "OX", priority: 50, qty: 100, due_date: "2026-06-30" },
          { allocation_id: ALLOC_Y, order_id: "OY", priority: 50, qty: 100, due_date: "2026-06-30" },
        ],
      })],
    };
    const result = replay(
      [{ replay_seq: 1, event_type: "allocation_completed", line_id: LINE_1, allocation_id: ALLOC_X }],
      baseline
    );
    const line = result.final_state.lines[0];
    assert.equal(line.queue.length, 1);
    assert.equal(line.queue[0].allocation_id, ALLOC_Y);
    assert.equal(line.runtime_status, "idle");
    assert.equal(line.current_allocation_id, null);
  });
});

// ════════════════════════════════════════════════════════════
// Rollback
// ════════════════════════════════════════════════════════════

describe("Runtime Scheduler — rollback", () => {
  it("returns no updates when state matches snapshot", () => {
    const line = mkRuntimeLine(LINE_1);
    const result = rollback({ lines: [line] }, { lines: [{ ...line }] });
    assert.equal(result.line_updates.length, 0);
  });

  it("identifies only changed fields", () => {
    const baseline = mkRuntimeLine(LINE_1, { runtime_status: "running", overload_pct: 50 });
    const current = { ...baseline, runtime_status: "blocked", overload_pct: 50 };
    const result = rollback({ lines: [current] }, { lines: [baseline] });
    assert.equal(result.line_updates.length, 1);
    assert.deepEqual(result.line_updates[0].fields_changed, ["runtime_status"]);
    assert.equal(result.line_updates[0].restored.runtime_status, "running");
  });

  it("ignores lines absent from snapshot", () => {
    const cur = mkRuntimeLine(LINE_1);
    const result = rollback({ lines: [cur] }, { lines: [] });
    assert.equal(result.line_updates.length, 0);
  });
});

// ════════════════════════════════════════════════════════════
// Risk computation
// ════════════════════════════════════════════════════════════

describe("Risk Computation", () => {
  it("maps down → red", () => {
    assert.equal(computeRisk({ runtime_status: "down" }), "red");
  });
  it("maps blocked → red", () => {
    assert.equal(computeRisk({ runtime_status: "blocked" }), "red");
  });
  it("maps overload >110% → red", () => {
    assert.equal(computeRisk({ runtime_status: "running", overload_pct: 115, current_efficiency: 1 }), "red");
  });
  it("maps overload 90-100% → amber", () => {
    assert.equal(computeRisk({ runtime_status: "running", overload_pct: 95, current_efficiency: 1 }), "amber");
  });
  it("maps low efficiency → amber", () => {
    assert.equal(computeRisk({ runtime_status: "running", overload_pct: 50, current_efficiency: 0.5 }), "amber");
  });
  it("maps healthy → green", () => {
    assert.equal(computeRisk({ runtime_status: "running", overload_pct: 60, current_efficiency: 1.0 }), "green");
  });
});

// ════════════════════════════════════════════════════════════
// Schemas
// ════════════════════════════════════════════════════════════

describe("Runtime Zod schemas", () => {
  it("accepts valid event create", () => {
    const r = schemas.runtimeEventCreate.safeParse({
      event_type: "line_slowdown",
      severity: "high",
      line_id: LINE_1,
      payload: { efficiency_factor: 0.8 },
    });
    assert.ok(r.success);
  });

  it("rejects unknown event_type", () => {
    const r = schemas.runtimeEventCreate.safeParse({ event_type: "alien_invasion" });
    assert.ok(!r.success);
  });

  it("rejects invalid severity", () => {
    const r = schemas.runtimeEventCreate.safeParse({ event_type: "line_slowdown", severity: "extreme" });
    assert.ok(!r.success);
  });

  it("validates reschedule input", () => {
    const ok = schemas.runtimeReschedule.safeParse({ line_id: LINE_1, conflict_type: "overload" });
    assert.ok(ok.success);
    const bad = schemas.runtimeReschedule.safeParse({ line_id: "not-a-uuid", conflict_type: "overload" });
    assert.ok(!bad.success);
  });

  it("requires VIP insert essentials", () => {
    const ok = schemas.runtimeInsert.safeParse({
      allocation_id: ALLOC_VIP, order_id: "VIP1", qty: 100, due_date: "2026-05-10",
    });
    assert.ok(ok.success);
    const bad = schemas.runtimeInsert.safeParse({ allocation_id: ALLOC_VIP, qty: -1 });
    assert.ok(!bad.success);
  });

  it("validates simulate event list size", () => {
    const empty = schemas.runtimeSimulate.safeParse({ events: [] });
    assert.ok(!empty.success);
    const ok = schemas.runtimeSimulate.safeParse({
      events: [{ event_type: "line_slowdown" }],
    });
    assert.ok(ok.success);
  });

  it("validates rollback shape", () => {
    const ok = schemas.runtimeRollback.safeParse({ snapshot_id: FACTORY_A, apply: true });
    assert.ok(ok.success);
  });

  it("validates propagate origin_node", () => {
    const ok = schemas.runtimePropagate.safeParse({
      origin_node: { node_type: "material", ref_id: "M1" },
      severity: "high",
    });
    assert.ok(ok.success);
    const bad = schemas.runtimePropagate.safeParse({
      origin_node: { node_type: "weird", ref_id: "M1" },
    });
    assert.ok(!bad.success);
  });
});
