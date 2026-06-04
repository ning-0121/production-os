/**
 * Notification builders + cron secret guard tests — pure modules.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildNotification } from "../src/execution/notify.js";
import { isValidCronSecret } from "../src/execution/cron-guard.js";

const task = (o = {}) => ({
  id: "t1", title: "产线B停机", description: "缝纫机故障",
  category: "production_delay", severity: "critical",
  subject_id: "ORD-2026-100", owner: null, created_by: "alex",
  escalation_level: 0, escalated_to: null, due_at: "2026-06-10T00:00:00Z",
  resolution_note: null, ...o,
});

// ════════════════════════════════════════════════════════════
// buildNotification
// ════════════════════════════════════════════════════════════

describe("buildNotification — task_created", () => {
  it("routes unowned tasks to the default queue", () => {
    const n = buildNotification("task_created", task({ owner: null }));
    assert.equal(n.recipient, "production_manager");
    assert.equal(n.kind, "task_created");
    assert.equal(n.dedup_key, "created");
    assert.equal(n.task_id, "t1");
    assert.equal(n.channel, "in_app");
  });
  it("routes owned tasks to the owner", () => {
    const n = buildNotification("task_created", task({ owner: "bob" }));
    assert.equal(n.recipient, "bob");
  });
});

describe("buildNotification — task_due_soon", () => {
  it("returns null when there is no owner to nudge", () => {
    assert.equal(buildNotification("task_due_soon", task({ owner: null })), null);
  });
  it("nudges the owner with a due_soon dedup key", () => {
    const n = buildNotification("task_due_soon", task({ owner: "bob" }));
    assert.equal(n.recipient, "bob");
    assert.equal(n.dedup_key, "due_soon");
  });
});

describe("buildNotification — task_overdue_escalated", () => {
  it("addresses the escalation role with a per-level dedup key", () => {
    const n = buildNotification("task_overdue_escalated", task(), { escalation_level: 2, notify_role: "plant_head" });
    assert.equal(n.recipient, "plant_head");
    assert.equal(n.dedup_key, "esc:L2");
    assert.match(n.title, /L2/);
  });
  it("different levels produce different dedup keys (so each level notifies once)", () => {
    const l1 = buildNotification("task_overdue_escalated", task(), { escalation_level: 1, notify_role: "supervisor" });
    const l2 = buildNotification("task_overdue_escalated", task(), { escalation_level: 2, notify_role: "plant_head" });
    assert.notEqual(l1.dedup_key, l2.dedup_key);
  });
});

describe("buildNotification — task_resolved + reassigned", () => {
  it("resolved notifies owner (or creator fallback)", () => {
    assert.equal(buildNotification("task_resolved", task({ owner: "bob" })).recipient, "bob");
    assert.equal(buildNotification("task_resolved", task({ owner: null, created_by: "alex" })).recipient, "alex");
  });
  it("reassigned notifies the new owner", () => {
    const n = buildNotification("task_reassigned", task(), { new_owner: "carol" });
    assert.equal(n.recipient, "carol");
    assert.match(n.dedup_key, /reassign:carol/);
  });
});

describe("buildNotification — safety", () => {
  it("returns null for unknown kind", () => {
    assert.equal(buildNotification("aliens", task()), null);
  });
  it("returns null for missing task", () => {
    assert.equal(buildNotification("task_created", null), null);
  });
  it("carries severity + metadata", () => {
    const n = buildNotification("task_created", task());
    assert.equal(n.severity, "critical");
    assert.equal(n.metadata.category, "production_delay");
  });
});

// ════════════════════════════════════════════════════════════
// Cron secret guard (idempotency-adjacent: protects the heartbeat)
// ════════════════════════════════════════════════════════════

describe("isValidCronSecret", () => {
  it("accepts a correct secret", () => {
    assert.equal(isValidCronSecret("s3cr3t", "s3cr3t"), true);
  });
  it("rejects a wrong secret", () => {
    assert.equal(isValidCronSecret("nope", "s3cr3t"), false);
  });
  it("rejects when none configured (fail closed)", () => {
    assert.equal(isValidCronSecret("anything", ""), false);
    assert.equal(isValidCronSecret("anything", undefined), false);
  });
  it("rejects missing provided value", () => {
    assert.equal(isValidCronSecret("", "s3cr3t"), false);
    assert.equal(isValidCronSecret(undefined, "s3cr3t"), false);
  });
  it("rejects length mismatch (no partial match)", () => {
    assert.equal(isValidCronSecret("s3cr3", "s3cr3t"), false);
    assert.equal(isValidCronSecret("s3cr3tx", "s3cr3t"), false);
  });
});

// ════════════════════════════════════════════════════════════
// Idempotency contract: dedup_key uniqueness per (task, kind)
// ════════════════════════════════════════════════════════════

describe("notification idempotency contract", () => {
  it("same kind+task without level → identical dedup key (single notification)", () => {
    const a = buildNotification("task_created", task());
    const b = buildNotification("task_created", task());
    assert.equal(a.dedup_key, b.dedup_key);
    assert.equal(a.task_id, b.task_id);
    assert.equal(a.kind, b.kind);
    // → identical (task_id, kind, dedup_key) → DB unique index blocks the dup
  });
  it("re-running due_soon for same task yields the same dedup key", () => {
    const a = buildNotification("task_due_soon", task({ owner: "bob" }));
    const b = buildNotification("task_due_soon", task({ owner: "bob" }));
    assert.equal(a.dedup_key, b.dedup_key);
  });
});
