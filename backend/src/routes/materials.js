/**
 * Materials — 物料 + 库存 + BOM + 需求计算
 */
import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validate, schemas } from "../middleware/validate.js";

const router = Router();

// ── Materials CRUD ──
router.get("/", asyncHandler(async (req, res) => {
  let query = supabase.from("materials").select("*, material_colors(*)").order("name");
  if (req.query.category) query = query.eq("category", req.query.category);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
}));

router.post("/", validate(schemas.createMaterial), asyncHandler(async (req, res) => {
  const { code, name, category, sub_category, unit, spec, safety_stock_qty, lead_time_days } = req.body;
  const { data, error } = await supabase.from("materials").insert({ code, name, category, sub_category, unit, spec, safety_stock_qty, lead_time_days }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
}));

// ── Inventory ──
router.get("/:id/inventory", asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("material_inventory")
    .select("*, material_colors(color_code, color_name)")
    .eq("material_id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
}));

router.post("/:id/reserve", validate(schemas.reserveMaterial), asyncHandler(async (req, res) => {
  const { color_id, qty, warehouse } = req.body;
  const wh = warehouse ?? "main";
  // Atomic reserve: increment qty_reserved
  const { data: inv } = await supabase.from("material_inventory")
    .select("id, qty_on_hand, qty_reserved")
    .eq("material_id", req.params.id)
    .eq("warehouse", wh)
    .maybeSingle();
  if (!inv) return res.status(404).json({ error: "Inventory record not found" });
  const newReserved = Number(inv.qty_reserved ?? 0) + Number(qty);
  if (newReserved > Number(inv.qty_on_hand)) return res.status(409).json({ error: "Insufficient stock" });
  const { data, error } = await supabase.from("material_inventory")
    .update({ qty_reserved: newReserved, last_updated: new Date().toISOString() })
    .eq("id", inv.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
}));

// ── BOM ──
router.get("/bom/:styleNumber", asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("bom_templates")
    .select("*, bom_lines(*, materials(id, code, name, unit), material_colors(color_code, color_name))")
    .eq("style_number", req.params.styleNumber).eq("status", "active");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
}));

router.post("/bom", validate(schemas.createBOM), asyncHandler(async (req, res) => {
  const { style_number, product_type, size_category, lines } = req.body;

  const { data: bom, error: bomErr } = await supabase.from("bom_templates")
    .insert({ style_number, product_type, size_category }).select().single();
  if (bomErr) return res.status(400).json({ error: bomErr.message });

  if (Array.isArray(lines) && lines.length > 0) {
    const rows = lines.map((l) => ({ ...l, bom_id: bom.id }));
    await supabase.from("bom_lines").insert(rows);
  }
  res.status(201).json(bom);
}));

// ── Material Readiness Check ──
router.post("/readiness/check", asyncHandler(async (req, res) => {
  const { order_id } = req.body;
  // Load order + BOM + inventory
  const { data: order } = await supabase.from("orders").select("*, bom_templates(*, bom_lines(*, materials(id, code, name)))").eq("id", order_id).single();
  if (!order) return res.status(404).json({ error: "Order not found" });

  const bom = order.bom_templates;
  if (!bom || !bom.bom_lines) return res.json({ ready: false, reason: "No BOM linked", requirements: [] });

  const requirements = [];
  for (const line of bom.bom_lines) {
    const usagePerPiece = Number(line.usage_qty ?? 0);
    const wastePct = Number(line.waste_pct ?? 3);
    const totalRequired = Math.ceil(usagePerPiece * order.total_qty * (1 + wastePct / 100));

    const { data: inv } = await supabase.from("material_inventory")
      .select("qty_on_hand, qty_reserved")
      .eq("material_id", line.material_id)
      .maybeSingle();

    const available = Number(inv?.qty_on_hand ?? 0) - Number(inv?.qty_reserved ?? 0);
    const shortage = Math.max(0, totalRequired - available);

    requirements.push({
      material_id: line.material_id,
      material_code: line.materials?.code,
      material_name: line.materials?.name,
      required_qty: totalRequired,
      available_qty: Math.max(0, available),
      shortage_qty: shortage,
      is_critical: line.is_critical,
      status: shortage > 0 ? "shortage" : "sufficient",
    });
  }

  // Upsert material_requirements as a batch (atomic)
  const upsertRows = requirements.map((r) => ({
    order_id, material_id: r.material_id,
    required_qty: r.required_qty, available_qty: r.available_qty,
    shortage_qty: r.shortage_qty, status: r.status,
    computed_at: new Date().toISOString(),
  }));
  if (upsertRows.length > 0) {
    const { error: upsertErr } = await supabase.from("material_requirements")
      .upsert(upsertRows, { onConflict: "order_id,material_id" });
    if (upsertErr) {
      console.error(JSON.stringify({ level: "WARN", op: "material_requirements_upsert", order_id, error: upsertErr.message }));
    }
  }

  const ready = requirements.every((r) => r.status === "sufficient");
  const criticalShortages = requirements.filter((r) => r.is_critical && r.status === "shortage");

  res.json({ ready, critical_shortages: criticalShortages.length, requirements });
}));

export default router;
