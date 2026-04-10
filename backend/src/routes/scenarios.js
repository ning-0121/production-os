/**
 * Scenarios API — 多方案生成与执行
 */

import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { auditLog } from "../governance/audit.js";
import { generateScenarios } from "../scheduler/scenario-generator.js";

const router = Router();

// GET /api/orders/:id/scenarios — 为指定订单生成方案
router.get("/:id/scenarios", asyncHandler(async (req, res) => {
  // 1. Load allocation
  const { data: alloc, error: allocErr } = await supabase
    .from("production_allocations")
    .select("*, factories(id, name)")
    .eq("id", req.params.id)
    .single();
  if (allocErr) return res.status(404).json({ error: "订单不存在" });

  // 2. Load factories with capabilities
  const { data: factories } = await supabase
    .from("factories")
    .select("*, factory_capabilities(*)")
    .eq("status", "active");

  // 3. Load existing allocations for impact analysis
  const { data: existingAllocs } = await supabase
    .from("production_allocations")
    .select("id, order_id, factory_id, allocated_qty, planned_start_date, planned_end_date, status")
    .in("status", ["confirmed", "in_progress"]);

  // 4. Build factory inputs (same format as recommend endpoint)
  const horizon = 30;
  const dailyMinutes = 8 * 60;
  const windowEnd = new Date(Date.now() + horizon * 86400000).toISOString();

  const { data: loadData } = await supabase
    .from("production_allocations")
    .select("factory_id, allocated_qty")
    .in("status", ["planned", "confirmed", "in_progress"])
    .lte("planned_start_date", windowEnd);

  const loadByFactory = {};
  for (const a of loadData ?? []) {
    if (!loadByFactory[a.factory_id]) loadByFactory[a.factory_id] = 0;
    const fac = (factories ?? []).find((f) => f.id === a.factory_id);
    const cap = fac?.factory_capabilities?.[0];
    if (cap) {
      const mpu = cap.daily_capacity > 0 ? 480 / cap.daily_capacity : 0;
      loadByFactory[a.factory_id] += (a.allocated_qty ?? 0) * mpu;
    }
  }

  const factoryInputs = (factories ?? []).map((f) => {
    const capacityWindow = dailyMinutes * horizon;
    const allocated = loadByFactory[f.id] ?? 0;
    return {
      id: f.id,
      name: f.name,
      capabilities: (f.factory_capabilities ?? []).map((c) => ({
        product_type: c.product_type,
        daily_capacity: c.daily_capacity ?? c.base_capacity_units_per_day ?? 0,
        setup_minutes: c.setup_minutes ?? 0,
        minutes_per_unit: c.daily_capacity > 0 ? 480 / c.daily_capacity : 0,
        base_capacity_units_per_day: c.daily_capacity ?? c.base_capacity_units_per_day ?? 0,
        cost_per_unit: c.cost_per_unit ?? null,
        quality_score: f.quality_score ?? null,
      })),
      capacity: { daily_capacity_minutes: dailyMinutes },
      load: {
        allocated_minutes_next_30d: allocated,
        utilization_pct: Math.min(100, (allocated / Math.max(1, capacityWindow)) * 100),
      },
    };
  });

  // 5. Generate scenarios
  const order = {
    product_type: alloc.product_type ?? null,
    quantity: alloc.allocated_qty ?? alloc.quantity ?? 0,
    due_date: (alloc.planned_end_date ?? alloc.end_at ?? "").slice(0, 10),
    order_id: alloc.order_id ?? alloc.order_external_id ?? alloc.id,
  };

  const scenarios = generateScenarios(order, factoryInputs, existingAllocs ?? []);

  // 6. Persist scenarios
  const rows = scenarios.map((s) => ({
    order_id: order.order_id,
    allocation_id: alloc.id,
    ...s,
  }));

  // Delete old pending scenarios for this order
  await supabase
    .from("order_scenarios")
    .update({ status: "expired" })
    .eq("allocation_id", alloc.id)
    .eq("status", "pending");

  const { data: saved } = await supabase
    .from("order_scenarios")
    .insert(rows)
    .select();

  res.json({
    order_id: order.order_id,
    allocation_id: alloc.id,
    scenarios: saved ?? scenarios,
  });
}));

// POST /api/orders/:id/scenarios/:scenarioId/apply — 执行选中方案
router.post("/:id/scenarios/:scenarioId/apply", asyncHandler(async (req, res) => {
  const { data: scenario, error: scErr } = await supabase
    .from("order_scenarios")
    .select("*")
    .eq("id", req.params.scenarioId)
    .eq("status", "pending")
    .single();

  if (scErr || !scenario) {
    return res.status(404).json({ error: "方案不存在或已执行" });
  }

  const executor = req.pilotIdentity?.operator ?? "anonymous";

  // If scenario has a target factory, update the allocation
  if (scenario.target_factory_id) {
    await supabase
      .from("production_allocations")
      .update({
        factory_id: scenario.target_factory_id,
        status: "confirmed",
        planned_end_date: scenario.expected_finish_date
          ? new Date(scenario.expected_finish_date).toISOString()
          : undefined,
      })
      .eq("id", scenario.allocation_id);
  }

  // Mark scenario as applied
  await supabase
    .from("order_scenarios")
    .update({ status: "applied" })
    .eq("id", scenario.id);

  // Mark other scenarios for this order as rejected
  await supabase
    .from("order_scenarios")
    .update({ status: "rejected" })
    .eq("allocation_id", scenario.allocation_id)
    .eq("status", "pending")
    .neq("id", scenario.id);

  // Log the action
  await supabase
    .from("scenario_actions")
    .insert({
      scenario_id: scenario.id,
      action_type: "apply_scenario",
      action_payload: { scenario_type: scenario.scenario_type, factory_id: scenario.target_factory_id },
      executed_by: executor,
    });

  // Check if this is an override (not the top-recommended scenario)
  const { data: allScenarios } = await supabase
    .from("order_scenarios")
    .select("id, recommendation_score, scenario_type")
    .eq("allocation_id", scenario.allocation_id)
    .order("recommendation_score", { ascending: false });

  const topScenario = allScenarios?.[0];
  if (topScenario && topScenario.id !== scenario.id) {
    // User chose a non-top scenario → record override
    await supabase
      .from("scheduling_overrides")
      .insert({
        order_id: scenario.order_id,
        allocation_id: scenario.allocation_id,
        original_scenario_type: topScenario.scenario_type,
        final_scenario_type: scenario.scenario_type,
        final_factory_id: scenario.target_factory_id,
        final_factory_name: scenario.target_factory_name,
        final_finish_date: scenario.expected_finish_date,
        override_reason: req.body.reason ?? "用户选择替代方案",
        override_type: "scenario_override",
        overridden_by: executor,
      });
  }

  auditLog({
    action: "scenario.apply",
    category: "scheduling",
    result_status: "success",
    req,
    detail: {
      scenario_id: scenario.id,
      scenario_type: scenario.scenario_type,
      order_id: scenario.order_id,
      factory: scenario.target_factory_name,
      is_override: topScenario?.id !== scenario.id,
    },
  });

  res.json({ applied: true, scenario });
}));

export default router;
