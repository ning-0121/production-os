/**
 * Forecast Engine v2 — ARIMA 时序预测
 *
 * 升级点：
 * - ARIMA/AutoARIMA 替代线性估算
 * - 产能预测：基于历史日产出训练模型
 * - 完工预测：基于累计产出曲线拟合
 * - 瓶颈预测：多工厂并行预测交叉分析
 * - 回退机制：数据不足时降级为线性估算
 */

import ARIMA from "arima";
import * as ss from "simple-statistics";

/**
 * 使用 ARIMA 预测时间序列
 * @param {number[]} data - 历史数据（至少 7 个点）
 * @param {number} steps - 预测步数
 * @returns {number[]} 预测值
 */
function arimaForecast(data, steps = 7) {
  if (data.length < 7) {
    // 数据不足，降级为线性回归预测
    return linearFallback(data, steps);
  }

  try {
    const arima = new ARIMA({ auto: true, verbose: false });
    arima.train(data);
    const [predicted] = arima.predict(steps);
    return predicted.map((v) => Math.max(0, Math.round(v)));
  } catch {
    // ARIMA 训练失败，降级
    return linearFallback(data, steps);
  }
}

/**
 * 线性回归回退预测
 */
function linearFallback(data, steps) {
  if (data.length < 2) return new Array(steps).fill(data[0] ?? 0);

  const points = data.map((v, i) => [i, v]);
  const reg = ss.linearRegression(points);
  const line = ss.linearRegressionLine(reg);
  const result = [];
  for (let i = 0; i < steps; i++) {
    result.push(Math.max(0, Math.round(line(data.length + i))));
  }
  return result;
}

/**
 * 预测工厂未来产能
 */
export async function forecastFactoryCapacity(supabase, factoryId, horizonDays = 14) {
  const since30d = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  const [reportsRes, schedRes, lineRes] = await Promise.all([
    supabase.from("daily_production_reports").select("actual_output, date")
      .eq("factory_id", factoryId).gte("date", since30d).order("date"),
    supabase.from("line_schedules").select("line_id, start_date, end_date, production_allocations(allocated_qty)")
      .eq("status", "pending"),
    supabase.from("production_lines").select("id, front_capacity_per_day, back_capacity_per_day")
      .eq("factory_id", factoryId).eq("status", "active"),
  ]);

  const reports = reportsRes.data ?? [];
  const schedules = schedRes.data ?? [];
  const lines = lineRes.data ?? [];

  // 按天聚合产出
  const dailyMap = new Map();
  for (const r of reports) {
    dailyMap.set(r.date, (dailyMap.get(r.date) ?? 0) + Number(r.actual_output ?? 0));
  }
  const dailyOutputs = [...dailyMap.values()];

  // ARIMA 预测未来日产出
  const predicted = arimaForecast(dailyOutputs, horizonDays);
  const projectedOutput = predicted.reduce((s, v) => s + v, 0);

  // 当前日均（用于对比）
  const currentDailyAvg = dailyOutputs.length > 0 ? Math.round(ss.mean(dailyOutputs)) : 0;
  const predictedDailyAvg = predicted.length > 0 ? Math.round(ss.mean(predicted)) : 0;

  // 总容量
  const dailyCapacity = lines.reduce((s, l) =>
    s + Math.max(Number(l.front_capacity_per_day ?? 0), Number(l.back_capacity_per_day ?? 0)), 0);

  // 已排产需求
  const lineIds = new Set(lines.map((l) => l.id));
  const scheduledQty = schedules
    .filter((s) => lineIds.has(s.line_id))
    .reduce((sum, s) => sum + Number(s.production_allocations?.allocated_qty ?? 0), 0);

  const gap = scheduledQty - projectedOutput;
  const method = dailyOutputs.length >= 7 ? "arima" : "linear_regression";

  return {
    forecast_type: "capacity",
    entity_type: "factory",
    entity_id: factoryId,
    horizon_days: horizonDays,
    forecast_date: null,
    predicted_value: projectedOutput,
    unit: "units",
    confidence_score: Math.min(0.95, 0.3 + dailyOutputs.length * 0.03),
    actual_value: null,
    error_pct: null,
    context: {
      daily_avg_current: currentDailyAvg,
      daily_avg_predicted: predictedDailyAvg,
      daily_capacity: dailyCapacity,
      scheduled_qty: scheduledQty,
      gap,
      gap_pct: projectedOutput > 0 ? Math.round((gap / projectedOutput) * 100) : 0,
      at_risk: gap > 0,
      method,
      forecast_series: predicted,
      data_points: dailyOutputs.length,
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
  const dailyOutputs = reports.map((r) => Number(r.actual_output ?? 0));
  const cumulative = dailyOutputs.reduce((s, v) => s + v, 0);
  const remaining = Math.max(0, totalQty - cumulative);

  if (dailyOutputs.length === 0 || cumulative === 0) {
    return {
      forecast_type: "completion",
      entity_type: "order",
      entity_id: allocationId,
      forecast_date: null,
      predicted_value: null,
      unit: "days",
      confidence_score: 0.2,
      actual_value: null,
      error_pct: null,
      context: { reason: "无日报数据，无法预测", cumulative: 0, remaining, total: totalQty, method: "none" },
    };
  }

  // 用 ARIMA 预测未来每天产出，累加直到达到 remaining
  const futureDaily = arimaForecast(dailyOutputs, 60); // 最多预测 60 天

  let accum = 0;
  let remainingDays = 0;
  for (const dayOutput of futureDaily) {
    accum += dayOutput;
    remainingDays++;
    if (accum >= remaining) break;
  }

  if (accum < remaining) {
    remainingDays = futureDaily.length; // 60天都完不成
  }

  const predictedDate = new Date();
  predictedDate.setDate(predictedDate.getDate() + remainingDays);

  const dueDate = alloc.planned_end_date ? new Date(alloc.planned_end_date) : null;
  const willBeLate = dueDate ? predictedDate > dueDate : false;
  const delayDays = dueDate ? Math.ceil((predictedDate.getTime() - dueDate.getTime()) / 86400000) : 0;

  const method = dailyOutputs.length >= 7 ? "arima" : "linear_regression";

  return {
    forecast_type: "completion",
    entity_type: "order",
    entity_id: allocationId,
    forecast_date: predictedDate.toISOString().slice(0, 10),
    predicted_value: remainingDays,
    unit: "days",
    confidence_score: Math.min(0.95, 0.3 + dailyOutputs.length * 0.04),
    actual_value: null,
    error_pct: null,
    context: {
      order_id: alloc.order_id,
      total_qty: totalQty,
      cumulative,
      remaining,
      daily_rate_current: Math.round(ss.mean(dailyOutputs)),
      daily_rate_predicted: futureDaily.length > 0 ? Math.round(ss.mean(futureDaily.slice(0, Math.min(7, futureDaily.length)))) : 0,
      remaining_days: remainingDays,
      predicted_finish: predictedDate.toISOString().slice(0, 10),
      will_be_late: willBeLate,
      delay_days: delayDays,
      due_date: alloc.planned_end_date?.slice(0, 10),
      method,
      data_points: dailyOutputs.length,
    },
  };
}

/**
 * 预测未来瓶颈
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

  const lineFactory = new Map();
  const factoryCapacity = new Map();
  for (const l of lines) {
    lineFactory.set(l.id, l.factory_id);
    factoryCapacity.set(l.factory_id, (factoryCapacity.get(l.factory_id) ?? 0) + Number(l.front_capacity_per_day ?? 0));
  }

  const today = new Date();
  const bottlenecks = [];

  for (const factory of factories) {
    const dailyLoad = new Array(horizonDays).fill(0);
    const capacity = factoryCapacity.get(factory.id) ?? 300;

    for (const s of schedules) {
      if (!lineFactory.has(s.line_id) || lineFactory.get(s.line_id) !== factory.id) continue;
      const start = s.start_date ? new Date(s.start_date) : null;
      const end = s.end_date ? new Date(s.end_date) : null;
      if (!start || !end) continue;

      for (let d = 0; d < horizonDays; d++) {
        const day = new Date(today.getTime() + d * 86400000);
        if (day >= start && day <= end) dailyLoad[d]++;
      }
    }

    for (let d = 0; d < horizonDays; d++) {
      const loadPct = capacity > 0 ? (dailyLoad[d] * 300 / capacity) * 100 : 0;
      if (dailyLoad[d] >= 3 && loadPct > 80) {
        const day = new Date(today.getTime() + d * 86400000);
        bottlenecks.push({
          forecast_type: "bottleneck",
          entity_type: "factory",
          entity_id: factory.id,
          horizon_days: horizonDays,
          forecast_date: day.toISOString().slice(0, 10),
          predicted_value: dailyLoad[d],
          unit: "concurrent_orders",
          confidence_score: 0.7,
          actual_value: null,
          error_pct: null,
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

  for (const f of factRes.data ?? []) {
    const forecast = await forecastFactoryCapacity(supabase, f.id);
    results.capacity.push(forecast);
  }

  for (const a of (allocRes.data ?? []).slice(0, 50)) {
    const forecast = await forecastOrderCompletion(supabase, a.id);
    if (forecast) results.completion.push(forecast);
  }

  results.bottlenecks = await forecastBottlenecks(supabase);

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
    methods_used: {
      arima: allForecasts.filter((f) => f.context?.method === "arima").length,
      linear: allForecasts.filter((f) => f.context?.method === "linear_regression").length,
    },
  };
}

// Export for testing
export { arimaForecast, linearFallback };
