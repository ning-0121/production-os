/**
 * LLM Agent — Claude-powered production reasoning with tool calling
 *
 * Claude 通过 tool_use 调用现有 API，实现多步推理：
 * - "为什么这个订单亏了？" → 调 profit → 调 rework → 调 quality → 综合分析
 * - "这个工厂适合做 hoodie 吗？" → 调 memory → 调 quality profile → 给出判断
 * - "下周哪些订单有风险？" → 调 forecast → 调 risk → 排序输出
 */

import Anthropic from "@anthropic-ai/sdk";
import { supabase } from "../supabase.js";

const client = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

/** 定义 Claude 可调用的工具 */
const TOOLS = [
  {
    name: "get_order_financials",
    description: "获取指定订单的财务数据（收入、各项成本、毛利、利润率）",
    input_schema: {
      type: "object",
      properties: { order_id: { type: "string", description: "订单ID (UUID)" } },
      required: ["order_id"],
    },
  },
  {
    name: "get_factory_memory",
    description: "获取工厂的历史表现画像（延期均值、准时率、返工率、事故率等）",
    input_schema: {
      type: "object",
      properties: { factory_id: { type: "string", description: "工厂ID" } },
      required: ["factory_id"],
    },
  },
  {
    name: "get_risky_orders",
    description: "获取当前有风险的订单列表（延期、偏差、物料缺口）",
    input_schema: { type: "object", properties: { limit: { type: "number", description: "返回数量上限", default: 10 } } },
  },
  {
    name: "get_factory_list",
    description: "获取所有活跃工厂及其评分",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_order_reworks",
    description: "获取指定订单的返工记录",
    input_schema: {
      type: "object",
      properties: { order_id: { type: "string" } },
      required: ["order_id"],
    },
  },
  {
    name: "get_qc_inspections",
    description: "获取指定订单或工厂的验货记录",
    input_schema: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "按订单筛选" },
        factory_id: { type: "string", description: "按工厂筛选" },
      },
    },
  },
  {
    name: "get_material_readiness",
    description: "检查指定订单的物料齐套状态",
    input_schema: {
      type: "object",
      properties: { order_id: { type: "string" } },
      required: ["order_id"],
    },
  },
  {
    name: "get_forecast",
    description: "获取工厂产能预测或订单完工预测",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["capacity", "completion", "bottleneck"], description: "预测类型" },
        entity_id: { type: "string", description: "工厂ID或订单ID" },
      },
      required: ["type"],
    },
  },
  {
    name: "get_automation_logs",
    description: "获取最近的自动化规则触发日志",
    input_schema: { type: "object", properties: { limit: { type: "number", default: 10 } } },
  },
];

/** 执行工具调用 */
async function executeTool(name, input) {
  switch (name) {
    case "get_order_financials": {
      const { data } = await supabase.from("order_financials")
        .select("*, orders(order_number, product_type, total_qty, due_date, status)")
        .eq("order_id", input.order_id).maybeSingle();
      return data ?? { error: "未找到财务数据" };
    }
    case "get_factory_memory": {
      const { data } = await supabase.from("agent_memory")
        .select("*").eq("entity_type", "factory").eq("entity_id", input.factory_id);
      return data ?? [];
    }
    case "get_risky_orders": {
      const { data } = await supabase.from("production_allocations")
        .select("id, order_id, factory_id, allocated_qty, planned_end_date, status, factories(name)")
        .in("status", ["confirmed", "in_progress"])
        .order("planned_end_date").limit(input.limit ?? 10);
      const today = new Date().toISOString().slice(0, 10);
      return (data ?? []).filter((a) => {
        const due = (a.planned_end_date ?? "").slice(0, 10);
        return due && due <= new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
      });
    }
    case "get_factory_list": {
      const { data } = await supabase.from("factories")
        .select("id, name, quality_score, delay_score, cooperation_score, status")
        .eq("status", "active").order("name");
      return data ?? [];
    }
    case "get_order_reworks": {
      const { data } = await supabase.from("rework_orders")
        .select("*, factories(name)").eq("order_id", input.order_id);
      return data ?? [];
    }
    case "get_qc_inspections": {
      let query = supabase.from("qc_inspections")
        .select("*, factories(name), qc_defects(*)").limit(20);
      if (input.order_id) query = query.eq("order_id", input.order_id);
      if (input.factory_id) query = query.eq("factory_id", input.factory_id);
      const { data } = await query;
      return data ?? [];
    }
    case "get_material_readiness": {
      const { data } = await supabase.from("material_requirements")
        .select("*, materials(code, name)").eq("order_id", input.order_id);
      return data ?? [];
    }
    case "get_forecast": {
      let query = supabase.from("forecasts").select("*")
        .eq("forecast_type", input.type).order("computed_at", { ascending: false }).limit(10);
      if (input.entity_id) query = query.eq("entity_id", input.entity_id);
      const { data } = await query;
      return data ?? [];
    }
    case "get_automation_logs": {
      const { data } = await supabase.from("automation_logs")
        .select("*").order("executed_at", { ascending: false }).limit(input.limit ?? 10);
      return data ?? [];
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

const SYSTEM_PROMPT = `你是 Production OS 的 AI 生产助手。你是一个经验丰富的服装生产总经理，熟悉排产、物料、品质、交期、利润的全流程。

你的职责：
1. 回答关于生产运营的问题（用中文）
2. 分析订单风险、工厂表现、利润问题
3. 给出具体的、可执行的建议
4. 引用真实数据支撑你的判断

规则：
- 使用工具获取真实数据，不要猜测
- 回答要简洁、直接、有行动建议
- 如果数据不足，说明并建议下一步
- 使用中文回答`;

/**
 * 运行 LLM Agent
 * @param {string} question - 用户问题
 * @param {number} maxTurns - 最大工具调用轮数
 * @returns {{ answer: string, tools_used: string[], tokens: number }}
 */
export async function runLLMAgent(question, maxTurns = 5) {
  if (!client) {
    return {
      answer: "AI 助手未配置（需要设置 ANTHROPIC_API_KEY 环境变量）",
      tools_used: [],
      tokens: 0,
    };
  }

  const messages = [{ role: "user", content: question }];
  const toolsUsed = [];
  let totalTokens = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    totalTokens += (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);

    // Check if Claude wants to use tools
    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");

    if (toolUseBlocks.length === 0) {
      // Final answer
      const textBlock = response.content.find((b) => b.type === "text");
      return {
        answer: textBlock?.text ?? "无法生成回答",
        tools_used: toolsUsed,
        tokens: totalTokens,
      };
    }

    // Execute tool calls
    messages.push({ role: "assistant", content: response.content });

    const toolResults = [];
    for (const block of toolUseBlocks) {
      toolsUsed.push(block.name);
      const result = await executeTool(block.name, block.input);
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result).slice(0, 4000), // Truncate to avoid token overflow
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  // Max turns reached
  const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
  const lastText = lastAssistant?.content?.find?.((b) => b.type === "text");
  return {
    answer: lastText?.text ?? "分析超时，请缩小问题范围",
    tools_used: toolsUsed,
    tokens: totalTokens,
  };
}
