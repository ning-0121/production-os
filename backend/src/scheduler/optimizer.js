/**
 * Multi-Order, Multi-Factory Scheduling Optimizer
 *
 * Algorithm: Priority-sorted greedy assignment with constraint propagation
 * and local-search refinement.
 *
 * Phases:
 *   1. Data preparation — build mutable factory load state
 *   2. Order priority scoring — sort by urgency/priority/size
 *   3. Greedy assignment — assign each order to best feasible factory
 *   4. Split detection — propose splits for orders too large for any single factory
 *   5. Local search — attempt swap/move improvements on initial assignment
 *   6. Output — allocations, warnings, explanations
 *
 * Structured for future replacement of the greedy core with LP/OR-tools.
 */

import { differenceInCalendarDays, parseISO, isValid, addDays } from "date-fns";
import {
  clamp01,
  scoreUtilization,
  scoreTimeFeasibility,
  scoreCapabilityQuality,
  scoreCost,
  defaultWeights,
} from "./scoring.js";
import { calcProductionMinutes } from "./calc.js";

// ── Constants ───────────────────────────────────────────

const DAILY_MINUTES = 8 * 60; // 480 min = 8hr workday
const RISK_BUFFER_DAYS = 2;
const MAX_LOCAL_SEARCH_ITERATIONS = 100;
const SPLIT_THRESHOLD = 0.7; // if order uses >70% of factory 30d capacity, consider split

// ── Public API ──────────────────────────────────────────

/**
 * @param {OptimizerInput} input
 * @returns {OptimizerResult}
 */
export function optimizeSchedule(input) {
  const { orders, factories, options = {} } = input;
  const horizonDays = Number(options.horizon_days ?? 30);

  // Phase 1: Build mutable state
  const state = buildInitialState(factories, horizonDays);
  const sortedOrders = prioritizeOrders(orders);

  // Phase 2+3: Greedy assignment
  const assignments = [];
  const warnings = [];
  const unassigned = [];

  for (const order of sortedOrders) {
    const result = assignOrder(order, state, horizonDays, options);

    if (result.assigned) {
      assignments.push(result.allocation);
      // Update running factory load (constraint propagation)
      applyAllocation(state, result.allocation);
    } else if (result.splitProposal) {
      // Phase 4: Order too large — propose split
      const splits = executeSplit(order, result.splitProposal, state, horizonDays, options);
      for (const s of splits.allocations) {
        assignments.push(s);
        applyAllocation(state, s);
      }
      if (splits.remainder > 0) {
        warnings.push({
          type: "split_incomplete",
          order_id: order.id,
          message: `Order ${order.id} split across ${splits.allocations.length} factories, but ${splits.remainder} units remain unassigned.`,
          suggestion: "source_new_factory",
          details: { total_qty: order.quantity, assigned_qty: order.quantity - splits.remainder, remainder: splits.remainder },
        });
        unassigned.push({ ...order, quantity: splits.remainder, reason: "no_remaining_capacity" });
      } else {
        warnings.push({
          type: "order_split",
          order_id: order.id,
          message: `Order ${order.id} split across ${splits.allocations.length} factories for optimal fit.`,
          suggestion: "review_split",
          details: { factories: splits.allocations.map((a) => a.factory_id) },
        });
      }
    } else {
      unassigned.push({ ...order, reason: result.reason });
      warnings.push(buildUnassignedWarning(order, result.reason, state));
    }
  }

  // Phase 5: Local search refinement
  const improved = localSearchRefine(assignments, sortedOrders, state, horizonDays, options);

  // Phase 6: Build output
  return {
    allocations: improved,
    warnings,
    unassigned,
    summary: buildSummary(improved, warnings, unassigned, sortedOrders),
  };
}

// ── Phase 1: State Construction ─────────────────────────

function buildInitialState(factories, horizonDays) {
  const state = {};
  for (const f of factories) {
    const dailyMin = Number(f.capacity?.daily_capacity_minutes ?? DAILY_MINUTES);
    const capacityWindow = dailyMin * horizonDays;
    const existing = Number(f.load?.allocated_minutes_next_30d ?? 0);

    state[f.id] = {
      factory: f,
      daily_capacity_minutes: dailyMin,
      capacity_window_minutes: capacityWindow,
      allocated_minutes: existing,
      utilization_pct: Math.min(100, (existing / Math.max(1, capacityWindow)) * 100),
      // Timeline: track day-by-day load for precise scheduling
      daily_load: new Array(horizonDays).fill(0),
      assignments: [],
    };
  }
  return state;
}

// ── Phase 2: Order Prioritization ───────────────────────

function prioritizeOrders(orders) {
  const now = new Date();
  return [...orders]
    .map((o) => {
      const due = toDate(o.due_date);
      const daysUntilDue = differenceInCalendarDays(due, now);
      return { ...o, _daysUntilDue: daysUntilDue };
    })
    .sort((a, b) => {
      // 1. Emergency priority (higher = more urgent)
      const prioDiff = (b.priority ?? 0) - (a.priority ?? 0);
      if (prioDiff !== 0) return prioDiff;

      // 2. Due date urgency (fewer days = more urgent)
      const urgDiff = a._daysUntilDue - b._daysUntilDue;
      if (urgDiff !== 0) return urgDiff;

      // 3. Larger orders first (harder to place)
      return (b.quantity ?? 0) - (a.quantity ?? 0);
    });
}

// ── Phase 3: Single Order Assignment ────────────────────

function assignOrder(order, state, horizonDays, options) {
  const candidates = [];
  const capableFactories = [];

  for (const [fid, fs] of Object.entries(state)) {
    const cap = findCapability(fs.factory, order.product_type);
    if (!cap) continue;
    capableFactories.push({ fid, fs, cap });

    const timing = calcProductionMinutes({ quantity: order.quantity }, cap);
    const productionDays = Math.ceil(timing.total_minutes / fs.daily_capacity_minutes);

    // Check if factory can physically fit this order
    const newAllocated = fs.allocated_minutes + timing.total_minutes;
    const newUtil = (newAllocated / Math.max(1, fs.capacity_window_minutes)) * 100;

    if (newUtil > 100) continue; // hard capacity constraint

    // Find earliest start day where daily capacity allows
    const startDay = findEarliestStart(fs, timing.total_minutes, productionDays, horizonDays);
    if (startDay < 0) continue; // can't fit in timeline

    const now = new Date();
    const startDate = addDays(now, startDay);
    const endDate = addDays(startDate, Math.max(1, productionDays));

    // Check due date feasibility
    const dueDate = toDate(order.due_date);
    const bufferDays = differenceInCalendarDays(dueDate, endDate);
    const feasible = bufferDays >= 0;
    const safeBuffer = bufferDays >= RISK_BUFFER_DAYS;

    // Score this candidate
    const urgency = { days_until_due: order._daysUntilDue ?? differenceInCalendarDays(dueDate, now) };
    const w = defaultWeights(urgency);
    const feas = scoreTimeFeasibility(urgency.days_until_due, timing.total_minutes, fs.daily_capacity_minutes);
    const sUtil = scoreUtilization(newUtil);
    const sQual = scoreCapabilityQuality(cap);
    const sCost = scoreCost(cap);

    let score = w.feasibility * feas.score + w.utilization * sUtil + w.quality * sQual + w.cost * sCost;

    // Bonus for safe buffer
    if (safeBuffer) score += 0.05;

    // Penalty for infeasible
    if (!feasible) score *= 0.3;

    const breakdown = { feasibility: feas.score, utilization: sUtil, quality: sQual, cost: sCost };

    candidates.push({
      factory_id: fid,
      factory_name: fs.factory.name,
      capability: cap,
      timing,
      start_day: startDay,
      production_days: productionDays,
      start_date: startDate.toISOString(),
      end_date: endDate.toISOString(),
      buffer_days: bufferDays,
      feasible,
      new_utilization_pct: Math.round(newUtil * 10) / 10,
      score: Math.round(score * 1000) / 1000,
      score_breakdown: breakdown,
    });
  }

  if (capableFactories.length === 0) {
    return { assigned: false, reason: "no_capable_factory" };
  }

  if (candidates.length === 0) {
    // All capable factories are at capacity — check if split is possible
    const splitProposal = proposeSplit(order, state, horizonDays);
    if (splitProposal && splitProposal.length > 0) {
      return { assigned: false, splitProposal };
    }
    return { assigned: false, reason: "all_factories_at_capacity" };
  }

  // Pick best candidate
  candidates.sort((a, b) => {
    if (a.feasible !== b.feasible) return a.feasible ? -1 : 1;
    return b.score - a.score;
  });

  const best = candidates[0];

  // Build allocation
  const allocation = {
    order_id: order.id,
    factory_id: best.factory_id,
    factory_name: best.factory_name,
    allocated_qty: order.quantity,
    planned_start_date: best.start_date,
    planned_end_date: best.end_date,
    buffer_days: best.buffer_days,
    feasible: best.feasible,
    confidence_score: best.score,
    score_breakdown: best.score_breakdown,
    timing: best.timing,
    new_utilization_pct: best.new_utilization_pct,
    reason: buildAssignmentReason(order, best),
    _start_day: best.start_day,
    _production_days: best.production_days,
    _all_candidates: candidates.length,
  };

  return { assigned: true, allocation };
}

// ── Phase 4: Order Splitting ────────────────────────────

function proposeSplit(order, state, horizonDays) {
  const proposals = [];

  for (const [fid, fs] of Object.entries(state)) {
    const cap = findCapability(fs.factory, order.product_type);
    if (!cap) continue;

    const remaining = fs.capacity_window_minutes - fs.allocated_minutes;
    if (remaining <= 0) continue;

    // How many units can this factory handle?
    const minutesPerUnit = Number(cap.minutes_per_unit ?? 0);
    const setupMinutes = Number(cap.setup_minutes ?? 0);
    if (minutesPerUnit <= 0) continue;

    const maxUnits = Math.floor((remaining - setupMinutes) / minutesPerUnit);
    if (maxUnits <= 0) continue;

    proposals.push({ factory_id: fid, max_units: maxUnits, capability: cap });
  }

  proposals.sort((a, b) => b.max_units - a.max_units);
  return proposals.length > 0 ? proposals : null;
}

function executeSplit(order, proposals, state, horizonDays, options) {
  let remainingQty = order.quantity;
  const allocations = [];

  for (const prop of proposals) {
    if (remainingQty <= 0) break;

    const qty = Math.min(remainingQty, prop.max_units);
    const splitOrder = { ...order, quantity: qty, id: `${order.id}__split_${allocations.length + 1}` };

    const result = assignOrder(splitOrder, state, horizonDays, options);
    if (result.assigned) {
      result.allocation.order_id = order.id; // keep original order ID
      result.allocation.split_index = allocations.length + 1;
      result.allocation.split_total_qty = order.quantity;
      result.allocation.reason = `Split ${qty}/${order.quantity} units to ${result.allocation.factory_name}. ${result.allocation.reason}`;
      allocations.push(result.allocation);
      applyAllocation(state, result.allocation);
      remainingQty -= qty;
    }
  }

  return { allocations, remainder: remainingQty };
}

// ── Phase 5: Local Search Refinement ────────────────────

function localSearchRefine(assignments, orders, state, horizonDays, options) {
  if (assignments.length < 2) return assignments;

  let improved = [...assignments];
  let bestScore = totalScore(improved);
  let iterations = 0;

  while (iterations < MAX_LOCAL_SEARCH_ITERATIONS) {
    let foundImprovement = false;

    // Try swap: exchange factories between two assignments
    for (let i = 0; i < improved.length; i++) {
      for (let j = i + 1; j < improved.length; j++) {
        if (improved[i].factory_id === improved[j].factory_id) continue;
        if (improved[i].product_type === improved[j].product_type) continue; // same product, swap unlikely to help

        const swapped = trySwap(improved, i, j, state, horizonDays);
        if (swapped) {
          const newScore = totalScore(swapped);
          if (newScore > bestScore + 0.001) {
            improved = swapped;
            bestScore = newScore;
            foundImprovement = true;
            break;
          }
        }
      }
      if (foundImprovement) break;
    }

    if (!foundImprovement) break;
    iterations++;
  }

  return improved;
}

function trySwap(assignments, i, j, state, horizonDays) {
  const a = assignments[i];
  const b = assignments[j];

  // Check: can factory_b handle order_a's product type?
  const capAinB = findCapability(state[b.factory_id]?.factory, a.product_type);
  const capBinA = findCapability(state[a.factory_id]?.factory, b.product_type);
  if (!capAinB || !capBinA) return null;

  // Check capacity: would the swap overload either factory?
  const fsA = state[a.factory_id];
  const fsB = state[b.factory_id];
  if (!fsA || !fsB) return null;

  const timingA = calcProductionMinutes({ quantity: a.allocated_qty }, capAinB);
  const timingB = calcProductionMinutes({ quantity: b.allocated_qty }, capBinA);

  // Factory A loses order_a, gains order_b
  const newAllocA = fsA.allocated_minutes - a.timing.total_minutes + timingB.total_minutes;
  // Factory B loses order_b, gains order_a
  const newAllocB = fsB.allocated_minutes - b.timing.total_minutes + timingA.total_minutes;

  if (newAllocA > fsA.capacity_window_minutes) return null;
  if (newAllocB > fsB.capacity_window_minutes) return null;

  const newUtilA = (newAllocA / Math.max(1, fsA.capacity_window_minutes)) * 100;
  const newUtilB = (newAllocB / Math.max(1, fsB.capacity_window_minutes)) * 100;

  // Rebuild allocations with swapped factories
  const swapped = [...assignments];
  swapped[i] = {
    ...a,
    factory_id: b.factory_id,
    factory_name: fsB.factory.name,
    timing: timingA,
    new_utilization_pct: Math.round(newUtilB * 10) / 10,
    reason: `Optimized via swap: moved to ${fsB.factory.name} for better balance.`,
  };
  swapped[j] = {
    ...b,
    factory_id: a.factory_id,
    factory_name: fsA.factory.name,
    timing: timingB,
    new_utilization_pct: Math.round(newUtilA * 10) / 10,
    reason: `Optimized via swap: moved to ${fsA.factory.name} for better balance.`,
  };

  return swapped;
}

function totalScore(assignments) {
  if (assignments.length === 0) return 0;
  let sum = 0;
  for (const a of assignments) {
    sum += a.confidence_score ?? 0;
    // Bonus for feasible
    if (a.feasible) sum += 0.1;
  }
  return sum / assignments.length;
}

// ── Helpers ─────────────────────────────────────────────

function toDate(d) {
  if (d instanceof Date) return d;
  const parsed = typeof d === "string" ? parseISO(d) : new Date(d);
  return isValid(parsed) ? parsed : new Date();
}

function findCapability(factory, productType) {
  return (factory.capabilities ?? factory.factory_capabilities ?? [])
    .find((c) => c.product_type === productType) ?? null;
}

function findEarliestStart(fs, totalMinutes, productionDays, horizonDays) {
  // Find the earliest contiguous block of `productionDays` days
  // where daily load doesn't exceed daily capacity
  const dailyCap = fs.daily_capacity_minutes;
  const dailyLoad = totalMinutes / Math.max(1, productionDays);

  for (let start = 0; start <= horizonDays - productionDays; start++) {
    let fits = true;
    for (let d = start; d < start + productionDays; d++) {
      if (d >= horizonDays) { fits = false; break; }
      if (fs.daily_load[d] + dailyLoad > dailyCap) { fits = false; break; }
    }
    if (fits) return start;
  }
  return -1; // can't fit
}

function applyAllocation(state, allocation) {
  const fs = state[allocation.factory_id];
  if (!fs) return;

  const total = allocation.timing?.total_minutes ?? 0;
  fs.allocated_minutes += total;
  fs.utilization_pct = (fs.allocated_minutes / Math.max(1, fs.capacity_window_minutes)) * 100;

  // Update daily load
  const startDay = allocation._start_day ?? 0;
  const prodDays = allocation._production_days ?? 1;
  const dailyLoad = total / Math.max(1, prodDays);
  for (let d = startDay; d < startDay + prodDays && d < fs.daily_load.length; d++) {
    fs.daily_load[d] += dailyLoad;
  }

  fs.assignments.push(allocation);
}

function buildAssignmentReason(order, candidate) {
  const parts = [];
  parts.push(`Best match: ${candidate.factory_name} (score ${(candidate.score * 100).toFixed(0)}/100).`);

  if (candidate.feasible) {
    if (candidate.buffer_days >= 5) {
      parts.push(`Safe buffer of ${candidate.buffer_days} days.`);
    } else if (candidate.buffer_days >= 2) {
      parts.push(`Moderate buffer of ${candidate.buffer_days} days — monitor.`);
    } else {
      parts.push(`Tight buffer of ${candidate.buffer_days} days — risk.`);
    }
  } else {
    parts.push(`WARNING: Exceeds due date by ${Math.abs(candidate.buffer_days)} days.`);
  }

  parts.push(`Factory utilization after: ${candidate.new_utilization_pct}%.`);
  parts.push(`Production: ${Math.round(candidate.timing.total_minutes / 60)}h (${candidate._production_days ?? "?"}d).`);
  parts.push(`Evaluated ${candidate._all_candidates ?? "?"} candidate factories.`);

  return parts.join(" ");
}

function buildUnassignedWarning(order, reason, state) {
  const base = {
    type: "unassigned",
    order_id: order.id,
    details: { product_type: order.product_type, quantity: order.quantity, due_date: order.due_date },
  };

  if (reason === "no_capable_factory") {
    return {
      ...base,
      message: `No factory has capability for "${order.product_type}". Sourcing required.`,
      suggestion: "source_new_factory",
    };
  }

  if (reason === "all_factories_at_capacity") {
    return {
      ...base,
      message: `All capable factories are at capacity for order ${order.id}. Consider delaying due date or sourcing.`,
      suggestion: "negotiate_delay",
    };
  }

  return {
    ...base,
    message: `Order ${order.id} could not be assigned: ${reason}.`,
    suggestion: "manual_review",
  };
}

function buildSummary(allocations, warnings, unassigned, orders) {
  const feasibleCount = allocations.filter((a) => a.feasible).length;
  const avgConfidence = allocations.length > 0
    ? Math.round((allocations.reduce((s, a) => s + a.confidence_score, 0) / allocations.length) * 100) / 100
    : 0;

  const factoryLoad = {};
  for (const a of allocations) {
    if (!factoryLoad[a.factory_id]) {
      factoryLoad[a.factory_id] = { factory_name: a.factory_name, orders: 0, total_minutes: 0, utilization_pct: a.new_utilization_pct };
    }
    factoryLoad[a.factory_id].orders++;
    factoryLoad[a.factory_id].total_minutes += a.timing?.total_minutes ?? 0;
    factoryLoad[a.factory_id].utilization_pct = a.new_utilization_pct;
  }

  return {
    total_orders: orders.length,
    assigned: allocations.length,
    unassigned: unassigned.length,
    feasible: feasibleCount,
    infeasible: allocations.length - feasibleCount,
    splits: allocations.filter((a) => a.split_index).length,
    warnings_count: warnings.length,
    avg_confidence: avgConfidence,
    factory_load: factoryLoad,
  };
}
