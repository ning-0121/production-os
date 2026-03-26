import { calcDueUrgency, calcLoadSnapshot, calcProductionMinutes, pickCapability } from "./calc.js";
import {
  defaultWeights,
  scoreCapabilityQuality,
  scoreCost,
  scoreTimeFeasibility,
  scoreUtilization,
} from "./scoring.js";

/**
 * @param {import('./types.js').OrderInput} order
 * @param {import('./types.js').FactoryInput[]} factories
 * @param {{
 *  horizonDays?: number,
 *  weights?: Partial<{feasibility:number, utilization:number, quality:number, cost:number}>,
 *  scorePlugins?: Array<(ctx: any) => { key: string, score01: number, weight: number, meta?: any }>,
 * }} [opts]
 * @returns {import('./types.js').Recommendation[]}
 */
export function recommendFactories(order, factories, opts = {}) {
  const horizonDays = Number(opts.horizonDays ?? 30);
  const urgency = calcDueUrgency(order);
  const w = { ...defaultWeights(urgency), ...(opts.weights ?? {}) };

  /** @type {import('./types.js').Recommendation[]} */
  const recs = [];

  for (const f of factories ?? []) {
    const capability = pickCapability(f, order.product_type);
    if (!capability) {
      recs.push({
        factory_id: f.id,
        factory_name: f.name,
        score: 0,
        feasible: false,
        timing: { production_minutes: 0, setup_minutes: 0, total_minutes: 0 },
        load: { utilization_pct: 100, allocated_minutes_window: 0, capacity_minutes_window: 1 },
        score_breakdown: { capability_match: 0 },
        assumptions: { reason: "no_capability_for_product_type" },
      });
      continue;
    }

    const timing = calcProductionMinutes(order, capability);
    const load = calcLoadSnapshot(f, horizonDays);
    const dailyCap = Number(f.capacity?.daily_capacity_minutes ?? 8 * 60);
    const feas = scoreTimeFeasibility(urgency.days_until_due, timing.total_minutes, dailyCap);

    const sUtil = scoreUtilization(load.utilization_pct);
    const sQual = scoreCapabilityQuality(capability);
    const sCost = scoreCost(capability);

    let score01 =
      w.feasibility * feas.score +
      w.utilization * sUtil +
      w.quality * sQual +
      w.cost * sCost;

    /** @type {Record<string, number>} */
    const breakdown = {
      feasibility: feas.score,
      utilization: sUtil,
      quality: sQual,
      cost: sCost,
    };

    /** @type {Record<string, any>} */
    const assumptions = {
      horizonDays,
      days_until_due: urgency.days_until_due,
      available_minutes_until_due: feas.available_minutes,
      daily_capacity_minutes: dailyCap,
      weights: w,
    };

    for (const plugin of opts.scorePlugins ?? []) {
      const out = plugin({
        order,
        factory: f,
        capability,
        timing,
        load,
        urgency,
        assumptions,
      });
      if (!out) continue;
      const s = Math.max(0, Math.min(1, Number(out.score01)));
      const weight = Math.max(0, Number(out.weight ?? 0));
      score01 += weight * s;
      breakdown[out.key] = s;
      if (out.meta != null) assumptions[`plugin:${out.key}`] = out.meta;
    }

    // Feasibility gating: keep infeasible factories ranked but lower.
    if (!feas.feasible) score01 *= 0.35;

    const score = Math.round(Math.max(0, score01) * 1000) / 1000;

    recs.push({
      factory_id: f.id,
      factory_name: f.name,
      score,
      feasible: feas.feasible,
      timing: {
        production_minutes: timing.production_minutes,
        setup_minutes: timing.setup_minutes,
        total_minutes: timing.total_minutes,
      },
      load,
      score_breakdown: breakdown,
      assumptions,
    });
  }

  recs.sort((a, b) => {
    if (a.feasible !== b.feasible) return a.feasible ? -1 : 1;
    return b.score - a.score;
  });

  return recs;
}

