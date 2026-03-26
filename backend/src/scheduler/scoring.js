export function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

export function scoreUtilization(utilizationPct) {
  // Prefer factories with headroom; penalize near saturation.
  const u = clamp01(utilizationPct / 100);
  // Simple curve: 0% -> 1.0, 70% -> 0.6, 90% -> 0.25, 100% -> 0
  const s = 1 - Math.pow(u, 2.2);
  return clamp01(s);
}

export function scoreTimeFeasibility(daysUntilDue, totalMinutes, dailyCapacityMinutes) {
  const daily = Math.max(1, Number(dailyCapacityMinutes ?? 8 * 60));
  const availableDays = Math.max(0, Number(daysUntilDue));
  const availableMinutes = availableDays * daily;
  const feasible = totalMinutes <= availableMinutes;
  const ratio = availableMinutes <= 0 ? 0 : clamp01(totalMinutes / availableMinutes);
  // If feasible, higher score when ratio is smaller (more slack).
  // If not feasible, heavily penalize but still rank within infeasible set.
  const score = feasible ? clamp01(1 - ratio) : clamp01(0.15 * (1 - ratio));
  return { feasible, score, available_minutes: availableMinutes };
}

export function scoreCapabilityQuality(capability) {
  const q = capability?.quality_score;
  if (q == null) return 0.5;
  return clamp01(Number(q) / 100);
}

export function scoreCost(capability) {
  const c = capability?.cost_per_unit;
  if (c == null) return 0.5;
  // Cost needs normalization outside; here interpret lower as better via soft transform.
  // Assume typical range 0..100, clamp.
  const norm = clamp01(Number(c) / 100);
  return clamp01(1 - norm);
}

export function defaultWeights(urgency) {
  // If due date is close, emphasize feasibility/time and utilization.
  const days = urgency?.days_until_due ?? 30;
  const urgent = days <= 7;
  return urgent
    ? { feasibility: 0.45, utilization: 0.30, quality: 0.15, cost: 0.10 }
    : { feasibility: 0.30, utilization: 0.35, quality: 0.20, cost: 0.15 };
}

