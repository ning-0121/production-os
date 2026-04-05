/**
 * APS (Advanced Planning & Scheduling) Engine
 *
 * Core algorithm for garment factory auto-scheduling:
 *   1. Sort orders by due date (urgent first)
 *   2. For each order, find best matching production line (product fit + capacity)
 *   3. Calculate front process dates (append after last front on that line)
 *   4. Calculate back process dates (after front finishes AND after last back finishes)
 *   5. Check if delivery date can be met; if not, flag warning
 *
 * Input:  orders[], lines[], existingSchedules[]
 * Output: schedulePlan[] with line assignments and dates
 */

/**
 * @param {{ id: string, order_id: string, product_type: string, allocated_qty: number, planned_end_date: string }[]} orders
 * @param {{ id: string, name: string, factory_id: string, factory_name: string, product_types: string[], front_capacity_per_day: number, back_capacity_per_day: number }[]} lines
 * @param {{ line_id: string, process: string, end_date: string }[]} existingSchedules
 * @returns {{ assignments: object[], warnings: object[], summary: object }}
 */
export function runAPS(orders, lines, existingSchedules) {
  // Track each line's front and back end dates (mutable state)
  const lineState = {};
  for (const line of lines) {
    lineState[line.id] = {
      frontEnd: null,  // last front process end date
      backEnd: null,   // last back process end date
      assignedOrders: 0,
      totalQty: 0,
    };
  }

  // Initialize from existing schedules
  for (const sch of existingSchedules) {
    const state = lineState[sch.line_id];
    if (!state) continue;
    if (sch.process === "front") {
      if (!state.frontEnd || sch.end_date > state.frontEnd) state.frontEnd = sch.end_date;
    } else {
      if (!state.backEnd || sch.end_date > state.backEnd) state.backEnd = sch.end_date;
    }
  }

  // Sort orders: earliest due date first (most urgent)
  const sorted = [...orders].sort((a, b) =>
    a.planned_end_date.localeCompare(b.planned_end_date)
  );

  const today = new Date().toISOString().slice(0, 10);
  const assignments = [];
  const warnings = [];

  for (const order of sorted) {
    // Find candidate lines that support this product type
    const candidates = lines.filter((l) =>
      l.product_types && l.product_types.includes(order.product_type)
    );

    if (candidates.length === 0) {
      warnings.push({
        order_id: order.order_id,
        type: "no_capable_line",
        message: `没有产线支持 "${order.product_type}"，需要手动分配`,
      });
      continue;
    }

    // Score each candidate line
    const scored = candidates.map((line) => {
      const state = lineState[line.id];
      const frontStart = state.frontEnd && state.frontEnd > today ? state.frontEnd : today;

      // Estimate front days: qty / front_capacity
      const frontDays = Math.ceil(order.allocated_qty / (line.front_capacity_per_day || 300));
      const frontEnd = addDaysStr(frontStart, frontDays);

      // Back start = max(frontEnd, lastBackEnd)
      const backStart = state.backEnd && state.backEnd > frontEnd ? state.backEnd : frontEnd;
      const backDays = Math.ceil(order.allocated_qty / (line.back_capacity_per_day || 200));
      const backEnd = addDaysStr(backStart, backDays);

      // Score: prefer lines that finish earlier + have less load
      const deliveryDate = order.planned_end_date;
      const daysLate = diffDays(backEnd, deliveryDate);
      const loadPenalty = state.assignedOrders * 2;

      return {
        line,
        frontStart,
        frontEnd,
        frontDays,
        backStart,
        backEnd,
        backDays,
        daysLate,          // negative = early, positive = late
        score: -daysLate - loadPenalty,  // higher = better
      };
    });

    // Pick best line (highest score = earliest delivery + least loaded)
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];

    // Create assignment
    const assignment = {
      order_id: order.order_id,
      allocation_id: order.id,
      product_type: order.product_type,
      qty: order.allocated_qty,
      due_date: order.planned_end_date,
      line_id: best.line.id,
      line_name: `${best.line.factory_name} ${best.line.name}`,
      front: { start: best.frontStart, end: best.frontEnd, days: best.frontDays },
      back: { start: best.backStart, end: best.backEnd, days: best.backDays },
      delivery_ok: best.daysLate <= 0,
      days_late: best.daysLate > 0 ? best.daysLate : 0,
      days_early: best.daysLate < 0 ? Math.abs(best.daysLate) : 0,
    };

    assignments.push(assignment);

    // Update line state for next iteration
    const state = lineState[best.line.id];
    state.frontEnd = best.frontEnd;
    state.backEnd = best.backEnd;
    state.assignedOrders++;
    state.totalQty += order.allocated_qty;

    // Check delivery warning
    if (best.daysLate > 0) {
      warnings.push({
        order_id: order.order_id,
        type: "delivery_risk",
        message: `${order.order_id} 预计延迟 ${best.daysLate} 天交货（完成 ${best.backEnd}，交期 ${order.planned_end_date}）`,
        suggested_lines: scored.slice(0, 3).map((s) => ({
          line: `${s.line.factory_name} ${s.line.name}`,
          finish: s.backEnd,
          days_late: s.daysLate,
        })),
      });
    }
  }

  // Summary
  const lineLoad = {};
  for (const a of assignments) {
    if (!lineLoad[a.line_name]) lineLoad[a.line_name] = { orders: 0, qty: 0 };
    lineLoad[a.line_name].orders++;
    lineLoad[a.line_name].qty += a.qty;
  }

  return {
    assignments,
    warnings,
    summary: {
      total_orders: orders.length,
      scheduled: assignments.length,
      unscheduled: orders.length - assignments.length,
      on_time: assignments.filter((a) => a.delivery_ok).length,
      at_risk: assignments.filter((a) => !a.delivery_ok).length,
      line_load: lineLoad,
    },
  };
}

// ── Helpers ─────────────────────────────────────────────

function addDaysStr(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function diffDays(dateA, dateB) {
  const a = new Date(dateA);
  const b = new Date(dateB);
  return Math.round((a - b) / (1000 * 60 * 60 * 24));
}
