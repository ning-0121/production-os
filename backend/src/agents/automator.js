/**
 * Workflow Automation — 规则引擎自动触发行动
 *
 * 评估所有活跃订单/工厂，按规则触发：
 * 创建事故、生成方案、加入监控、通知负责人
 */

import { createAction } from "./types.js";

/** 内置规则 */
const BUILTIN_RULES = [
  {
    name: "严重偏差自动升级",
    trigger_type: "risk_status_critical",
    condition: (ctx) => ctx.risk_status === "critical",
    actions: ["create_incident", "generate_scenarios", "add_to_watchlist"],
    priority: 100,
  },
  {
    name: "连续偏差预警",
    trigger_type: "deviation_sustained",
    condition: (ctx) => ctx.deviation_pct !== undefined && ctx.deviation_pct < 85 && ctx.days_behind >= 2,
    actions: ["alert_manager", "add_to_watchlist"],
    priority: 90,
  },
  {
    name: "工厂超载预警",
    trigger_type: "factory_overload",
    condition: (ctx) => ctx.utilization_pct > 90,
    actions: ["alert", "suggest_redistribution"],
    priority: 80,
  },
  {
    name: "未报工跟进",
    trigger_type: "missing_report",
    condition: (ctx) => ctx.missing_report === true,
    actions: ["alert_manager", "add_to_watchlist"],
    priority: 70,
  },
  {
    name: "预测延期预警",
    trigger_type: "forecast_delay",
    condition: (ctx) => ctx.forecast_delay_days > 3,
    actions: ["generate_scenarios", "alert_manager"],
    priority: 85,
  },
];

/**
 * 评估所有规则
 * @param {Array} contexts — 每个 context 描述一个实体的当前状态
 * @returns {{ triggered: Array<{ rule, context, actions }> }}
 */
export function evaluateRules(contexts) {
  const triggered = [];

  for (const ctx of contexts) {
    for (const rule of BUILTIN_RULES) {
      try {
        if (rule.condition(ctx)) {
          triggered.push({
            rule_name: rule.name,
            trigger_type: rule.trigger_type,
            priority: rule.priority,
            context: ctx,
            actions: rule.actions,
          });
        }
      } catch {
        // Skip rules that error on this context
      }
    }
  }

  // Sort by priority (higher first)
  triggered.sort((a, b) => b.priority - a.priority);
  return { triggered };
}

/**
 * 批量扫描所有活跃订单并评估规则
 */
export async function runAutomationScan(supabase) {
  const today = new Date().toISOString().slice(0, 10);

  const [allocRes, corrRes, reportRes, factRes, forecastRes] = await Promise.all([
    supabase.from("production_allocations").select("id, order_id, factory_id, allocated_qty, planned_end_date, status")
      .in("status", ["confirmed", "in_progress"]),
    supabase.from("order_corrections").select("allocation_id, deviation_pct, risk_status, computed_at"),
    supabase.from("daily_production_reports").select("factory_id").eq("date", today),
    supabase.from("factories").select("id, name").eq("status", "active"),
    supabase.from("forecasts").select("entity_id, context")
      .eq("forecast_type", "completion").gte("computed_at", new Date(Date.now() - 86400000).toISOString()),
  ]);

  const allocations = allocRes.data ?? [];
  const corrections = corrRes.data ?? [];
  const todayReports = reportRes.data ?? [];
  const factories = factRes.data ?? [];
  const forecasts = forecastRes.data ?? [];

  const corrMap = new Map();
  for (const c of corrections) corrMap.set(c.allocation_id, c);

  const forecastMap = new Map();
  for (const f of forecasts) forecastMap.set(f.entity_id, f);

  const reportedFactories = new Set(todayReports.map((r) => r.factory_id));

  // Build contexts
  const contexts = [];

  // Per-allocation contexts
  for (const alloc of allocations) {
    const corr = corrMap.get(alloc.id);
    const forecast = forecastMap.get(alloc.id);
    contexts.push({
      entity_type: "order",
      entity_id: alloc.id,
      order_id: alloc.order_id,
      factory_id: alloc.factory_id,
      risk_status: corr?.risk_status,
      deviation_pct: corr ? Number(corr.deviation_pct ?? 100) : undefined,
      days_behind: corr?.risk_status === "falling_behind" || corr?.risk_status === "critical" ? 2 : 0,
      forecast_delay_days: forecast?.context?.delay_days ?? 0,
    });
  }

  // Per-factory contexts (missing reports)
  for (const fac of factories) {
    if (!reportedFactories.has(fac.id)) {
      contexts.push({
        entity_type: "factory",
        entity_id: fac.id,
        factory_name: fac.name,
        missing_report: true,
      });
    }
  }

  // Evaluate
  const { triggered } = evaluateRules(contexts);

  // Log triggered rules
  if (triggered.length > 0) {
    const logs = triggered.slice(0, 20).map((t) => ({
      rule_id: null, // built-in rules have no DB row; null FK is allowed
      rule_name: t.rule_name,
      trigger_type: t.trigger_type,
      trigger_context: t.context,
      actions_taken: t.actions,
      allocation_id: t.context.entity_type === "order" ? t.context.entity_id : null,
      factory_id: t.context.factory_id ?? (t.context.entity_type === "factory" ? t.context.entity_id : null),
      outcome: "triggered",
      executed_at: new Date().toISOString(),
    }));

    await supabase.from("automation_logs").insert(logs).catch(() => {});
  }

  // Generate AI actions from triggered rules
  const aiActions = triggered.slice(0, 10).map((t) => createAction({
    agent: "automator",
    action_type: t.actions[0] ?? "alert",
    target_type: t.context.entity_type,
    target_id: t.context.entity_id,
    summary: `[自动] ${t.rule_name}: ${t.context.order_id ?? t.context.factory_name ?? t.context.entity_id}`,
    urgency: t.priority >= 90 ? "critical" : t.priority >= 80 ? "high" : "medium",
    impact: `触发条件: ${t.trigger_type}`,
    confidence: 0.85,
    params: { rule: t.rule_name, trigger: t.trigger_type, context: t.context },
  }));

  return {
    scanned: contexts.length,
    triggered: triggered.length,
    actions: aiActions,
  };
}
