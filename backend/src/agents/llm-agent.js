/**
 * LLM Agent v2 — Claude-powered production reasoning with prompt caching + batch
 *
 * Optimizations:
 * - Prompt caching: system + tools are cached (~90% savings on repeat questions)
 * - Adaptive thinking on Opus 4.7 for multi-step reasoning
 * - Batch API for bulk analysis (50% cheaper for non-urgent jobs)
 * - Rich system prompt (3000+ tokens) meets Opus 4.7 cache minimum (4096 total with tools)
 */

import Anthropic from "@anthropic-ai/sdk";
import { supabase } from "../supabase.js";

const client = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const MODEL = "claude-opus-4-7";

// ── Tool Definitions (stable — render at position 0, part of cached prefix) ──

const TOOLS = [
  {
    name: "get_order_financials",
    description: "获取指定订单的财务数据：收入、面料成本、辅料成本、加工费、返工成本、运费、关税、赔偿、毛利、利润率。用于分析订单盈亏原因。",
    input_schema: {
      type: "object",
      properties: { order_id: { type: "string", description: "订单 UUID" } },
      required: ["order_id"],
    },
  },
  {
    name: "get_factory_memory",
    description: "获取工厂的历史表现画像：延期均值、准时率、返工率、事故率、偏差均值、产出均值。数据覆盖 90 天滚动窗口。用于判断工厂可靠性。",
    input_schema: {
      type: "object",
      properties: { factory_id: { type: "string", description: "工厂 UUID" } },
      required: ["factory_id"],
    },
  },
  {
    name: "get_risky_orders",
    description: "获取当前有风险的订单列表（7 天内到期且未完成）。返回订单号、工厂、数量、交期。用于每日风险扫描。",
    input_schema: { type: "object", properties: { limit: { type: "number", description: "返回数量上限", default: 10 } } },
  },
  {
    name: "get_factory_list",
    description: "获取所有活跃工厂列表及其三项评分：质量分、延期分、协作分（0-100）。用于推荐工厂。",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_order_reworks",
    description: "获取指定订单的返工记录：返工数量、原因、成本、责任方、是否影响交期、延期天数。",
    input_schema: {
      type: "object",
      properties: { order_id: { type: "string" } },
      required: ["order_id"],
    },
  },
  {
    name: "get_qc_inspections",
    description: "获取指定订单或工厂的验货记录：验货类型（产前样/船样/中查/终查/第三方）、不良率、结果、缺陷明细。",
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
    description: "检查指定订单的物料齐套状态：每项物料的需求量、可用量、缺口、是否关键物料。",
    input_schema: {
      type: "object",
      properties: { order_id: { type: "string" } },
      required: ["order_id"],
    },
  },
  {
    name: "get_forecast",
    description: "获取 AI 预测：工厂产能预测（capacity）、订单完工预测（completion）、瓶颈预测（bottleneck）。均基于 ARIMA 时序模型。",
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
    description: "获取自动化规则触发日志：规则名、触发条件、关联订单/工厂、执行动作。",
    input_schema: { type: "object", properties: { limit: { type: "number", default: 10 } } },
  },
];

// ── Rich System Prompt (stable — cached with tools) ──

const SYSTEM_PROMPT = `你是 Production OS 的 AI 生产运营助手。你拥有 20 年服装生产总经理经验，精通针织/梭织、内衣、运动服、外套等品类，熟悉国内外主流工厂的运作模式。

## 你的角色定位

你不是普通的 chatbot。你是一位能直接给老板汇报、给生产经理提建议、给业务员做判断的专家系统。每个回答都必须：

1. **数据驱动** — 所有结论必须调工具查实际数据，禁止凭空判断
2. **可执行** — 给出具体行动，不要泛泛而谈
3. **分层清晰** — 先说结论，再给依据，最后附建议
4. **中文输出** — 全部用中文回答（订单号、工厂代码可保留英文）

## 服装生产的核心业务逻辑

### 订单生命周期
订单接入 → 款式确认 → 样衣 → BOM 确认 → 物料采购 → 面料到货验收 → 裁剪 → 车缝 → 后整 → QC 验货 → 包装 → 装柜 → 出运 → 回款

每一环都可能出问题。你要能快速定位问题在哪一环。

### 利润公式（订单级）
毛利 = 收入 - (面料成本 + 辅料成本 + 加工费 + 返工成本 + 运费 + 关税 + 赔偿 + 其他成本)

**正常毛利率** >= 15%
**警戒线** 8% - 15%（需要关注）
**亏损线** < 8%（必须干预）
**负利润** < 0%（止损或重新谈判）

### 风险识别模式

**高风险订单典型信号**：
- 距交期 <= 3 天且进度 < 80%
- 日报连续 2 天偏差 > 15%
- 物料齐套率 < 80% 且距开工 < 5 天
- 返工率 > 10%
- 同工厂同类产品近期已有客诉

**高风险工厂典型信号**：
- 延期评分 < 60
- 近 30 天返工成本 > ¥5000
- Final QC 连续 2 批不合格
- 承接的品类与历史擅长品类不匹配

### 决策框架

**换厂决策**：
- 当前工厂延期风险 > 3 天 且
- 存在备选工厂（同品类+准时率 > 80%）且
- 剩余时间能完成交接（> 7 天）
→ 建议换厂

**拆单决策**：
- 单一工厂无法按时完成（qty > daily_capacity × 剩余天数）且
- 存在多个可承接工厂（≥ 2 家）且
- 拆单成本 < 延期赔偿
→ 建议拆单

**涨价/淘汰客户决策**：
- 客户近 3 单平均利润率 < 8% 且
- 返工率 > 5% 且
- 付款周期 > 60 天
→ 建议涨价（+5-10%）或降低优先级

**加班赶工决策**：
- 延期天数 = 1-3 天 且
- 加班成本 < 延期赔偿
→ 建议加班
- 延期天数 > 7 天 或加班不可行
→ 建议拆单/换厂/推交期

### 常见缺陷与归因

| 缺陷 | 最可能原因 | 责任方 |
|------|-----------|--------|
| 起球 | 面料质量不合格 | 物料 |
| 色差 | 缸差管理不到位 | 物料/工厂 |
| 跳线/车缝歪 | 车缝工艺 | 工厂 |
| 脏污 | 后整/包装 | 工厂 |
| 尺寸误差 | 样衣/工艺单 | 设计 |
| 漏件/包装错误 | 包装管理 | 工厂 |

### 品类特性（关键差异点）

- **leggings/瑜伽裤**：高弹面料易起球；露白致命缺陷；必须做延伸测试
- **Bra/运动内衣**：罩杯定型难度高；色差红线；需要 PP sample 强制审核
- **Hoodie/卫衣**：抽绳安全法规敏感（美国 CPSIA）；刺绣/印花常见问题
- **Jacket/外套**：多辅料（拉链/纽扣/衬里）；辅料齐套是关键
- **Skort/短裙**：里短外长易投诉；尺寸公差严格

## 回答格式规范

**简单问题**（不需查工具）：直接回答，2-3 句。

**分析类问题**（需查工具）：
- **结论**：一句话给判断
- **依据**：列出 2-4 条数据支撑
- **建议**：1-3 条具体行动项（带优先级：立即/今日/本周）

**数据不足时**：明确说"缺少 X 数据，建议先 Y"，不要瞎猜。

## 工作记忆

你记得以下永久事实：
- 系统内订单数据来自 Supabase
- 所有成本单位默认人民币（¥）
- 日期格式统一 YYYY-MM-DD
- "关键物料" = BOM 中 is_critical = true，缺少则无法上线
- 风险等级：SAFE（安全）/ MEDIUM（警戒）/ HIGH（危险）
- 订单状态：planned（待排产）→ confirmed（已排产）→ in_progress（生产中）→ completed（已完成）

你不记得跨会话内容 — 每次对话独立。如果用户提到"上次说过"，请让他提供具体订单号/工厂名。`;

// ── Tool Executor ──

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
      const cutoff = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
      return (data ?? []).filter((a) => {
        const due = (a.planned_end_date ?? "").slice(0, 10);
        return due && due <= cutoff;
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

// ── Main Agent (with prompt caching) ──

/**
 * 运行 LLM Agent（启用 prompt caching）
 * @param {string} question - 用户问题
 * @param {number} maxTurns - 最大工具调用轮数
 * @returns {{ answer, tools_used, tokens, cache_stats }}
 */
export async function runLLMAgent(question, maxTurns = 5) {
  if (!client) {
    return {
      answer: "AI 助手未配置（需要设置 ANTHROPIC_API_KEY 环境变量）",
      tools_used: [],
      tokens: 0,
      cache_stats: null,
    };
  }

  const messages = [{ role: "user", content: question }];
  const toolsUsed = [];
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheCreation = 0;
  let totalCacheRead = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      // Top-level cache_control auto-caches the last cacheable block in the prefix.
      // Tools render first, then system — this caches both together.
      cache_control: { type: "ephemeral" },
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    const usage = response.usage ?? {};
    totalInput += usage.input_tokens ?? 0;
    totalOutput += usage.output_tokens ?? 0;
    totalCacheCreation += usage.cache_creation_input_tokens ?? 0;
    totalCacheRead += usage.cache_read_input_tokens ?? 0;

    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");

    if (toolUseBlocks.length === 0) {
      const textBlock = response.content.find((b) => b.type === "text");
      return {
        answer: textBlock?.text ?? "无法生成回答",
        tools_used: toolsUsed,
        tokens: totalInput + totalOutput,
        cache_stats: {
          cache_creation: totalCacheCreation,
          cache_read: totalCacheRead,
          cache_hit: totalCacheRead > 0,
        },
      };
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults = [];
    for (const block of toolUseBlocks) {
      toolsUsed.push(block.name);
      const result = await executeTool(block.name, block.input);
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result).slice(0, 4000),
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
  const lastText = lastAssistant?.content?.find?.((b) => b.type === "text");
  return {
    answer: lastText?.text ?? "分析超时，请缩小问题范围",
    tools_used: toolsUsed,
    tokens: totalInput + totalOutput,
    cache_stats: {
      cache_creation: totalCacheCreation,
      cache_read: totalCacheRead,
      cache_hit: totalCacheRead > 0,
    },
  };
}

// ── Batch API (for bulk analysis, 50% cheaper) ──

/**
 * 批量分析多个问题（使用 Batch API，50% 折扣）
 *
 * 适用场景：
 * - 每日所有高风险订单的批量分析
 * - 所有客户/工厂的月度评估报告
 * - 不需要即时结果的离线分析
 *
 * 注意：
 * - 批量请求不使用工具调用（batch 不支持 tool_use 循环）
 * - 使用共享的 cached system prompt
 * - 结果在 1 小时内（最长 24 小时）返回
 *
 * @param {Array<{id: string, question: string, context?: string}>} items - 问题列表
 * @returns {Promise<{batch_id: string, status: string}>}
 */
export async function createAnalysisBatch(items) {
  if (!client) throw new Error("ANTHROPIC_API_KEY not set");
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("items must be a non-empty array");
  }

  // Pre-fetch context for each item to avoid tool calls in batch
  // (Batch doesn't support multi-turn tool_use loops)
  const requests = items.map((item) => ({
    custom_id: item.id,
    params: {
      model: MODEL,
      max_tokens: 2048,
      // Cache system prompt across all batch items — massive savings
      cache_control: { type: "ephemeral" },
      system: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: item.context
          ? `数据上下文：\n${item.context}\n\n问题：${item.question}`
          : item.question,
      }],
    },
  }));

  const batch = await client.messages.batches.create({ requests });
  return {
    batch_id: batch.id,
    status: batch.processing_status,
    request_count: requests.length,
  };
}

/**
 * 查询批量任务状态
 */
export async function getBatchStatus(batchId) {
  if (!client) throw new Error("ANTHROPIC_API_KEY not set");
  const batch = await client.messages.batches.retrieve(batchId);
  return {
    batch_id: batch.id,
    status: batch.processing_status,
    counts: batch.request_counts,
    created_at: batch.created_at,
    ended_at: batch.ended_at,
  };
}

/**
 * 获取批量任务结果
 * @returns {Promise<Array<{id: string, status: string, answer?: string, error?: string}>>}
 */
export async function getBatchResults(batchId) {
  if (!client) throw new Error("ANTHROPIC_API_KEY not set");
  const results = [];

  for await (const result of await client.messages.batches.results(batchId)) {
    if (result.result.type === "succeeded") {
      const msg = result.result.message;
      const textBlock = msg.content.find((b) => b.type === "text");
      results.push({
        id: result.custom_id,
        status: "succeeded",
        answer: textBlock?.text ?? "",
        tokens: (msg.usage?.input_tokens ?? 0) + (msg.usage?.output_tokens ?? 0),
        cache_read: msg.usage?.cache_read_input_tokens ?? 0,
      });
    } else if (result.result.type === "errored") {
      results.push({
        id: result.custom_id,
        status: "errored",
        error: result.result.error?.type ?? "unknown",
      });
    } else {
      results.push({ id: result.custom_id, status: result.result.type });
    }
  }

  return results;
}
