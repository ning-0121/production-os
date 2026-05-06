/**
 * Runtime Event Engine — pure event derivation + replay.
 *
 * Manufacturing is event-driven. The runtime brain derives state by FOLDING
 * events in `replay_seq` order. Replay is deterministic: same events ⇒ same
 * derived state. This is the foundation for simulation, debugging, and audit.
 */

import { computeRisk } from "./scheduler.js";

const TYPE_HANDLERS = {
  line_status_changed: applyLineStatusChange,
  line_slowdown: applyLineSlowdown,
  factory_shutdown: applyFactoryShutdown,
  material_delayed: applyMaterialDelay,
  rework_started: applyReworkStarted,
  vip_inserted: applyVipInserted,
  qc_failure: applyQcFailure,
  overtime_started: applyOvertimeStarted,
  labor_shortage: applyLaborShortage,
  shipment_risk: applyShipmentRisk,
  allocation_completed: applyAllocationCompleted,
  reschedule_applied: applyReschedule,
  rollback_applied: applyNoop,
  simulation_run: applyNoop,
};

/**
 * Fold an ordered sequence of events into a derived line-state map.
 *
 * @param {Array<RuntimeEvent>} events       must be sorted by replay_seq asc
 * @param {{lines: RuntimeLineState[]}} initialState   baseline (e.g. empty or last snapshot)
 * @returns {{
 *   final_state: {lines: RuntimeLineState[]},
 *   per_event: Array<{seq: number, event_type: string, changes: string[]}>,
 *   summary: { events_processed: number, events_unhandled: number, last_seq: number|null },
 * }}
 */
export function replay(events, initialState = { lines: [] }) {
  const linesById = new Map(initialState.lines.map((l) => [l.line_id, deepCloneLine(l)]));
  const perEvent = [];
  let unhandled = 0;
  let lastSeq = null;

  // Stable order. If replay_seq absent, fall back to occurred_at.
  const ordered = [...events].sort((a, b) => {
    if (a.replay_seq != null && b.replay_seq != null) return Number(a.replay_seq) - Number(b.replay_seq);
    return String(a.occurred_at).localeCompare(String(b.occurred_at));
  });

  for (const ev of ordered) {
    const handler = TYPE_HANDLERS[ev.event_type];
    const changes = [];
    if (handler) {
      handler(linesById, ev, changes);
    } else {
      unhandled++;
      changes.push(`unhandled event_type=${ev.event_type}`);
    }
    // Recompute risk on any line touched
    for (const l of linesById.values()) {
      const newRisk = computeRisk(l);
      if (newRisk !== l.runtime_risk) {
        l.runtime_risk = newRisk;
      }
    }
    perEvent.push({
      seq: ev.replay_seq ?? null,
      event_type: ev.event_type,
      changes,
    });
    lastSeq = ev.replay_seq ?? lastSeq;
  }

  return {
    final_state: { lines: [...linesById.values()] },
    per_event: perEvent,
    summary: {
      events_processed: ordered.length - unhandled,
      events_unhandled: unhandled,
      last_seq: lastSeq,
    },
  };
}

/**
 * Validate event ordering (replay_seq strictly increasing). Returns first
 * out-of-order event, or null if OK.
 */
export function validateOrder(events) {
  let prev = -Infinity;
  for (const ev of events) {
    const s = Number(ev.replay_seq ?? -Infinity);
    if (s <= prev) return { ok: false, offending: ev, prev_seq: prev };
    prev = s;
  }
  return { ok: true };
}

// ── Per-event handlers (mutate linesById, push human-readable change strings) ──

function getOrInitLine(linesById, line_id, init = {}) {
  if (!line_id) return null;
  let line = linesById.get(line_id);
  if (!line) {
    line = {
      line_id,
      factory_id: init.factory_id ?? null,
      runtime_status: "idle",
      current_efficiency: 1.0,
      actual_output_today: 0,
      expected_output_today: 0,
      overload_pct: 0,
      runtime_risk: "green",
      planned_end_at: null,
      queue: [],
      version: 0,
      ...init,
    };
    linesById.set(line_id, line);
  }
  return line;
}

function applyLineStatusChange(linesById, ev, changes) {
  const line = getOrInitLine(linesById, ev.line_id, { factory_id: ev.factory_id });
  if (!line) return;
  const prev = line.runtime_status;
  const next = ev.payload?.to_status;
  if (next) {
    line.runtime_status = next;
    changes.push(`line ${line.line_id}: ${prev} → ${next}`);
  }
}

function applyLineSlowdown(linesById, ev, changes) {
  const line = getOrInitLine(linesById, ev.line_id, { factory_id: ev.factory_id });
  if (!line) return;
  const factor = Number(ev.payload?.efficiency_factor ?? 0.8);
  const prev = line.current_efficiency;
  line.current_efficiency = Math.max(0, prev * factor);
  changes.push(`line ${line.line_id} efficiency ${round2(prev)} × ${factor} = ${round2(line.current_efficiency)}`);
}

function applyFactoryShutdown(linesById, ev, changes) {
  const factoryId = ev.factory_id ?? ev.payload?.factory_id;
  if (!factoryId) return;
  for (const l of linesById.values()) {
    if (l.factory_id === factoryId) {
      l.runtime_status = "down";
      l.current_efficiency = 0;
      changes.push(`line ${l.line_id} → down (factory ${factoryId} shutdown)`);
    }
  }
}

function applyMaterialDelay(linesById, ev, changes) {
  const orderId = ev.order_id ?? ev.payload?.order_id;
  if (!orderId) return;
  for (const l of linesById.values()) {
    if (l.queue?.some((a) => a.order_id === orderId)) {
      l.runtime_status = "blocked";
      changes.push(`line ${l.line_id} blocked: awaiting material for order ${orderId}`);
    }
  }
}

function applyReworkStarted(linesById, ev, changes) {
  const line = getOrInitLine(linesById, ev.line_id, { factory_id: ev.factory_id });
  if (!line) return;
  line.runtime_status = "rework";
  line.current_efficiency *= 0.5;
  changes.push(`line ${line.line_id} → rework, efficiency halved to ${round2(line.current_efficiency)}`);
}

function applyVipInserted(linesById, ev, changes) {
  const line = getOrInitLine(linesById, ev.line_id, { factory_id: ev.factory_id });
  if (!line) return;
  const delta = Number(ev.payload?.overload_delta ?? 15);
  line.overload_pct = (line.overload_pct ?? 0) + delta;
  changes.push(`line ${line.line_id} VIP inserted: overload +${delta}% → ${round2(line.overload_pct)}%`);
}

function applyQcFailure(linesById, ev, changes) {
  const line = getOrInitLine(linesById, ev.line_id, { factory_id: ev.factory_id });
  if (!line) return;
  // QC failure does not stop the line by itself but it affects expected output
  const failedQty = Number(ev.payload?.failed_qty ?? 0);
  if (failedQty > 0) {
    line.actual_output_today = Math.max(0, line.actual_output_today - failedQty);
    changes.push(`line ${line.line_id} qc_failure: -${failedQty} from actual_output_today`);
  }
}

function applyOvertimeStarted(linesById, ev, changes) {
  const line = getOrInitLine(linesById, ev.line_id, { factory_id: ev.factory_id });
  if (!line) return;
  const hours = Number(ev.payload?.hours ?? 2);
  // Each overtime hour adds ~12.5% capacity (assumes 8h baseline)
  const boost = hours * 0.125;
  line.expected_output_today = Math.round(line.expected_output_today * (1 + boost));
  changes.push(`line ${line.line_id} overtime +${hours}h: expected_output ↑${Math.round(boost * 100)}%`);
}

function applyLaborShortage(linesById, ev, changes) {
  const line = getOrInitLine(linesById, ev.line_id, { factory_id: ev.factory_id });
  if (!line) return;
  const shortagePct = Number(ev.payload?.shortage_pct ?? 20);
  line.current_efficiency *= Math.max(0.1, 1 - shortagePct / 100);
  changes.push(`line ${line.line_id} labor shortage ${shortagePct}%: efficiency → ${round2(line.current_efficiency)}`);
}

function applyShipmentRisk(linesById, ev, changes) {
  // Shipment risk is informational at the line level (mainly for downstream
  // services), but if a line is associated with the at-risk order, mark amber.
  const orderId = ev.order_id ?? ev.payload?.order_id;
  if (!orderId) return;
  for (const l of linesById.values()) {
    if (l.current_order_id === orderId && l.runtime_risk === "green") {
      l.runtime_risk = "amber";
      changes.push(`line ${l.line_id} → amber (shipment risk on ${orderId})`);
    }
  }
}

function applyAllocationCompleted(linesById, ev, changes) {
  const line = getOrInitLine(linesById, ev.line_id, { factory_id: ev.factory_id });
  if (!line) return;
  const allocId = ev.allocation_id ?? ev.payload?.allocation_id;
  if (!allocId) return;
  if (Array.isArray(line.queue)) {
    const before = line.queue.length;
    line.queue = line.queue.filter((a) => a.allocation_id !== allocId);
    if (line.queue.length < before) {
      changes.push(`line ${line.line_id}: removed completed allocation ${allocId.slice(0, 8)} from queue`);
    }
  }
  if (line.current_allocation_id === allocId) {
    line.current_allocation_id = null;
    line.current_order_id = null;
    line.runtime_status = "idle";
    changes.push(`line ${line.line_id} → idle (allocation ${allocId.slice(0, 8)} completed)`);
  }
}

function applyReschedule(linesById, ev, changes) {
  const moves = ev.payload?.moves ?? [];
  for (const m of moves) {
    if (m.type === "shift" && m.from_line) {
      const line = linesById.get(m.from_line);
      if (line) changes.push(`line ${m.from_line} alloc ${m.allocation_id?.slice(0, 8)} shifted +${m.delay_days}d`);
    } else if (m.type === "reassign" && m.from_line && m.to_line) {
      changes.push(`alloc ${m.allocation_id?.slice(0, 8)} reassigned ${m.from_line} → ${m.to_line}`);
    } else if (m.type === "split") {
      changes.push(`alloc ${m.allocation_id?.slice(0, 8)} split: ${m.split_qty} to ${m.to_line}`);
    } else if (m.type === "displace") {
      changes.push(`alloc ${m.allocation_id?.slice(0, 8)} inserted on ${m.to_line}`);
    }
  }
}

function applyNoop(_linesById, _ev, changes) {
  changes.push("no state change (informational event)");
}

function deepCloneLine(l) {
  return {
    ...l,
    queue: Array.isArray(l.queue) ? l.queue.map((a) => ({ ...a })) : [],
  };
}

function round2(x) { return Math.round(x * 100) / 100; }
