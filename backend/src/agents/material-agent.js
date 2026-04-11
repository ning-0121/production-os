/**
 * Material Agent — 物料齐套检查 + 缺料预警 + 替代建议
 */
import { createAction } from "./types.js";

export function runMaterialAgent(context) {
  const { orders = [], requirements = [], purchaseOrders = [], inventory = [] } = context;
  const actions = [];
  const today = new Date().toISOString().slice(0, 10);

  // Build inventory lookup
  const invMap = new Map();
  for (const inv of inventory) {
    invMap.set(inv.material_id, Number(inv.qty_on_hand ?? 0) - Number(inv.qty_reserved ?? 0));
  }

  // Check each order's material requirements
  for (const order of orders) {
    const orderReqs = requirements.filter((r) => r.order_id === order.id);
    const shortages = orderReqs.filter((r) => r.status === "shortage");
    const criticalShortages = shortages.filter((r) => r.is_critical !== false);

    if (criticalShortages.length > 0) {
      // Check if PO exists for the shortage
      const materialNames = criticalShortages.map((r) => r.material_name ?? r.material_id?.slice(0, 8)).join("、");

      actions.push(createAction({
        agent: "material-agent",
        action_type: "material_shortage",
        target_type: "order",
        target_id: order.id,
        summary: `订单 ${order.order_number} 缺少关键物料：${materialNames}`,
        urgency: "critical",
        impact: `无法上线生产，影响交期 ${order.due_date}`,
        confidence: 0.95,
        params: {
          order_number: order.order_number,
          shortages: criticalShortages.map((s) => ({
            material_id: s.material_id,
            shortage_qty: s.shortage_qty,
          })),
        },
      }));
    }
  }

  // Check PO delays
  for (const po of purchaseOrders) {
    if (po.status === "sent" || po.status === "confirmed") {
      if (po.expected_date && po.expected_date < today) {
        const delayDays = Math.ceil((new Date(today).getTime() - new Date(po.expected_date).getTime()) / 86400000);
        actions.push(createAction({
          agent: "material-agent",
          action_type: "supplier_delay",
          target_type: "order",
          target_id: po.order_id ?? po.id,
          summary: `采购单 ${po.po_number} 已逾期 ${delayDays} 天未到货`,
          urgency: delayDays > 7 ? "critical" : "high",
          impact: `关联订单可能因物料延迟无法按时开工`,
          confidence: 0.9,
          params: { po_number: po.po_number, supplier_id: po.supplier_id, delay_days: delayDays },
        }));
      }
    }
  }

  // Check low inventory
  for (const inv of inventory) {
    const available = Number(inv.qty_on_hand ?? 0) - Number(inv.qty_reserved ?? 0);
    const safetyStock = Number(inv.safety_stock_qty ?? 0);
    if (safetyStock > 0 && available < safetyStock) {
      actions.push(createAction({
        agent: "material-agent",
        action_type: "low_inventory",
        target_type: "material",
        target_id: inv.material_id,
        summary: `物料 ${inv.material_code ?? inv.material_id?.slice(0, 8)} 库存低于安全库存（${available} < ${safetyStock}）`,
        urgency: "medium",
        impact: `后续订单可能因缺料延误`,
        confidence: 0.8,
        params: { available, safety_stock: safetyStock },
      }));
    }
  }

  actions.sort((a, b) => {
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    return (order[a.urgency] ?? 4) - (order[b.urgency] ?? 4);
  });

  return {
    actions,
    reasoning: `检查了 ${orders.length} 个订单、${requirements.length} 条物料需求、${purchaseOrders.length} 个采购单，发现 ${actions.length} 个问题`,
  };
}
