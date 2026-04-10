/**
 * Agent Memory Layer — 积累历史行为模式
 *
 * 从 performance_logs, corrections, overrides, incidents, reports
 * 聚合出每个工厂/品类/产线的历史画像。
 */

/**
 * 刷新指定工厂的记忆
 */
export async function aggregateFactoryMemory(supabase, factoryId) {
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
  const since90 = new Date(Date.now() - 90 * 86400000).toISOString();

  // Parallel queries
  const [perfRes, corrRes, overRes, incRes, reportRes] = await Promise.all([
    supabase.from("factory_performance_logs").select("delay_days, actual_daily_output, quality_issue_count")
      .eq("factory_id", factoryId).gte("actual_end_date", since90),
    supabase.from("order_corrections").select("deviation_pct, risk_status")
      .eq("factory_id", factoryId).gte("computed_at", since90),
    supabase.from("scheduling_overrides").select("id")
      .eq("final_factory_id", factoryId).gte("overridden_at", since90),
    supabase.from("incidents").select("id, severity")
      .eq("factory_id", factoryId).gte("created_at", since90),
    supabase.from("daily_production_reports").select("actual_output, is_abnormal")
      .eq("factory_id", factoryId).gte("date", since30.slice(0, 10)),
  ]);

  const perf = perfRes.data ?? [];
  const corr = corrRes.data ?? [];
  const overrides = overRes.data ?? [];
  const incidents = incRes.data ?? [];
  const reports = reportRes.data ?? [];

  const metrics = [];

  // delay_avg
  if (perf.length > 0) {
    const delays = perf.map((p) => Number(p.delay_days ?? 0));
    const avg = delays.reduce((s, d) => s + d, 0) / delays.length;
    const prev = delays.slice(0, Math.ceil(delays.length / 2));
    const recent = delays.slice(Math.ceil(delays.length / 2));
    const prevAvg = prev.length > 0 ? prev.reduce((s, d) => s + d, 0) / prev.length : avg;
    const recentAvg = recent.length > 0 ? recent.reduce((s, d) => s + d, 0) / recent.length : avg;
    const trend = recentAvg < prevAvg - 0.5 ? "improving" : recentAvg > prevAvg + 0.5 ? "declining" : "stable";

    metrics.push({ metric_type: "delay_avg", value: round2(avg), sample_count: perf.length, trend });
  }

  // throughput_avg
  if (perf.length > 0) {
    const outputs = perf.map((p) => Number(p.actual_daily_output ?? 0)).filter((v) => v > 0);
    if (outputs.length > 0) {
      const avg = outputs.reduce((s, v) => s + v, 0) / outputs.length;
      metrics.push({ metric_type: "throughput_avg", value: round2(avg), sample_count: outputs.length, trend: "stable" });
    }
  }

  // on_time_rate
  if (perf.length > 0) {
    const onTime = perf.filter((p) => Number(p.delay_days ?? 0) <= 0).length;
    metrics.push({ metric_type: "on_time_rate", value: round2((onTime / perf.length) * 100), sample_count: perf.length, trend: "stable" });
  }

  // deviation_avg
  if (corr.length > 0) {
    const devs = corr.map((c) => Number(c.deviation_pct ?? 0));
    const avg = devs.reduce((s, d) => s + d, 0) / devs.length;
    metrics.push({ metric_type: "deviation_avg", value: round2(avg), sample_count: corr.length, trend: "stable" });
  }

  // rework_rate (from daily reports)
  if (reports.length > 0) {
    const abnormal = reports.filter((r) => r.is_abnormal).length;
    metrics.push({ metric_type: "rework_rate", value: round2((abnormal / reports.length) * 100), sample_count: reports.length, trend: "stable" });
  }

  // incident_rate (per 30 days)
  metrics.push({ metric_type: "incident_rate", value: incidents.length, sample_count: incidents.length, trend: "stable" });

  // override_rate
  metrics.push({ metric_type: "override_rate", value: overrides.length, sample_count: overrides.length, trend: "stable" });

  // Upsert all metrics
  for (const m of metrics) {
    await supabase.from("agent_memory").upsert({
      entity_type: "factory",
      entity_id: factoryId,
      metric_type: m.metric_type,
      period: "rolling_90d",
      value: m.value,
      sample_count: m.sample_count,
      trend: m.trend,
      computed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "entity_type,entity_id,metric_type,period" });
  }

  return metrics;
}

/**
 * 批量刷新所有工厂的记忆
 */
export async function refreshAllMemory(supabase) {
  const { data: factories } = await supabase.from("factories").select("id").eq("status", "active");
  const results = [];
  for (const f of factories ?? []) {
    const metrics = await aggregateFactoryMemory(supabase, f.id);
    results.push({ factory_id: f.id, metrics_count: metrics.length });
  }
  return { refreshed: results.length, details: results };
}

/**
 * 获取实体的记忆画像
 */
export async function getMemoryProfile(supabase, entityType, entityId) {
  const { data } = await supabase
    .from("agent_memory")
    .select("*")
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
    .order("metric_type");
  return data ?? [];
}

function round2(v) { return Math.round(v * 100) / 100; }
