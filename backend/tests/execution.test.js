/**
 * Execution Engine tests — pure modules (state-machine + escalation).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  transition, isTerminal, legalActions, STATUSES, TERMINAL_STATUSES, ACTION_EVENT,
} from "../src/execution/state-machine.js";
import {
  computeEscalation, pickPolicy, sweepEscalations,
} from "../src/execution/escalation.js";
import { schemas } from "../src/middleware/validate.js";

// ════════════════════════════════════════════════════════════
// State machine
// ════════════════════════════════════════════════════════════

describe("state machine — legal transitions", () => {
  it("open → acknowledged via claim", () => {
    const r = transition({ status: "open", owner: null }, "claim", { actor: "alex", owner: "alex" });
    assert.equal(r.to, "acknowledged");
    assert.equal(r.event_type, "claimed");
    assert.equal(r.patch.owner, "alex");
  });

  it("open → in_progress via start (claim+start in one move)", () => {
    const r = transition({ status: "open" }, "start", { actor: "alex" });
    assert.equal(r.to, "in_progress");
  });

  it("in_progress → resolved requires resolution_note", () => {
    assert.throws(() => transition({ status: "in_progress" }, "resolve", { actor: "a" }),
      /requires field 'resolution_note'/);
    const r = transition({ status: "in_progress" }, "resolve", { actor: "a", resolution_note: "加班赶上" });
    assert.equal(r.to, "resolved");
    assert.equal(r.patch.resolution_note, "加班赶上");
    assert.ok(r.patch.resolved_at);
    assert.equal(r.patch.resolved_by, "a");
  });

  it("in_progress → blocked requires blocked_reason", () => {
    assert.throws(() => transition({ status: "in_progress" }, "block", { actor: "a" }),
      /requires field 'blocked_reason'/);
    const r = transition({ status: "in_progress" }, "block", { actor: "a", blocked_reason: "等物料" });
    assert.equal(r.to, "blocked");
    assert.equal(r.patch.blocked_reason, "等物料");
  });

  it("blocked → in_progress via unblock clears reason", () => {
    const r = transition({ status: "blocked" }, "unblock", { actor: "a" });
    assert.equal(r.to, "in_progress");
    assert.equal(r.patch.blocked_reason, null);
  });

  it("dismiss requires dismissed_reason", () => {
    assert.throws(() => transition({ status: "open" }, "dismiss", { actor: "a" }),
      /requires field 'dismissed_reason'/);
    const r = transition({ status: "open" }, "dismiss", { actor: "a", dismissed_reason: "误报" });
    assert.equal(r.to, "dismissed");
  });

  it("resolved → in_progress via reopen", () => {
    const r = transition({ status: "resolved" }, "reopen", { actor: "a" });
    assert.equal(r.to, "in_progress");
    assert.equal(r.patch.resolved_at, null);
    assert.equal(r.patch.resolution_note, null);
  });

  it("reassign changes owner and logs from/to", () => {
    const r = transition({ status: "in_progress", owner: "alex" }, "reassign", { actor: "boss", owner: "bob" });
    assert.equal(r.patch.owner, "bob");
    assert.equal(r.event.detail.from_owner, "alex");
    assert.equal(r.event.detail.to_owner, "bob");
  });
});

describe("state machine — illegal transitions throw", () => {
  it("cannot resolve from open", () => {
    assert.throws(() => transition({ status: "open" }, "resolve", { resolution_note: "x" }), /Illegal transition/);
  });
  it("cannot block from open", () => {
    assert.throws(() => transition({ status: "open" }, "block", { blocked_reason: "x" }), /Illegal transition/);
  });
  it("cannot claim from resolved", () => {
    assert.throws(() => transition({ status: "resolved" }, "claim", {}), /Illegal transition/);
  });
  it("unknown status throws", () => {
    assert.throws(() => transition({ status: "weird" }, "claim", {}), /Unknown current status/);
  });
});

describe("state machine — helpers", () => {
  it("isTerminal", () => {
    assert.ok(isTerminal("resolved"));
    assert.ok(isTerminal("dismissed"));
    assert.ok(!isTerminal("in_progress"));
  });
  it("legalActions lists transitions", () => {
    assert.deepEqual(legalActions("open").sort(), ["claim", "dismiss", "start"]);
    assert.deepEqual(legalActions("resolved"), ["reopen"]);
  });
  it("ACTION_EVENT maps every action", () => {
    for (const a of ["claim", "start", "block", "unblock", "resolve", "dismiss", "reopen", "reassign"]) {
      assert.ok(ACTION_EVENT[a], `missing event for ${a}`);
    }
  });
  it("STATUSES + TERMINAL_STATUSES are consistent", () => {
    assert.equal(STATUSES.length, 6);
    assert.ok(TERMINAL_STATUSES.has("resolved"));
  });
});

// ════════════════════════════════════════════════════════════
// Escalation
// ════════════════════════════════════════════════════════════

const STEPS = [
  { level: 1, after_minutes: 240, notify_role: "supervisor" },
  { level: 2, after_minutes: 720, notify_role: "plant_head" },
  { level: 3, after_minutes: 1440, notify_role: "vp" },
];

function task(overrides = {}) {
  return {
    id: "t1", status: "in_progress", escalation_level: 0, severity: "warn",
    category: "production_delay",
    due_at: new Date("2026-06-01T00:00:00Z").toISOString(),
    ...overrides,
  };
}

describe("escalation — computeEscalation", () => {
  it("no escalation before deadline", () => {
    const now = new Date("2026-05-31T22:00:00Z"); // before due
    assert.equal(computeEscalation(task(), STEPS, now), null);
  });

  it("no escalation just after deadline (< first step)", () => {
    const now = new Date("2026-06-01T02:00:00Z"); // 2h overdue, step 1 is 4h
    assert.equal(computeEscalation(task(), STEPS, now), null);
  });

  it("escalates to L1 at 4h overdue", () => {
    const now = new Date("2026-06-01T04:30:00Z"); // 4.5h overdue
    const a = computeEscalation(task(), STEPS, now);
    assert.ok(a);
    assert.equal(a.to_level, 1);
    assert.equal(a.notify_role, "supervisor");
  });

  it("jumps straight to L2 if 13h overdue and currently L0", () => {
    const now = new Date("2026-06-01T13:00:00Z"); // 13h overdue → step2(12h) eligible
    const a = computeEscalation(task(), STEPS, now);
    assert.equal(a.to_level, 2);
    assert.equal(a.notify_role, "plant_head");
  });

  it("does not re-escalate to the same level", () => {
    const now = new Date("2026-06-01T05:00:00Z"); // 5h overdue
    const a = computeEscalation(task({ escalation_level: 1 }), STEPS, now);
    assert.equal(a, null); // already L1, next step (L2) not yet due
  });

  it("escalates L1 → L2 when next threshold passes", () => {
    const now = new Date("2026-06-01T13:00:00Z");
    const a = computeEscalation(task({ escalation_level: 1 }), STEPS, now);
    assert.equal(a.to_level, 2);
  });

  it("terminal tasks never escalate", () => {
    const now = new Date("2026-06-02T00:00:00Z");
    assert.equal(computeEscalation(task({ status: "resolved" }), STEPS, now), null);
    assert.equal(computeEscalation(task({ status: "dismissed" }), STEPS, now), null);
  });

  it("tasks without due_at never escalate", () => {
    const now = new Date("2026-06-02T00:00:00Z");
    assert.equal(computeEscalation(task({ due_at: null }), STEPS, now), null);
  });
});

describe("escalation — pickPolicy", () => {
  const policies = [
    { id: "wild", category: null, min_severity: "warn", steps: STEPS, is_active: true },
    { id: "qual", category: "quality", min_severity: null, steps: STEPS, is_active: true },
    { id: "delay-crit", category: "production_delay", min_severity: "critical", steps: STEPS, is_active: true },
    { id: "inactive", category: "production_delay", min_severity: "warn", steps: STEPS, is_active: false },
  ];

  it("prefers most specific (category+severity) match", () => {
    const p = pickPolicy(task({ category: "production_delay", severity: "critical" }), policies);
    assert.equal(p.id, "delay-crit");
  });

  it("category match beats wildcard", () => {
    const p = pickPolicy(task({ category: "quality", severity: "warn" }), policies);
    assert.equal(p.id, "qual");
  });

  it("falls back to wildcard", () => {
    const p = pickPolicy(task({ category: "shipment", severity: "warn" }), policies);
    assert.equal(p.id, "wild");
  });

  it("skips inactive policies", () => {
    const onlyInactive = [{ id: "x", category: "production_delay", min_severity: "warn", steps: STEPS, is_active: false }];
    assert.equal(pickPolicy(task(), onlyInactive), null);
  });

  it("respects min_severity gate", () => {
    const critOnly = [{ id: "c", category: null, min_severity: "critical", steps: STEPS, is_active: true }];
    assert.equal(pickPolicy(task({ severity: "warn" }), critOnly), null);
    assert.ok(pickPolicy(task({ severity: "critical" }), critOnly));
  });
});

describe("escalation — sweepEscalations", () => {
  it("returns actions only for overdue tasks past a new step", () => {
    const policies = [{ id: "p1", category: null, min_severity: "warn", steps: STEPS, is_active: true }];
    const now = new Date("2026-06-01T05:00:00Z"); // 5h overdue
    const tasks = [
      task({ id: "a", escalation_level: 0 }),          // → L1
      task({ id: "b", escalation_level: 1 }),          // already L1, no new step
      task({ id: "c", status: "resolved" }),           // terminal
      task({ id: "d", due_at: null }),                 // no deadline
    ];
    const actions = sweepEscalations(tasks, policies, now);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].task_id, "a");
    assert.equal(actions[0].policy_id, "p1");
  });

  it("empty when no policies", () => {
    const now = new Date("2026-06-02T00:00:00Z");
    assert.deepEqual(sweepEscalations([task()], [], now), []);
  });
});

// ════════════════════════════════════════════════════════════
// Schemas
// ════════════════════════════════════════════════════════════

describe("execution schemas", () => {
  it("createTask accepts a minimal valid task", () => {
    const r = schemas.createTask.safeParse({ title: "产线B停机" });
    assert.ok(r.success);
    assert.equal(r.data.severity, "warn");
    assert.equal(r.data.category, "general");
  });
  it("createTask rejects empty title", () => {
    assert.ok(!schemas.createTask.safeParse({ title: "" }).success);
  });
  it("transitionTask rejects unknown action", () => {
    assert.ok(!schemas.transitionTask.safeParse({ action: "explode" }).success);
  });
  it("transitionTask accepts resolve with note", () => {
    assert.ok(schemas.transitionTask.safeParse({ action: "resolve", resolution_note: "done" }).success);
  });
  it("retrospective rejects bad root_cause", () => {
    assert.ok(!schemas.taskRetrospective.safeParse({ root_cause: "aliens" }).success);
    assert.ok(schemas.taskRetrospective.safeParse({ root_cause: "material_delay" }).success);
  });
  it("setTaskDeadline requires ISO datetime", () => {
    assert.ok(!schemas.setTaskDeadline.safeParse({ due_at: "tomorrow" }).success);
    assert.ok(schemas.setTaskDeadline.safeParse({ due_at: "2026-06-10T00:00:00Z" }).success);
  });
});
