/**
 * AI Action 执行闭环
 *
 * 流程：Agent 生成建议 → 保存到 ai_action_logs → 用户确认 → 执行 → 记录结果
 */

import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { auditLog } from "../governance/audit.js";

const router = Router();

// GET /api/ai-actions — list recent AI actions
router.get("/", asyncHandler(async (req, res) => {
  const status = req.query.status ?? "pending";

  let query = supabase
    .from("ai_action_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);

  if (status !== "all") {
    query = query.eq("status", status);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
}));

// POST /api/ai-actions — save AI-generated actions (batch)
router.post("/", asyncHandler(async (req, res) => {
  const { actions } = req.body;
  if (!Array.isArray(actions) || actions.length === 0) {
    return res.status(400).json({ error: "actions array is required" });
  }

  const rows = actions.map((a) => ({
    action_id: a.id,
    agent: a.agent,
    action_type: a.action_type,
    target_type: a.target_type,
    target_id: a.target_id,
    summary: a.summary,
    urgency: a.urgency ?? "medium",
    confidence: a.confidence ?? 0.5,
    params: a.params ?? {},
    status: "pending",
  }));

  const { data, error } = await supabase
    .from("ai_action_logs")
    .insert(rows)
    .select();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ saved: data?.length ?? 0 });
}));

// POST /api/ai-actions/:id/execute — execute an AI action
router.post("/:id/execute", asyncHandler(async (req, res) => {
  const { data: action, error: fetchErr } = await supabase
    .from("ai_action_logs")
    .select("*")
    .eq("id", req.params.id)
    .single();

  if (fetchErr || !action) {
    return res.status(404).json({ error: "Action not found" });
  }

  if (action.status !== "pending" && action.status !== "confirmed") {
    return res.status(400).json({ error: `Action is already ${action.status}` });
  }

  const executor = req.pilotIdentity?.operator ?? "anonymous";
  let result = { success: true, message: "" };

  try {
    // Execute based on action_type
    switch (action.action_type) {
      case "add_overtime":
      case "alert":
      case "investigate":
        // These are notification/advisory actions — mark as executed
        result.message = `已标记为处理中：${action.summary}`;
        break;

      case "reschedule":
        // Mark the allocation for re-scheduling
        if (action.target_type === "order" && action.target_id) {
          await supabase
            .from("production_allocations")
            .update({ status: "planned" })
            .eq("id", action.target_id);
          result.message = `订单已重置为待排产状态，请重新排产`;
        }
        break;

      case "reassign":
        // Mark allocation as planned (unassign from current factory)
        if (action.target_type === "order" && action.target_id) {
          await supabase
            .from("production_allocations")
            .update({ status: "planned" })
            .eq("id", action.target_id);
          result.message = `订单已取消当前工厂分配，请重新分配`;
        }
        break;

      case "escalate":
        // Log escalation
        result.message = `已升级处理：${action.summary}`;
        break;

      case "recalibrate":
        // Update factory capacity if params contain suggestion
        if (action.params?.suggested_capacity && action.target_id) {
          const cap = Number(action.params.suggested_capacity);
          if (cap > 0) {
            // Find the factory's first capability and update
            const { data: caps } = await supabase
              .from("factory_capabilities")
              .select("id")
              .eq("factory_id", action.target_id)
              .limit(1);
            if (caps?.[0]) {
              await supabase
                .from("factory_capabilities")
                .update({ daily_capacity: cap })
                .eq("id", caps[0].id);
              result.message = `工厂产能已调整为 ${cap}/天`;
            }
          }
        }
        break;

      case "adjust_plan":
        result.message = `已标记为需要调整计划：${action.summary}`;
        break;

      default:
        result.message = `已执行：${action.action_type}`;
    }
  } catch (err) {
    result = { success: false, message: err.message ?? "执行失败" };
  }

  // Update action status
  const newStatus = result.success ? "executed" : "failed";
  await supabase
    .from("ai_action_logs")
    .update({
      status: newStatus,
      executed_by: executor,
      executed_at: new Date().toISOString(),
      result,
    })
    .eq("id", req.params.id);

  auditLog({
    action: "ai_action.execute",
    category: "ai",
    result_status: result.success ? "success" : "failed",
    req,
    detail: { action_id: req.params.id, action_type: action.action_type, result },
  });

  res.json({ executed: result.success, result });
}));

// POST /api/ai-actions/:id/reject — reject an AI action
router.post("/:id/reject", asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from("ai_action_logs")
    .update({ status: "rejected" })
    .eq("id", req.params.id)
    .eq("status", "pending")
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  auditLog({
    action: "ai_action.reject",
    category: "ai",
    result_status: "success",
    req,
    detail: { action_id: req.params.id },
  });

  res.json(data);
}));

export default router;
