/**
 * Profit Dashboard API — Order P&L aggregation + customer/factory profitability
 */
import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { createAction } from "../agents/types.js";

const router = Router();

// GET /api/profit/dashboard — full P&L dashboard data
router.get("/dashboard", asyncHandler(async (_req, res) => {
  const [finRes, ordersRes, custRes, factRes, reworkRes] = await Promise.all([
    supabase.from("order_financials").select("*, orders(id, order_number, product_type, total_qty, due_date, status, customer_id, customers(id, name, code, vip_level))"),
    supabase.from("orders").select("id, order_number, product_type, total_qty, unit_price, currency, due_date, status, customer_id, customers(id, name, vip_level)").in("status", ["confirmed", "in_production", "shipped", "completed"]),
    supabase.from("customers").select("*"),
    supabase.from("factories").select("id, name, quality_score, delay_score"),
    supabase.from("rework_orders").select("order_id, cost, delay_days, factory_id, status"),
  ]);

  const financials = finRes.data ?? [];
  const orders = ordersRes.data ?? [];
  const customers = custRes.data ?? [];
  const factories = factRes.data ?? [];
  const reworks = reworkRes.data ?? [];

  // ── KPI ──
  const totalRevenue = financials.reduce((s, f) => s + Number(f.revenue ?? 0), 0);
  const totalCost = financials.reduce((s, f) => s + Number(f.fabric_cost ?? 0) + Number(f.trim_cost ?? 0) + Number(f.cmt_cost ?? 0) + Number(f.rework_cost ?? 0) + Number(f.freight_cost ?? 0) + Number(f.duty_cost ?? 0) + Number(f.compensation_cost ?? 0) + Number(f.other_cost ?? 0), 0);
  const grossProfit = totalRevenue - totalCost;
  const grossMarginPct = totalRevenue > 0 ? Math.round((grossProfit / totalRevenue) * 100) : 0;
  const totalReworkCost = financials.reduce((s, f) => s + Number(f.rework_cost ?? 0), 0);
  const totalFreightCost = financials.reduce((s, f) => s + Number(f.freight_cost ?? 0) + Number(f.duty_cost ?? 0), 0);

  const lowMarginOrders = financials.filter((f) => {
    const rev = Number(f.revenue ?? 0);
    const margin = rev > 0 ? ((rev - totalCostOf(f)) / rev) * 100 : 0;
    return margin < 10 && margin >= 0;
  });
  const negativeOrders = financials.filter((f) => {
    const rev = Number(f.revenue ?? 0);
    return rev > 0 && (rev - totalCostOf(f)) < 0;
  });

  // ── Order profit table ──
  const orderProfitTable = financials.map((f) => {
    const order = f.orders;
    const rev = Number(f.revenue ?? 0);
    const cost = totalCostOf(f);
    const profit = rev - cost;
    const marginPct = rev > 0 ? Math.round((profit / rev) * 100) : 0;
    const customer = order?.customers;

    let riskTag = "safe";
    if (marginPct < 0) riskTag = "negative";
    else if (marginPct < 8) riskTag = "critical";
    else if (marginPct < 15) riskTag = "warning";

    return {
      order_id: f.order_id,
      order_number: order?.order_number ?? "—",
      product_type: order?.product_type ?? "—",
      customer_name: customer?.name ?? "—",
      customer_vip: customer?.vip_level ?? "standard",
      revenue: rev,
      fabric_cost: Number(f.fabric_cost ?? 0),
      trim_cost: Number(f.trim_cost ?? 0),
      cmt_cost: Number(f.cmt_cost ?? 0),
      rework_cost: Number(f.rework_cost ?? 0),
      freight_cost: Number(f.freight_cost ?? 0),
      duty_cost: Number(f.duty_cost ?? 0),
      compensation_cost: Number(f.compensation_cost ?? 0),
      total_cost: cost,
      gross_profit: profit,
      margin_pct: marginPct,
      risk_tag: riskTag,
      status: f.status,
    };
  });

  orderProfitTable.sort((a, b) => a.margin_pct - b.margin_pct);

  // ── Customer profitability ──
  const customerMap = new Map();
  for (const row of orderProfitTable) {
    const name = row.customer_name;
    if (!customerMap.has(name)) customerMap.set(name, { name, revenue: 0, cost: 0, orders: 0, rework_cost: 0 });
    const c = customerMap.get(name);
    c.revenue += row.revenue;
    c.cost += row.total_cost;
    c.orders++;
    c.rework_cost += row.rework_cost;
  }
  const customerProfitability = [...customerMap.values()].map((c) => ({
    ...c,
    profit: c.revenue - c.cost,
    margin_pct: c.revenue > 0 ? Math.round(((c.revenue - c.cost) / c.revenue) * 100) : 0,
  })).sort((a, b) => a.margin_pct - b.margin_pct);

  // ── Factory ROI ──
  const factoryReworkCost = new Map();
  for (const rw of reworks) {
    if (rw.factory_id) {
      factoryReworkCost.set(rw.factory_id, (factoryReworkCost.get(rw.factory_id) ?? 0) + Number(rw.cost ?? 0));
    }
  }
  const factoryROI = factories.map((f) => ({
    factory_id: f.id,
    name: f.name,
    quality_score: f.quality_score,
    delay_score: f.delay_score,
    rework_cost: factoryReworkCost.get(f.id) ?? 0,
  })).sort((a, b) => b.rework_cost - a.rework_cost);

  // ── AI Insights ──
  const insights = [];

  // Low margin customers
  for (const c of customerProfitability) {
    if (c.margin_pct < 8 && c.orders >= 2) {
      insights.push(createAction({
        agent: "profit-agent",
        action_type: "reprice_customer",
        target_type: "customer",
        target_id: c.name,
        summary: `客户 ${c.name} 平均利润率仅 ${c.margin_pct}%（${c.orders} 单），建议重新定价`,
        urgency: c.margin_pct < 0 ? "critical" : "high",
        impact: `继续按当前价格接单将持续亏损`,
        confidence: 0.85,
        params: { margin_pct: c.margin_pct, orders: c.orders, revenue: c.revenue },
      }));
    }
  }

  // High rework cost factories
  for (const f of factoryROI) {
    if (f.rework_cost > 5000) {
      insights.push(createAction({
        agent: "profit-agent",
        action_type: "review_factory",
        target_type: "factory",
        target_id: f.factory_id,
        summary: `工厂 ${f.name} 本期返工成本 ¥${f.rework_cost.toLocaleString()}，看似便宜实则高成本`,
        urgency: "high",
        impact: `返工成本侵蚀利润，建议评估是否继续合作`,
        confidence: 0.8,
        params: { rework_cost: f.rework_cost, quality_score: f.quality_score },
      }));
    }
  }

  // Negative margin orders
  for (const o of negativeOrders) {
    const order = o.orders;
    insights.push(createAction({
      agent: "profit-agent",
      action_type: "stop_loss",
      target_type: "order",
      target_id: o.order_id,
      summary: `订单 ${order?.order_number ?? "?"} 已亏损，实际利润率为负`,
      urgency: "critical",
      impact: `继续生产将扩大亏损`,
      confidence: 0.95,
      params: { order_number: order?.order_number },
    }));
  }

  insights.sort((a, b) => {
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    return (order[a.urgency] ?? 4) - (order[b.urgency] ?? 4);
  });

  res.json({
    kpi: {
      total_revenue: totalRevenue,
      total_cost: totalCost,
      gross_profit: grossProfit,
      gross_margin_pct: grossMarginPct,
      rework_loss: totalReworkCost,
      freight_loss: totalFreightCost,
      low_margin_count: lowMarginOrders.length,
      negative_count: negativeOrders.length,
      total_orders: financials.length,
    },
    orders: orderProfitTable,
    customers: customerProfitability,
    factories: factoryROI,
    insights,
  });
}));

function totalCostOf(f) {
  return Number(f.fabric_cost ?? 0) + Number(f.trim_cost ?? 0) + Number(f.cmt_cost ?? 0) +
    Number(f.rework_cost ?? 0) + Number(f.freight_cost ?? 0) + Number(f.duty_cost ?? 0) +
    Number(f.compensation_cost ?? 0) + Number(f.other_cost ?? 0);
}

export default router;
