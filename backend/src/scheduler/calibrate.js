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

  // 1. Insert performance log
  const logged = await insertPerformanceLog(allocation, metrics);

  // 2. Recalibrate factory capabilities based on recent history
  const recalResult = await recalibrateCapability(
    allocation.factory_id,
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
  const plannedStart = toDate(allocation.planned_start_date);
  const plannedEnd = toDate(allocation.planned_end_date);
  const actualEnd = new Date(); // completed now

  // Actual start: use start_date (when it was scheduled to begin)
  const actualStart = plannedStart;

  const plannedDurationDays = Math.max(1, differenceInCalendarDays(plannedEnd, plannedStart));
  const actualDurationDays = Math.max(1, differenceInCalendarDays(actualEnd, actualStart));
  const delayDays = differenceInCalendarDays(actualEnd, plannedEnd);

  const quantity = Number(allocation.allocated_qty ?? 0);
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

async function insertPerformanceLog(allocation, metrics) {
  const log = {
    factory_id: allocation.factory_id,
    order_id: allocation.order_id ?? null,
    actual_start_date: metrics.actual_start,
    actual_end_date: metrics.actual_end,
    delay_days: metrics.delay_days,
    actual_daily_output: metrics.actual_daily_output,
    quality_issue_count: 0,
    notes: JSON.stringify({
      planned_duration_days: metrics.planned_duration_days,
      actual_duration_days: metrics.actual_duration_days,
      efficiency_rate: metrics.efficiency_rate,
      on_time: metrics.on_time,
      quantity: metrics.quantity,
    }),
  };

  const { error } = await supabase
    .from("factory_performance_logs")
    .insert(log);

  if (error) {
    console.error("Failed to insert performance log:", error.message);
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
async function recalibrateCapability(factoryId) {
  // 1. Get last N performance logs for this factory
  const { data: logs, error: logErr } = await supabase
    .from("factory_performance_logs")
    .select("actual_daily_output, delay_days")
    .eq("factory_id", factoryId)
    .order("actual_end_date", { ascending: false })
    .limit(RECALIBRATION_WINDOW);

  if (logErr || !logs || logs.length < 2) {
    return { recalibrated: false, updates: null };
  }

  // 2. Compute averages
  let sumDailyOutput = 0;
  let sumDelayDays = 0;
  let onTimeCount = 0;

  for (const log of logs) {
    sumDailyOutput += Number(log.actual_daily_output ?? 0);
    sumDelayDays += Number(log.delay_days ?? 0);
    if ((log.delay_days ?? 0) <= 0) onTimeCount++;
  }

  const n = logs.length;
  const avgDailyOutput = sumDailyOutput / n;
  const avgDelayDays = sumDelayDays / n;
  const onTimeRate = onTimeCount / n;

  // 3. Derive new daily_capacity
  const newCapacityPerDay = Math.round(avgDailyOutput * 100) / 100;

  // 4. Find capability to update (first one for this factory)
  const { data: cap } = await supabase
    .from("factory_capabilities")
    .select("id")
    .eq("factory_id", factoryId)
    .limit(1)
    .single();

  if (!cap?.id) {
    return { recalibrated: false, updates: null };
  }

  // 5. Update factory_capabilities
  const updates = {};
  if (newCapacityPerDay > 0) updates.daily_capacity = newCapacityPerDay;

  // Also update the factory's delay_score based on on-time rate
  const newDelayScore = Math.round(onTimeRate * 100);
  await supabase
    .from("factories")
    .update({ delay_score: newDelayScore })
    .eq("id", factoryId);

  if (Object.keys(updates).length > 0) {
    const { error: updateErr } = await supabase
      .from("factory_capabilities")
      .update(updates)
      .eq("id", cap.id);

    if (updateErr) {
      console.error("Failed to recalibrate capability:", updateErr.message);
      return { recalibrated: false, updates: null };
    }
  }

  console.log(
    `Recalibrated factory ${factoryId}: ` +
    `daily_capacity=${updates.daily_capacity}, ` +
    `delay_score=${newDelayScore}, ` +
    `samples=${n}`,
  );

  return { recalibrated: true, updates };
}
