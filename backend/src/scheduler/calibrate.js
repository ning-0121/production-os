import { differenceInCalendarDays, parseISO, isValid } from "date-fns";
import { supabase } from "../supabase.js";

/**
 * Record completion metrics and recalibrate factory capabilities.
 * Called automatically when an allocation transitions to "completed".
 *
 * @param {object} allocation — the completed allocation row
 * @returns {Promise<{ logged: boolean, recalibrated: boolean, updates: object | null }>}
 */
export async function onOrderCompleted(allocation) {
  const metrics = computeCompletionMetrics(allocation);

  // 1. Insert performance logs
  const logged = await insertPerformanceLogs(allocation, metrics);

  // 2. Recalibrate factory capabilities based on recent history
  const recalResult = await recalibrateCapability(
    allocation.factory_id,
    allocation.product_type,
    allocation.capability_id,
  );

  return { logged, ...recalResult };
}

// ── Metrics computation ─────────────────────────────────

function toDate(d) {
  if (d instanceof Date) return d;
  const parsed = typeof d === "string" ? parseISO(d) : new Date(d);
  return isValid(parsed) ? parsed : new Date();
}

function computeCompletionMetrics(allocation) {
  const plannedStart = toDate(allocation.start_at);
  const plannedEnd = toDate(allocation.end_at);
  const actualEnd = new Date(); // completed now

  // Actual start: use start_at (when it was scheduled to begin)
  const actualStart = plannedStart;

  const plannedDurationDays = Math.max(1, differenceInCalendarDays(plannedEnd, plannedStart));
  const actualDurationDays = Math.max(1, differenceInCalendarDays(actualEnd, actualStart));
  const delayDays = differenceInCalendarDays(actualEnd, plannedEnd);

  const quantity = Number(allocation.quantity ?? 0);
  const actualDailyOutput = quantity / actualDurationDays;
  const plannedDailyOutput = quantity / plannedDurationDays;

  // Efficiency: ratio of planned vs actual duration (>1 = faster than planned)
  const efficiencyRate = plannedDurationDays / actualDurationDays;

  return {
    actual_start: actualStart.toISOString(),
    actual_end: actualEnd.toISOString(),
    planned_duration_days: plannedDurationDays,
    actual_duration_days: actualDurationDays,
    delay_days: delayDays,
    on_time: delayDays <= 0,
    actual_daily_output: Math.round(actualDailyOutput * 100) / 100,
    planned_daily_output: Math.round(plannedDailyOutput * 100) / 100,
    efficiency_rate: Math.round(efficiencyRate * 1000) / 1000,
    quantity,
  };
}

// ── Performance logging ─────────────────────────────────

async function insertPerformanceLogs(allocation, metrics) {
  const now = new Date().toISOString();
  const base = {
    factory_id: allocation.factory_id,
    capability_id: allocation.capability_id ?? null,
    occurred_at: now,
  };

  const logs = [
    {
      ...base,
      metric_type: "order_completion",
      metric_value: metrics.actual_daily_output,
      unit: "units_per_day",
      context: {
        allocation_id: allocation.id,
        product_type: allocation.product_type,
        quantity: metrics.quantity,
        actual_start: metrics.actual_start,
        actual_end: metrics.actual_end,
        planned_duration_days: metrics.planned_duration_days,
        actual_duration_days: metrics.actual_duration_days,
        delay_days: metrics.delay_days,
        on_time: metrics.on_time,
        efficiency_rate: metrics.efficiency_rate,
        planned_daily_output: metrics.planned_daily_output,
      },
    },
    {
      ...base,
      metric_type: "delay_days",
      metric_value: metrics.delay_days,
      unit: "days",
      context: {
        allocation_id: allocation.id,
        product_type: allocation.product_type,
      },
    },
    {
      ...base,
      metric_type: "efficiency_rate",
      metric_value: metrics.efficiency_rate,
      unit: "ratio",
      context: {
        allocation_id: allocation.id,
        product_type: allocation.product_type,
      },
    },
  ];

  const { error } = await supabase
    .from("factory_performance_logs")
    .insert(logs);

  if (error) {
    console.error("Failed to insert performance logs:", error.message);
    return false;
  }
  return true;
}

// ── Recalibration ───────────────────────────────────────

const RECALIBRATION_WINDOW = 5; // last N completions

/**
 * Fetch last N order completions for a factory+product_type,
 * compute averages, and update factory_capabilities.
 */
async function recalibrateCapability(factoryId, productType, capabilityId) {
  // 1. Get last N completion logs for this factory + product_type
  const { data: logs, error: logErr } = await supabase
    .from("factory_performance_logs")
    .select("metric_value, context")
    .eq("factory_id", factoryId)
    .eq("metric_type", "order_completion")
    .order("occurred_at", { ascending: false })
    .limit(RECALIBRATION_WINDOW);

  if (logErr || !logs || logs.length === 0) {
    return { recalibrated: false, updates: null };
  }

  // Filter to only this product_type (stored in context)
  const relevant = logs.filter(
    (l) => l.context?.product_type === productType,
  );

  if (relevant.length < 2) {
    // Need at least 2 data points to recalibrate
    return { recalibrated: false, updates: null };
  }

  // 2. Compute averages
  let sumDailyOutput = 0;
  let sumDelayDays = 0;
  let sumEfficiency = 0;
  let onTimeCount = 0;

  for (const log of relevant) {
    sumDailyOutput += Number(log.metric_value ?? 0);
    sumDelayDays += Number(log.context?.delay_days ?? 0);
    sumEfficiency += Number(log.context?.efficiency_rate ?? 1);
    if (log.context?.on_time) onTimeCount++;
  }

  const n = relevant.length;
  const avgDailyOutput = sumDailyOutput / n;
  const avgDelayDays = sumDelayDays / n;
  const avgEfficiency = sumEfficiency / n;
  const onTimeRate = onTimeCount / n; // 0..1

  // 3. Derive new capability values
  // minutes_per_unit: inverse of daily output, scaled to an 8hr day
  const DAILY_MINUTES = 8 * 60;
  const newMinutesPerUnit = avgDailyOutput > 0
    ? Math.round((DAILY_MINUTES / avgDailyOutput) * 10000) / 10000
    : null;

  // quality_score: blend of on-time rate (60%) + efficiency (40%), scaled 0..100
  const efficiencyScore = Math.min(1, Math.max(0, avgEfficiency)); // clamp
  const newQualityScore = Math.round(
    (onTimeRate * 0.6 + efficiencyScore * 0.4) * 100 * 100,
  ) / 100; // 0..100 with 2 decimal places

  // base_capacity_units_per_day: directly from average daily output
  const newCapacityPerDay = Math.round(avgDailyOutput * 100) / 100;

  // 4. Determine which capability row to update
  let targetCapId = capabilityId;
  if (!targetCapId) {
    // Look up by factory_id + product_type
    const { data: cap } = await supabase
      .from("factory_capabilities")
      .select("id")
      .eq("factory_id", factoryId)
      .eq("product_type", productType)
      .limit(1)
      .single();
    targetCapId = cap?.id;
  }

  if (!targetCapId) {
    return { recalibrated: false, updates: null };
  }

  // 5. Update factory_capabilities
  const updates = {};
  if (newMinutesPerUnit !== null) updates.minutes_per_unit = newMinutesPerUnit;
  if (newQualityScore !== null) updates.quality_score = newQualityScore;
  if (newCapacityPerDay > 0) updates.base_capacity_units_per_day = newCapacityPerDay;

  // Store calibration metadata in features JSONB
  updates.features = {
    last_calibrated_at: new Date().toISOString(),
    calibration_samples: n,
    avg_daily_output: avgDailyOutput,
    avg_delay_days: avgDelayDays,
    avg_efficiency: avgEfficiency,
    on_time_rate: onTimeRate,
  };

  const { error: updateErr } = await supabase
    .from("factory_capabilities")
    .update(updates)
    .eq("id", targetCapId);

  if (updateErr) {
    console.error("Failed to recalibrate capability:", updateErr.message);
    return { recalibrated: false, updates: null };
  }

  console.log(
    `Recalibrated capability ${targetCapId}: ` +
    `minutes_per_unit=${updates.minutes_per_unit}, ` +
    `quality_score=${updates.quality_score}, ` +
    `capacity/day=${updates.base_capacity_units_per_day}, ` +
    `samples=${n}`,
  );

  return { recalibrated: true, updates };
}
