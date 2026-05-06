/**
 * Runtime Scheduler — incremental, event-driven, NEVER recomputes globally.
 *
 * Different from the existing APS optimizer in `scheduler/optimizer.js`:
 *   APS optimizer  : full schedule from scratch, planning-time
 *   Runtime scheduler : local repair on a live state, runtime
 *
 * All three operations are PURE: input is `{lines, allocations, graph?}` plus
 * the requested action; output is `{plan, affected, reasoning, confidence}`
 * with NO side effects. Persistence and event emission are caller's job.
 *
 * Operations:
 *   1. localReschedule(state, conflict)  — repair an overload / blockage
 *   2. insertEmergency(state, allocation) — VIP insertion w/ displacement plan
 *   3. simulate(state, events)            — apply events in dry-run mode
 *   4. rollback(snapshot)                 — restore state to a prior snapshot
 */

/**
 * @typedef {Object} RuntimeLineState
 * @property {string} line_id
 * @property {string} factory_id
 * @property {"idle"|"running"|"blocked"|"rework"|"changeover"|"down"} runtime_status
 * @property {number} current_efficiency
 * @property {number} actual_output_today
 * @property {number} expected_output_today
 * @property {number} overload_pct
 * @property {string} runtime_risk
 * @property {string|null} planned_end_at
 * @property {Array<{allocation_id: string, order_id: string, priority: number, qty: number, due_date: string, locked?: boolean}>} queue
 * @property {number} version
 */

/**
 * @typedef {Object} RescheduleMove
 * @property {string} type      "shift" | "swap" | "split" | "displace" | "reassign"
 * @property {string} allocation_id
 * @property {string} from_line
 * @property {string} [to_line]
 * @property {number} [delay_days]
 * @property {number} [split_qty]
 * @property {string} reason
 */

/**
 * @typedef {Object} RuntimePlan
 * @property {string} action_type
 * @property {RescheduleMove[]} moves
 * @property {string[]} affected_orders
 * @property {string[]} affected_lines
 * @property {string} reasoning
 * @property {number} confidence
 * @property {number} estimated_cost          arbitrary unit (lower = better)
 * @property {boolean} feasible
 */

const URGENCY_PRIORITY = { critical: 100, high: 70, medium: 40, low: 10 };

// ════════════════════════════════════════════════════════════
// 1) localReschedule — fix an overload / blockage on ONE line
// ════════════════════════════════════════════════════════════

/**
 * Resolve a runtime conflict on a single line by shifting the lowest-priority
 * allocation forward in time (delay) or splitting it onto a peer line.
 *
 * @param {{lines: RuntimeLineState[]}} state
 * @param {{
 *   line_id: string,
 *   conflict_type: "overload" | "blocked" | "slowdown",
 *   delay_days?: number,
 *   reason?: string,
 * }} conflict
 * @returns {RuntimePlan}
 */
export function localReschedule(state, conflict) {
  const line = state.lines.find((l) => l.line_id === conflict.line_id);
  if (!line) {
    return failPlan("local_reschedule", `line ${conflict.line_id} not in runtime state`);
  }

  const queue = (line.queue ?? []).filter((a) => !a.locked);
  if (queue.length === 0) {
    return {
      action_type: "local_reschedule",
      moves: [],
      affected_orders: [],
      affected_lines: [line.line_id],
      reasoning: `Line ${line.line_id} 队列为空，无需重排`,
      confidence: 1.0,
      estimated_cost: 0,
      feasible: true,
    };
  }

  // Sort by priority (low → high) and due-date (far → near). Lowest-priority
  // far-due allocation is the safest to displace.
  const sorted = [...queue].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return String(b.due_date).localeCompare(String(a.due_date));
  });

  const target = sorted[0];
  const delay = Number(conflict.delay_days ?? 1);
  const moves = [];

  if (conflict.conflict_type === "overload") {
    // Strategy: shift the lowest-priority allocation by delay days.
    moves.push({
      type: "shift",
      allocation_id: target.allocation_id,
      from_line: line.line_id,
      delay_days: delay,
      reason: `Line overload ${line.overload_pct}% — shifted lowest-priority allocation`,
    });
  } else if (conflict.conflict_type === "blocked") {
    // Strategy: try reassigning to a peer line in the same factory with capacity.
    const peer = state.lines.find((l) =>
      l.line_id !== line.line_id
      && l.factory_id === line.factory_id
      && l.runtime_status !== "down"
      && l.overload_pct < 90
    );
    if (peer) {
      moves.push({
        type: "reassign",
        allocation_id: target.allocation_id,
        from_line: line.line_id,
        to_line: peer.line_id,
        reason: `Line blocked — reassigned to peer ${peer.line_id} (load ${peer.overload_pct}%)`,
      });
    } else {
      moves.push({
        type: "shift",
        allocation_id: target.allocation_id,
        from_line: line.line_id,
        delay_days: delay,
        reason: `Line blocked, no peer available — shifted by ${delay}d`,
      });
    }
  } else if (conflict.conflict_type === "slowdown") {
    // Strategy: split the largest allocation onto a peer line if available.
    const largest = [...queue].sort((a, b) => Number(b.qty) - Number(a.qty))[0];
    const peer = state.lines.find((l) =>
      l.line_id !== line.line_id
      && l.factory_id === line.factory_id
      && l.runtime_status !== "down"
      && l.overload_pct < 80
    );
    if (peer && Number(largest.qty) >= 100) {
      moves.push({
        type: "split",
        allocation_id: largest.allocation_id,
        from_line: line.line_id,
        to_line: peer.line_id,
        split_qty: Math.floor(Number(largest.qty) / 2),
        reason: `Slowdown: split half of allocation to peer line ${peer.line_id}`,
      });
    } else {
      moves.push({
        type: "shift",
        allocation_id: target.allocation_id,
        from_line: line.line_id,
        delay_days: delay,
        reason: `Slowdown, no split candidate — shifted by ${delay}d`,
      });
    }
  } else {
    return failPlan("local_reschedule", `unknown conflict_type=${conflict.conflict_type}`);
  }

  const affectedOrders = [...new Set(moves.map((m) => {
    const a = (line.queue ?? []).find((x) => x.allocation_id === m.allocation_id);
    return a?.order_id;
  }).filter(Boolean))];
  const affectedLines = [...new Set([line.line_id, ...moves.map((m) => m.to_line).filter(Boolean)])];

  // Confidence drops when we have to delay vs reassign (delay is more disruptive)
  const confidence = moves[0]?.type === "reassign" ? 0.85
    : moves[0]?.type === "split" ? 0.75
    : 0.6;

  return {
    action_type: "local_reschedule",
    moves,
    affected_orders: affectedOrders,
    affected_lines: affectedLines,
    reasoning: `${conflict.reason ?? "runtime conflict"} → ${moves[0]?.reason ?? "no-op"}`,
    confidence,
    estimated_cost: moves.reduce((sum, m) => sum + (m.delay_days ? m.delay_days * 10 : m.type === "reassign" ? 5 : 3), 0),
    feasible: true,
  };
}

// ════════════════════════════════════════════════════════════
// 2) insertEmergency — VIP allocation insertion w/ displacement
// ════════════════════════════════════════════════════════════

/**
 * Insert a high-priority allocation onto a line, displacing lower-priority
 * work as needed. Returns a displacement plan; does NOT mutate state.
 *
 * @param {{lines: RuntimeLineState[]}} state
 * @param {{
 *   allocation_id: string,
 *   order_id: string,
 *   factory_id: string,
 *   qty: number,
 *   due_date: string,
 *   priority?: number,         // default 100 = critical
 *   urgency?: "critical"|"high"|"medium"|"low",
 *   product_type?: string,
 * }} vip
 * @returns {RuntimePlan}
 */
export function insertEmergency(state, vip) {
  const priority = vip.priority ?? URGENCY_PRIORITY[vip.urgency ?? "critical"];

  // Candidate lines: same factory (or any if factory_id missing), not down
  const candidates = state.lines.filter((l) =>
    (vip.factory_id ? l.factory_id === vip.factory_id : true)
    && l.runtime_status !== "down"
  );

  if (candidates.length === 0) {
    return failPlan("insert_emergency", `no available line in factory ${vip.factory_id}`);
  }

  // Pick the line with lowest overload + highest available efficiency
  candidates.sort((a, b) => {
    const loadDiff = (a.overload_pct ?? 0) - (b.overload_pct ?? 0);
    if (Math.abs(loadDiff) > 5) return loadDiff;
    return (b.current_efficiency ?? 1) - (a.current_efficiency ?? 1);
  });

  const target = candidates[0];
  const moves = [];

  // Insert VIP at head of queue
  moves.push({
    type: "displace",
    allocation_id: vip.allocation_id,
    from_line: "external",
    to_line: target.line_id,
    reason: `VIP insertion: priority ${priority}, qty ${vip.qty}, due ${vip.due_date}`,
  });

  // If target is overloaded, find lowest-priority unlocked allocation to push out
  if ((target.overload_pct ?? 0) > 80 && target.queue && target.queue.length > 0) {
    const displaceable = [...target.queue]
      .filter((a) => !a.locked && a.priority < priority)
      .sort((a, b) => a.priority - b.priority)[0];

    if (displaceable) {
      // Find a peer line that can absorb the displaced allocation
      const peer = state.lines.find((l) =>
        l.line_id !== target.line_id
        && l.factory_id === target.factory_id
        && l.runtime_status !== "down"
        && (l.overload_pct ?? 0) < 75
      );
      if (peer) {
        moves.push({
          type: "reassign",
          allocation_id: displaceable.allocation_id,
          from_line: target.line_id,
          to_line: peer.line_id,
          reason: `Displaced by VIP — moved to peer line ${peer.line_id}`,
        });
      } else {
        moves.push({
          type: "shift",
          allocation_id: displaceable.allocation_id,
          from_line: target.line_id,
          delay_days: 1,
          reason: `Displaced by VIP — no peer available, shifted by 1d`,
        });
      }
    }
  }

  const affectedOrders = [...new Set(moves.map((m) => {
    if (m.allocation_id === vip.allocation_id) return vip.order_id;
    const a = target.queue?.find((x) => x.allocation_id === m.allocation_id);
    return a?.order_id;
  }).filter(Boolean))];
  const affectedLines = [...new Set(moves.flatMap((m) => [m.from_line, m.to_line].filter((x) => x && x !== "external")))];

  return {
    action_type: "insert_emergency",
    moves,
    affected_orders: affectedOrders,
    affected_lines: affectedLines,
    reasoning: `VIP order ${vip.order_id} inserted on line ${target.line_id} (load ${target.overload_pct}%, eff ${target.current_efficiency}); displaced ${moves.length - 1} allocation(s)`,
    confidence: moves.length === 1 ? 0.9 : 0.75,
    estimated_cost: moves.reduce((sum, m) => sum + (m.delay_days ? m.delay_days * 10 : 5), 0),
    feasible: true,
  };
}

// ════════════════════════════════════════════════════════════
// 3) simulate — dry-run apply events to a snapshot
// ════════════════════════════════════════════════════════════

/**
 * Apply a sequence of runtime events to a state snapshot WITHOUT persisting.
 * Returns a derived state plus the per-event effect log. Used for "what-if"
 * analysis ("if material X is delayed 3 days, what happens?").
 *
 * @param {{lines: RuntimeLineState[]}} state
 * @param {Array<{event_type: string, severity?: string, payload?: object, line_id?: string, allocation_id?: string}>} events
 * @returns {{
 *   final_state: {lines: RuntimeLineState[]},
 *   effects: Array<{event_type: string, applied: boolean, changes: string[]}>,
 *   summary: {events_applied: number, events_skipped: number, lines_affected: Set<string>},
 * }}
 */
export function simulate(state, events) {
  // Deep clone — pure function must not mutate input
  const linesById = new Map(state.lines.map((l) => [l.line_id, cloneLine(l)]));
  const effects = [];
  const linesAffected = new Set();
  let eventsApplied = 0;
  let eventsSkipped = 0;

  for (const ev of events) {
    const changes = [];
    const targetLine = ev.line_id ? linesById.get(ev.line_id) : null;

    if (ev.event_type === "line_slowdown" && targetLine) {
      const factor = Number(ev.payload?.efficiency_factor ?? 0.8);
      targetLine.current_efficiency *= factor;
      targetLine.runtime_status = "running";
      changes.push(`line ${targetLine.line_id} efficiency ×${factor} → ${round2(targetLine.current_efficiency)}`);
      linesAffected.add(targetLine.line_id);
      eventsApplied++;
    } else if (ev.event_type === "factory_shutdown" && ev.payload?.factory_id) {
      for (const l of linesById.values()) {
        if (l.factory_id === ev.payload.factory_id) {
          l.runtime_status = "down";
          l.current_efficiency = 0;
          linesAffected.add(l.line_id);
          changes.push(`line ${l.line_id} → down`);
        }
      }
      eventsApplied++;
    } else if (ev.event_type === "material_delayed" && ev.payload?.delay_days) {
      // Mark all lines awaiting this material's order as blocked
      for (const l of linesById.values()) {
        if (l.queue?.some((a) => a.order_id === ev.payload?.order_id)) {
          l.runtime_status = "blocked";
          linesAffected.add(l.line_id);
          changes.push(`line ${l.line_id} → blocked (awaiting ${ev.payload?.material_id})`);
        }
      }
      eventsApplied++;
    } else if (ev.event_type === "rework_started" && targetLine) {
      targetLine.runtime_status = "rework";
      targetLine.current_efficiency *= 0.5;
      changes.push(`line ${targetLine.line_id} → rework, eff halved`);
      linesAffected.add(targetLine.line_id);
      eventsApplied++;
    } else if (ev.event_type === "vip_inserted" && targetLine) {
      const overloadDelta = Number(ev.payload?.overload_delta ?? 15);
      targetLine.overload_pct = (targetLine.overload_pct ?? 0) + overloadDelta;
      changes.push(`line ${targetLine.line_id} overload +${overloadDelta}% → ${round2(targetLine.overload_pct)}%`);
      linesAffected.add(targetLine.line_id);
      eventsApplied++;
    } else {
      eventsSkipped++;
      effects.push({ event_type: ev.event_type, applied: false, changes: ["no-op (unknown or unattached event)"] });
      continue;
    }

    // Recompute risk on each affected line
    for (const lid of linesAffected) {
      const l = linesById.get(lid);
      l.runtime_risk = computeRisk(l);
    }

    effects.push({ event_type: ev.event_type, applied: true, changes });
  }

  return {
    final_state: { lines: [...linesById.values()] },
    effects,
    summary: {
      events_applied: eventsApplied,
      events_skipped: eventsSkipped,
      lines_affected: [...linesAffected],
    },
  };
}

// ════════════════════════════════════════════════════════════
// 4) rollback — produce a "restore" plan from a snapshot
// ════════════════════════════════════════════════════════════

/**
 * Compute the diff between current state and a snapshot, producing a list of
 * line updates to persist. The caller actually writes them to the DB.
 *
 * @param {{lines: RuntimeLineState[]}} currentState
 * @param {{lines: RuntimeLineState[]}} snapshot
 * @returns {{
 *   action_type: "rollback",
 *   line_updates: Array<{line_id: string, prev: object, restored: object, fields_changed: string[]}>,
 *   reasoning: string,
 *   confidence: number,
 *   feasible: boolean,
 * }}
 */
export function rollback(currentState, snapshot) {
  const snapshotById = new Map(snapshot.lines.map((l) => [l.line_id, l]));
  const updates = [];

  for (const cur of currentState.lines) {
    const snap = snapshotById.get(cur.line_id);
    if (!snap) continue;
    const fields = compareLine(cur, snap);
    if (fields.length > 0) {
      updates.push({
        line_id: cur.line_id,
        prev: pickFields(cur, fields),
        restored: pickFields(snap, fields),
        fields_changed: fields,
      });
    }
  }

  return {
    action_type: "rollback",
    line_updates: updates,
    reasoning: updates.length === 0
      ? "状态与快照一致，无需回滚"
      : `回滚 ${updates.length} 条产线状态到快照（共 ${updates.reduce((s, u) => s + u.fields_changed.length, 0)} 个字段）`,
    confidence: 1.0,
    feasible: true,
  };
}

// ── Helpers ───────────────────────────────────────────────

export function computeRisk(line) {
  if (line.runtime_status === "down" || (line.overload_pct ?? 0) > 110) return "red";
  if (line.runtime_status === "blocked" || line.runtime_status === "rework") return "red";
  if ((line.overload_pct ?? 0) > 90 || (line.current_efficiency ?? 1) < 0.7) return "amber";
  return "green";
}

function cloneLine(l) {
  return {
    ...l,
    queue: Array.isArray(l.queue) ? l.queue.map((a) => ({ ...a })) : [],
  };
}

function compareLine(a, b) {
  const fields = [];
  const watch = ["runtime_status", "current_efficiency", "actual_output_today",
                 "expected_output_today", "overload_pct", "runtime_risk",
                 "current_order_id", "current_allocation_id", "current_operation",
                 "planned_end_at"];
  for (const f of watch) {
    if (String(a?.[f] ?? "") !== String(b?.[f] ?? "")) fields.push(f);
  }
  return fields;
}

function pickFields(obj, fields) {
  const out = {};
  for (const f of fields) out[f] = obj?.[f] ?? null;
  return out;
}

function failPlan(action_type, reason) {
  return {
    action_type,
    moves: [],
    affected_orders: [],
    affected_lines: [],
    reasoning: reason,
    confidence: 0,
    estimated_cost: 0,
    feasible: false,
  };
}

function round2(x) { return Math.round(x * 100) / 100; }
