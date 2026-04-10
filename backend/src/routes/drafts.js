/**
 * Schedule Drafts — 排产草稿管理
 *
 * 流程：AI/用户创建草稿 → 预览风险 → 经理确认 → 写入 line_schedules → 审计日志
 */

import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validate, schemas } from "../middleware/validate.js";
import { auditLog } from "../governance/audit.js";

const router = Router();

// GET /api/drafts — list all pending drafts
router.get("/", asyncHandler(async (_req, res) => {
  const { data, error } = await supabase
    .from("schedule_drafts")
    .select("*, production_allocations(id, order_id, allocated_qty, product_type, planned_end_date), production_lines(id, name, factory_id, factories(id, name))")
    .eq("status", "draft")
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
}));

// POST /api/drafts — create a schedule draft (preview, don't persist to line_schedules)
router.post("/", asyncHandler(async (req, res) => {
  const { allocation_id, line_id, front_start, front_end, front_days, back_start, back_end, back_days, risk_level, buffer_days } = req.body;

  if (!allocation_id || !line_id) {
    return res.status(400).json({ error: "allocation_id and line_id are required" });
  }

  const { data, error } = await supabase
    .from("schedule_drafts")
    .insert({
      allocation_id,
      line_id,
      front_start, front_end, front_days,
      back_start, back_end, back_days,
      risk_level: risk_level ?? "SAFE",
      buffer_days: buffer_days ?? 0,
      created_by: req.pilotIdentity?.operator ?? "anonymous",
      status: "draft",
    })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  auditLog({
    action: "draft.create",
    category: "scheduling",
    result_status: "success",
    req,
    detail: { draft_id: data.id, allocation_id, line_id },
  });

  res.status(201).json(data);
}));

// POST /api/drafts/:id/confirm — confirm draft → write to line_schedules + update allocation
router.post("/:id/confirm", asyncHandler(async (req, res) => {
  // 1. Load the draft
  const { data: draft, error: draftErr } = await supabase
    .from("schedule_drafts")
    .select("*")
    .eq("id", req.params.id)
    .eq("status", "draft")
    .single();

  if (draftErr || !draft) {
    return res.status(404).json({ error: "草稿不存在或已被确认" });
  }

  // 2. Get next seq for this line
  const { data: existingSeq } = await supabase
    .from("line_schedules")
    .select("seq")
    .eq("line_id", draft.line_id)
    .eq("process", "front")
    .order("seq", { ascending: false })
    .limit(1);

  const nextSeq = (existingSeq?.[0]?.seq ?? 0) + 1;

  // 3. Insert line_schedules (front + back)
  const rows = [
    { line_id: draft.line_id, allocation_id: draft.allocation_id, process: "front", start_date: draft.front_start, end_date: draft.front_end, seq: nextSeq, status: "pending" },
    { line_id: draft.line_id, allocation_id: draft.allocation_id, process: "back", start_date: draft.back_start, end_date: draft.back_end, seq: nextSeq, status: "pending" },
  ];

  const { error: schedErr } = await supabase
    .from("line_schedules")
    .insert(rows);

  if (schedErr) return res.status(500).json({ error: schedErr.message });

  // 4. Update allocation status to confirmed
  await supabase
    .from("production_allocations")
    .update({ status: "confirmed" })
    .eq("id", draft.allocation_id);

  // 5. Update draft status
  const confirmedBy = req.pilotIdentity?.operator ?? "anonymous";
  const { data: updated, error: updateErr } = await supabase
    .from("schedule_drafts")
    .update({
      status: "confirmed",
      confirmed_by: confirmedBy,
      confirmed_at: new Date().toISOString(),
    })
    .eq("id", req.params.id)
    .select()
    .single();

  if (updateErr) return res.status(500).json({ error: updateErr.message });

  auditLog({
    action: "draft.confirm",
    category: "scheduling",
    result_status: "success",
    req,
    detail: {
      draft_id: draft.id,
      allocation_id: draft.allocation_id,
      line_id: draft.line_id,
      confirmed_by: confirmedBy,
      front: `${draft.front_start} ~ ${draft.front_end}`,
      back: `${draft.back_start} ~ ${draft.back_end}`,
    },
  });

  res.json({ confirmed: true, draft: updated });
}));

// POST /api/drafts/:id/reject — reject a draft
router.post("/:id/reject", asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from("schedule_drafts")
    .update({ status: "rejected" })
    .eq("id", req.params.id)
    .eq("status", "draft")
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  auditLog({
    action: "draft.reject",
    category: "scheduling",
    result_status: "success",
    req,
    detail: { draft_id: req.params.id },
  });

  res.json(data);
}));

export default router;
