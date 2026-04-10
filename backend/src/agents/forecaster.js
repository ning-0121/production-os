/**
 * Forecast Engine — 预测未来 7/14/30 天的问题
 *
 * 规则驱动预测（不依赖 ML 库）：
 * - 产能预测：近 7 天日均产出 × 天数 - 已排产量
 * - 完工预测：累计产出 ÷ 已用天数 = 日均速率 → 剩余量 ÷ 速率
 * - 瓶颈预测：逐天叠加排产量，找超载日
 */

/**
 * 预测工厂未来产能缺口
 */
export async function forecastFactoryCapacity(supabase, factoryId, horizonDays = 14) {
  const since7d = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

  const [reportsRes, schedRes, lineRes] = await Promise.all([
    supabase.from("daily_production_reports").select("actual_output")
      .eq("factory_id", factoryId).gte("date", since7d),
    supabase.from("line_schedules").select("line_id, start_date, end_date, production_allocations(allocated_qty)")
      .eq("status", "pending"),
    supabase.from("production_lines").select("id, front_capacity_per_day, back_capacity_per_day")
      .eq("factory_id", factoryId).eq("status", "active"),
  ]);

  const reports = reportsRes.data ?? [];
  const schedules = schedRes.data ?? [];
  const lines = lineRes.data ?? [];

  // Recent daily average
  const dailyAvg = reports.length > 0
    ? reports.reduce((s, r) => s + Number(r.actual_output ?? 0), 0) / Math.min(7, reports.length)
    : 0;

  // Total capacity per day (sum all lines)
  const dailyCapacity = lines.reduce((s, l) =>
    s + Math.max(Number(l.front_capacity_per_day ?? 0), Number(l.back_capacity_per_day ?? 0)), 0);

  // Scheduled commitment in horizon
  const today = new Date();
  const horizonEnd = new Date(Date.now() + horizonDays * 86400000);
  const lineIds = new Set(lines.map((l) => l.id));
  const scheduledQty = schedules
    .filter((s) => lineIds.has(s.line_id))
    .reduce((sum, s) => sum + Number(s.production_allocations?.allocated_qty ?? 0), 0);

  const projectedOutput = dailyAvg * horizonDays;
  const gap = scheduledQty - projectedOutput;
  const gapPct = projectedOutput > 0 ? Math.round((gap / projectedOutput) * 100) : 0;

  return {
    forecast_type: "capacity",
    entity_type: "factory",
    entity_id: factoryId,
    horizon_days: horizonDays,
    predicted_value: Math.round(projectedOutput),
    unit: "units",
    confidence_score: Math.min(0.9, 0.4 + reports.length * 0.07),
    context: {
      daily_avg: Math.round(dailyAvg),
      daily_capacity: dailyCapacity,
      scheduled_qty: scheduledQty,
      gap,
      gap_pct: gapPct,
      at_risk: gap > 0,
    },
  };
}

/**
 * 预测订单完工日期
 */
export async function forecastOrderCompletion(supabase, allocationId) {
  const [allocRes, reportsRes] = await Promise.all([
    supabase.from("production_allocations").select("id, order_id, allocated_qty, planned_start_date, planned_end_date, status")
      .eq("id", allocationId).single(),
    supabase.from("daily_production_reports").select("actual_output, date")
      .eq("allocation_id", allocationId).order("date"),
  ]);

  const alloc = allocRes.data;
  if (!alloc) return null;

  const reports = reportsRes.data ?? [];
  const totalQty = Number(alloc.allocated_qty ?? 0);
  const cumulative = reports.reduce((s, r) => s + Number(r.actual_output ?? 0), 0);
  const remaining = Math.max(0, totalQty - cumulative);

  if (reports.length === 0 || cumulative === 0) {
    return {
      forecast_type: "completion",
      entity_type: "order",
      entity_id: allocationId,
      predicted_value: null,
      unit: "days",
      confidence_score: 0.2,
      context: { reason: "无日报数据，无法预测", cumulative: 0, remaining, total: totalQty },
    };
  }

  // Calculate daily rate from actual reports
  const firstDate = new Date(reports[0].date);
  const lastDate = new Date(reports[reports.length - 1].date);
  const daysElapsed = Math.max(1, Math.ceil((lastDate.getTime() - firstDate.getTime()) / 86400000) + 1);
  const dailyRate = cumulative / daysElapsed;
  const remainingDays = dailyRate > 0 ? Math.ceil(remaining / dailyRate) : 999;

  const predictedDate = new Date();
  predictedDate.setDate(predictedDate.getDate() + remainingDays);

  const dueDate = alloc.planned_end_date ? new Date(alloc.planned_end_date) : null;
  const willBeLate = dueDate ? predictedDate > dueDate : false;
  const delayDays = dueDate ? Math.ceil((predictedDate.getTime() - dueDate.getTime()) / 86400000) : 0;

  return {
    forecast_type: "completion",
    entity_type: "order",
    entity_id: allocationId,
    forecast_date: predictedDate.toISOString().slice(0, 10),
    predicted_value: remainingDays,
    unit: "days",
    confidence_score: Math.min(0.9, 0.3 + reports.length * 0.05),
    context: {
      order_id: alloc.order_id,
      total_qty: totalQty,
      cumulative,
      remaining,
      daily_rate: Math.round(dailyRate),
      remaining_days: remainingDays,
      predicted_finish: predictedDate.toISOString().slice(0, 10),
      will_be_late: willBeLate,
      delay_days: delayDays,
      due_date: alloc.planned_end_date?.slice(0, 10),
    },
  };
}

/**
 * 预测未来瓶颈（哪些天哪些工厂会超载）
 */
export async function forecastBottlenecks(supabase, horizonDays = 14) {
  const [factRes, schedRes, lineRes] = await Promise.all([
    supabase.from("factories").select("id, name").eq("status", "active"),
    supabase.from("line_schedules").select("line_id, start_date, end_date, status").in("status", ["pending", "in_progress"]),
    supabase.from("production_lines").select("id, factory_id, front_capacity_per_day").eq("status", "active"),
  ]);

  const factories = factRes.data ?? [];
  const schedules = schedRes.data ?? [];
  const lines = lineRes.data ?? [];

  // Map line → factory
  const lineFactory = new Map();
  const factoryCapacity = new Map();
  for (const l of lines) {
    lineFactory.set(l.id, l.factory_id);
    factoryCapacity.set(l.factory_id, (factoryCapacity.get(l.factory_id) ?? 0) + Number(l.front_capacity_per_day ?? 0));
  }

  // Count scheduled items per factory per day
  const today = new Date();
  const bottlenecks = [];

  for (const factory of factories) {
    const dailyLoad = new Array(horizonDays).fill(0);
    const capacity = factoryCapacity.get(factory.id) ?? 300;

    for (const s of schedules) {
      if (!lineFactory.has(s.line_id)) continue;
      if (lineFactory.get(s.line_id) !== factory.id) continue;

      const start = s.start_date ? new Date(s.start_date) : null;
      const end = s.end_date ? new Date(s.end_date) : null;
      if (!start || !end) continue;

      for (let d = 0; d < horizonDays; d++) {
        const day = new Date(today.getTime() + d * 86400000);
        if (day >= start && day <= end) {
          dailyLoad[d]++;
        }
      }
    }

    // Find overloaded days
    for (let d = 0; d < horizonDays; d++) {
      const loadPct = capacity > 0 ? (dailyLoad[d] * 300 / capacity) * 100 : 0; // rough estimate
      if (dailyLoad[d] >= 3 && loadPct > 80) {
        const day = new Date(today.getTime() + d * 86400000);
        bottlenecks.push({
          forecast_type: "bottleneck",
          entity_type: "factory",
          entity_id: factory.id,
          forecast_date: day.toISOString().slice(0, 10),
          predicted_value: dailyLoad[d],
          unit: "concurrent_orders",
          confidence_score: 0.7,
          context: {
            factory_name: factory.name,
            day_offset: d,
            scheduled_orders: dailyLoad[d],
            capacity,
            load_pct: Math.round(loadPct),
          },
        });
      }
    }
  }

  return bottlenecks;
}

/**
 * 运行所有预测
 */
export async function runDailyForecast(supabase) {
  const [factRes, allocRes] = await Promise.all([
    supabase.from("factories").select("id").eq("status", "active"),
    supabase.from("production_allocations").select("id").in("status", ["confirmed", "in_progress"]),
  ]);

  const results = { capacity: [], completion: [], bottlenecks: [] };

  // Capacity forecasts per factory
  for (const f of factRes.data ?? []) {
    const forecast = await forecastFactoryCapacity(supabase, f.id);
    results.capacity.push(forecast);
  }

  // Completion forecasts per active order
  for (const a of (allocRes.data ?? []).slice(0, 50)) { // limit to 50
    const forecast = await forecastOrderCompletion(supabase, a.id);
    if (forecast) results.completion.push(forecast);
  }

  // Bottleneck forecast
  results.bottlenecks = await forecastBottlenecks(supabase);

  // Persist forecasts
  const allForecasts = [...results.capacity, ...results.completion, ...results.bottlenecks].filter(Boolean);
  if (allForecasts.length > 0) {
    await supabase.from("forecasts").insert(
      allForecasts.map((f) => ({ ...f, computed_at: new Date().toISOString() })),
    );
  }

  return {
    total: allForecasts.length,
    capacity_risks: results.capacity.filter((c) => c.context?.at_risk).length,
    late_orders: results.completion.filter((c) => c.context?.will_be_late).length,
    bottleneck_days: results.bottlenecks.length,
  };
}
