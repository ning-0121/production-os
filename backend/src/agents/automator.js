/**
 * Workflow Automation v2 — 基于 json-rules-engine 的可配置规则引擎
 *
 * 升级点：
 * - 规则从硬编码 → JSON 配置（可存 Supabase）
 * - 支持 AND/OR 复合条件
 * - 支持优先级排序
 * - 支持动态添加/禁用规则
 */

import { Engine } from "json-rules-engine";
import { createAction } from "./types.js";

/**
 * 内置规则定义（JSON 格式，可存入 automation_rules 表）
 */
const BUILTIN_RULES = [
  {
    name: "严重偏差自动升级",
    priority: 100,
    conditions: {
      all: [
        { fact: "risk_status", operator: "equal", value: "critical" },
        { fact: "entity_type", operator: "equal", value: "order" },
      ],
    },
    event: {
      type: "critical_risk",
      params: { actions: ["create_incident", "generate_scenarios", "add_to_watchlist"], urgency: "critical" },
    },
  },
  {
    name: "连续偏差预警",
    priority: 90,
    conditions: {
      all: [
        { fact: "deviation_pct", operator: "lessThan", value: 85 },
        { fact: "days_behind", operator: "greaterThanInclusive", value: 2 },
      ],
    },
    event: {
      type: "sustained_deviation",
      params: { actions: ["create_incident", "alert_manager"], urgency: "high" },
    },
  },
  {
    name: "工厂超载预警",
    priority: 80,
    conditions: {
      all: [
        { fact: "utilization_pct", operator: "greaterThan", value: 90 },
      ],
    },
    event: {
      type: "factory_overload",
      params: { actions: ["alert", "suggest_redistribution"], urgency: "high" },
    },
  },
  {
    name: "未报工跟进",
    priority: 70,
    conditions: {
      all: [
        { fact: "missing_report", operator: "equal", value: true },
      ],
    },
    event: {
      type: "missing_report",
      params: { actions: ["alert_manager", "add_to_watchlist"], urgency: "medium" },
    },
  },
  {
    name: "预测延期预警",
    priority: 85,
    conditions: {
      all: [
        { fact: "forecast_delay_days", operator: "greaterThan", value: 3 },
      ],
    },
    event: {
      type: "forecast_delay",
      params: { actions: ["generate_scenarios", "alert_manager"], urgency: "high" },
    },
  },
  {
    name: "低利润订单预警",
    priority: 75,
    conditions: {
      all: [
        { fact: "margin_pct", operator: "lessThan", value: 8 },
        { fact: "entity_type", operator: "equal", value: "order" },
      ],
    },
    event: {
      type: "low_margin",
      params: { actions: ["alert", "reprice_suggestion"], urgency: "medium" },
    },
  },
  {
    name: "物料缺口预警",
    priority: 95,
    conditions: {
      all: [
        { fact: "material_shortage", operator: "equal", value: true },
        { fact: "days_to_start", operator: "lessThan", value: 5 },
      ],
    },
    event: {
      type: "material_critical",
      params: { actions: ["create_incident", "freeze_scheduling", "alert_procurement"], urgency: "critical" },
    },
  },
];

/**
 * 创建规则引擎实例
 * @param {Array} customRules - 自定义规则（从 Supabase automation_rules 加载）
 */
function createEngine(customRules = []) {
  const engine = new Engine([], { allowUndefinedFacts: true });

  // 加载内置规则
  for (const rule of BUILTIN_RULES) {
    engine.addRule({
      name: rule.name,
      priority: rule.priority,
      conditions: rule.conditions,
      event: rule.event,
    });
  }

  // 加载自定义规则（从数据库）
  for (const rule of customRules) {
    try {
      engine.addRule({
        name: rule.name,
        priority: rule.priority ?? 50,
        conditions: typeof rule.condition_json === "string" ? JSON.parse(rule.condition_json) : rule.condition_json,
        event: {
          type: rule.trigger_type,
          params: { actions: typeof rule.actions_json === "string" ? JSON.parse(rule.actions_json) : rule.actions_json, urgency: "medium" },
        },
      });
    } catch {
      // Skip invalid rules
    }
  }

  return engine;
}

/**
 * 评估所有规则（使用 json-rules-engine）
 */
export async function evaluateRules(contexts, customRules = []) {
  const engine = createEngine(customRules);
  const triggered = [];

  for (const ctx of contexts) {
    try {
      const { events } = await engine.run(ctx);
      for (const event of events) {
        triggered.push({
          rule_name: event.type,
          trigger_type: event.type,
          priority: event.params?.urgency === "critical" ? 100 : event.params?.urgency === "high" ? 80 : 60,
          context: ctx,
          actions: event.params?.actions ?? [],
          urgency: event.params?.urgency ?? "medium",
        });
      }
    } catch {
      // Skip contexts that cause engine errors
    }
  }

  triggered.sort((a, b) => b.priority - a.priority);
  return { triggered };
}

/**
 * 批量扫描所有活跃订单并评估规则
 */
export async function runAutomationScan(supabase) {
  const today = new Date().toISOString().slice(0, 10);

  const [allocRes, corrRes, reportRes, factRes, forecastRes, rulesRes] = await Promise.all([
    supabase.from("production_allocations").select("id, order_id, factory_id, allocated_qty, planned_end_date, status")
      .in("status", ["confirmed", "in_progress"]),
    supabase.from("order_corrections").select("allocation_id, deviation_pct, risk_status, computed_at"),
    supabase.from("daily_production_reports").select("factory_id").eq("date", today),
    supabase.from("factories").select("id, name").eq("status", "active"),
    supabase.from("forecasts").select("entity_id, context")
      .eq("forecast_type", "completion").gte("computed_at", new Date(Date.now() - 86400000).toISOString()),
    supabase.from("automation_rules").select("*").eq("enabled", true),
  ]);

  const allocations = allocRes.data ?? [];
  const corrections = corrRes.data ?? [];
  const factories = factRes.data ?? [];
  const forecasts = forecastRes.data ?? [];
  const customRules = rulesRes.data ?? [];
  const reportedFactories = new Set((reportRes.data ?? []).map((r) => r.factory_id));

  const corrMap = new Map();
  for (const c of corrections) corrMap.set(c.allocation_id, c);
  const forecastMap = new Map();
  for (const f of forecasts) forecastMap.set(f.entity_id, f);

  // Build contexts
  const contexts = [];

  for (const alloc of allocations) {
    const corr = corrMap.get(alloc.id);
    const forecast = forecastMap.get(alloc.id);
    contexts.push({
      entity_type: "order",
      entity_id: alloc.id,
      order_id: alloc.order_id,
      factory_id: alloc.factory_id,
      risk_status: corr?.risk_status ?? "on_track",
      deviation_pct: corr ? Number(corr.deviation_pct ?? 100) : 100,
      days_behind: corr?.risk_status === "falling_behind" || corr?.risk_status === "critical" ? 2 : 0,
      forecast_delay_days: forecast?.context?.delay_days ?? 0,
      missing_report: false,
      material_shortage: false,
      days_to_start: 999,
      margin_pct: 100,
      utilization_pct: 0,
    });
  }

  for (const fac of factories) {
    if (!reportedFactories.has(fac.id)) {
      contexts.push({
        entity_type: "factory",
        entity_id: fac.id,
        factory_name: fac.name,
        missing_report: true,
        risk_status: "on_track",
        deviation_pct: 100,
        days_behind: 0,
        forecast_delay_days: 0,
        material_shortage: false,
        days_to_start: 999,
        margin_pct: 100,
        utilization_pct: 0,
      });
    }
  }

  // Evaluate with rules engine
  const { triggered } = await evaluateRules(contexts, customRules);

  // Log
  if (triggered.length > 0) {
    const logs = triggered.slice(0, 20).map((t) => ({
      rule_id: null,
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

  // Generate AI actions
  const aiActions = triggered.slice(0, 10).map((t) => createAction({
    agent: "automator",
    action_type: t.actions[0] ?? "alert",
    target_type: t.context.entity_type,
    target_id: t.context.entity_id,
    summary: `[自动] ${t.rule_name}: ${t.context.order_id ?? t.context.factory_name ?? t.context.entity_id}`,
    urgency: t.urgency,
    impact: `触发条件: ${t.trigger_type}`,
    confidence: 0.85,
    params: { rule: t.rule_name, trigger: t.trigger_type, context: t.context },
  }));

  return {
    scanned: contexts.length,
    triggered: triggered.length,
    rules_loaded: BUILTIN_RULES.length + customRules.length,
    actions: aiActions,
  };
}

/**
 * 导出内置规则定义（供前端展示/API 返回）
 */
export function getBuiltinRules() {
  return BUILTIN_RULES.map((r) => ({
    name: r.name,
    priority: r.priority,
    conditions: r.conditions,
    actions: r.event.params.actions,
    urgency: r.event.params.urgency,
    source: "builtin",
  }));
}
