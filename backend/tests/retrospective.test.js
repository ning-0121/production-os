/**
 * Retrospective aggregation + insights tests — pure modules.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { aggregate } from "../src/retrospective/aggregate.js";
import { generateInsights } from "../src/retrospective/insights.js";

const NOW = new Date("2026-06-08T00:00:00Z");
const daysAgo = (d) => new Date(NOW.getTime() - d * 86400000).toISOString();

function task(o = {}) {
  return {
    id: o.id ?? Math.random().toString(36).slice(2),
    title: "t", category: "general", severity: "warn", status: "open",
    owner: null, source_type: "manual", subject_type: null, subject_id: null,
    escalation_level: 0, due_at: null, created_at: daysAgo(1), resolved_at: null,
    ...o,
  };
}

// ── Zero-safety ─────────────────────────────────────────

describe("aggregate — zero-safe on empty/garbage", () => {
  it("empty bundle returns full zero contract", () => {
    const r = aggregate({}, { now: NOW, windowDays: 7 });
    assert.equal(r.summary.total_tasks, 0);
    assert.equal(r.summary.resolved_pct, 0);
    assert.equal(r.summary.avg_resolution_minutes, 0);
    assert.deepEqual(r.root_causes, []);
    assert.deepEqual(r.factories, []);
    assert.deepEqual(r.owners, []);
    assert.equal(r.trends.days.length, 7);
    assert.equal(r.ai_effectiveness.auto_generated, 0);
  });
  it("tolerates null arrays", () => {
    const r = aggregate({ tasks: null, factories: undefined, retrospectives: null }, { now: NOW, windowDays: 7 });
    assert.equal(r.summary.total_tasks, 0);
  });
  it("never divides by zero", () => {
    const r = aggregate({ tasks: [] }, { now: NOW, windowDays: 30 });
    assert.equal(r.summary.ai_completion_rate, 0);
    assert.equal(r.summary.escalation_rate, 0);
    assert.equal(r.trends.days.length, 30);
  });
});

// ── Summary metrics ─────────────────────────────────────

describe("aggregate — summary", () => {
  const tasks = [
    task({ id: "a", status: "resolved", created_at: daysAgo(3), resolved_at: daysAgo(2) }),     // 1 day = 1440 min
    task({ id: "b", status: "open", due_at: daysAgo(1), created_at: daysAgo(2) }),               // overdue
    task({ id: "c", status: "in_progress", escalation_level: 2, created_at: daysAgo(1) }),       // escalated
    task({ id: "d", status: "dismissed", source_type: "anomaly", created_at: daysAgo(1) }),      // ai + dismissed
    task({ id: "e", status: "resolved", source_type: "runtime_event", created_at: daysAgo(2), resolved_at: daysAgo(1) }), // ai + resolved
  ];

  it("counts statuses + rates correctly", () => {
    const r = aggregate({ tasks }, { now: NOW, windowDays: 7 }).summary;
    assert.equal(r.total_tasks, 5);
    assert.equal(r.resolved_tasks, 2);
    assert.equal(r.dismissed_tasks, 1);
    assert.equal(r.overdue_tasks, 1);
    assert.equal(r.escalation_count, 1);
    assert.equal(r.resolved_pct, 40);
    assert.equal(r.ai_generated_count, 2);          // anomaly + runtime_event
    assert.equal(r.ai_completion_rate, 50);         // 1 of 2 ai resolved
  });

  it("computes avg + median resolution time", () => {
    const r = aggregate({ tasks }, { now: NOW, windowDays: 7 }).summary;
    // task a: 1 day, task e: 1 day → both 1440 min
    assert.equal(r.avg_resolution_minutes, 1440);
    assert.equal(r.median_resolution_minutes, 1440);
  });

  it("prefers retrospective resolution_time_minutes when present", () => {
    const r = aggregate({
      tasks: [task({ id: "x", status: "resolved", created_at: daysAgo(3), resolved_at: daysAgo(1) })],
      retrospectives: [{ task_id: "x", resolution_time_minutes: 30 }],
    }, { now: NOW, windowDays: 7 }).summary;
    assert.equal(r.avg_resolution_minutes, 30);
  });
});

// ── Window splitting / trends ───────────────────────────

describe("aggregate — windows", () => {
  it("excludes tasks outside the current window", () => {
    const tasks = [
      task({ created_at: daysAgo(2) }),     // in 7d window
      task({ created_at: daysAgo(20) }),    // outside
    ];
    const r = aggregate({ tasks }, { now: NOW, windowDays: 7 });
    assert.equal(r.summary.total_tasks, 1);
  });
  it("computes total_trend vs previous window", () => {
    const tasks = [
      task({ created_at: daysAgo(1) }), task({ created_at: daysAgo(2) }), task({ created_at: daysAgo(3) }), // 3 current
      task({ created_at: daysAgo(9) }),  // 1 previous
    ];
    const r = aggregate({ tasks }, { now: NOW, windowDays: 7 });
    assert.equal(r.summary.total_tasks, 3);
    assert.equal(r.summary.prev_total_tasks, 1);
    assert.equal(r.summary.total_trend, "up");
  });
});

// ── Factory map ─────────────────────────────────────────

describe("aggregate — factory problem map", () => {
  it("ranks factories by issue count across sources", () => {
    const bundle = {
      tasks: [],
      factories: [{ id: "F1", name: "工厂A" }, { id: "F2", name: "工厂B" }],
      qcInspections: [{ id: "q1", factory_id: "F1", result: "fail", created_at: daysAgo(1) }],
      reworks: [{ id: "r1", factory_id: "F1", created_at: daysAgo(1) }],
      corrections: [{ allocation_id: "a", factory_id: "F2", risk_status: "critical", computed_at: daysAgo(1) }],
      runtimeEvents: [{ id: "e1", factory_id: "F1", severity: "critical", event_type: "factory_shutdown", occurred_at: daysAgo(1) }],
    };
    const r = aggregate(bundle, { now: NOW, windowDays: 7 });
    assert.equal(r.factories[0].factory_id, "F1");
    assert.equal(r.factories[0].factory_name, "工厂A");
    assert.equal(r.factories[0].quality, 1);
    assert.equal(r.factories[0].rework, 1);
    assert.equal(r.factories[0].critical, 1);
    assert.equal(r.factories[0].total, 3);
    const f2 = r.factories.find((f) => f.factory_id === "F2");
    assert.equal(f2.delay, 1);
  });
});

// ── Owners ──────────────────────────────────────────────

describe("aggregate — owner performance", () => {
  it("ranks owners by overdue + flags overload", () => {
    const tasks = [];
    for (let i = 0; i < 6; i++) tasks.push(task({ owner: "zhang", status: "open", due_at: daysAgo(1), created_at: daysAgo(2) }));
    tasks.push(task({ owner: "li", status: "resolved", created_at: daysAgo(2), resolved_at: daysAgo(1) }));
    const r = aggregate({ tasks }, { now: NOW, windowDays: 7 }).owners;
    assert.equal(r[0].owner, "zhang");
    assert.equal(r[0].overdue, 6);
    assert.equal(r[0].overloaded, true);
    const li = r.find((o) => o.owner === "li");
    assert.equal(li.resolved, 1);
    assert.equal(li.overloaded, false);
  });
});

// ── AI effectiveness ────────────────────────────────────

describe("aggregate — AI effectiveness", () => {
  it("computes completion + false-positive + top sources", () => {
    const tasks = [
      task({ source_type: "anomaly", status: "resolved", created_at: daysAgo(1), resolved_at: daysAgo(1) }),
      task({ source_type: "anomaly", status: "dismissed", created_at: daysAgo(1) }),
      task({ source_type: "runtime_event", status: "dismissed", created_at: daysAgo(1) }),
      task({ source_type: "manual", status: "resolved", created_at: daysAgo(1) }),  // not AI
    ];
    const r = aggregate({ tasks }, { now: NOW, windowDays: 7 }).ai_effectiveness;
    assert.equal(r.auto_generated, 3);
    assert.equal(r.completed, 1);
    assert.equal(r.dismissed, 2);
    assert.equal(r.completion_rate, 33.3);
    assert.ok(r.false_positive_rate > 0);
    assert.equal(r.top_false_positive_sources[0].source, "anomaly"); // anomaly dismissed appears once but ties; both 1 — order stable
  });
});

// ── Repeat issues ───────────────────────────────────────

describe("aggregate — repeat issues", () => {
  it("counts subjects appearing in 2+ tasks", () => {
    const tasks = [
      task({ subject_type: "allocation", subject_id: "A1", created_at: daysAgo(1) }),
      task({ subject_type: "allocation", subject_id: "A1", created_at: daysAgo(2) }),
      task({ subject_type: "allocation", subject_id: "A2", created_at: daysAgo(1) }),
    ];
    const r = aggregate({ tasks }, { now: NOW, windowDays: 7 }).summary;
    assert.equal(r.repeat_issue_count, 1);
  });
});

// ── Insights ────────────────────────────────────────────

describe("generateInsights", () => {
  it("returns a calm card when nothing happened", () => {
    const agg = aggregate({ tasks: [] }, { now: NOW, windowDays: 7 });
    const cards = generateInsights(agg);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].severity, "ok");
  });

  it("flags factory concentration", () => {
    const bundle = {
      tasks: [task({ status: "resolved", created_at: daysAgo(1), resolved_at: daysAgo(1) })],
      factories: [{ id: "F1", name: "工厂A" }],
      qcInspections: [
        { id: "q1", factory_id: "F1", result: "fail", created_at: daysAgo(1) },
        { id: "q2", factory_id: "F1", result: "fail", created_at: daysAgo(1) },
      ],
    };
    const agg = aggregate(bundle, { now: NOW, windowDays: 7 });
    const cards = generateInsights(agg);
    assert.ok(cards.some((c) => c.text.includes("工厂A")));
  });

  it("every card has severity + text", () => {
    const tasks = [
      task({ owner: "zhang", status: "open", due_at: daysAgo(1), created_at: daysAgo(2), category: "quality" }),
      task({ source_type: "anomaly", status: "resolved", created_at: daysAgo(1), resolved_at: daysAgo(1) }),
    ];
    const agg = aggregate({ tasks }, { now: NOW, windowDays: 7 });
    const cards = generateInsights(agg);
    for (const c of cards) {
      assert.ok(["ok", "warn", "critical"].includes(c.severity));
      assert.ok(typeof c.text === "string" && c.text.length > 0);
    }
  });
});
