/**
 * Validation schema tests — Zod schemas for v4 routes
 * Run: node --test backend/tests/validation.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { schemas } from "../src/middleware/validate.js";

const FAKE_UUID = "550e8400-e29b-41d4-a716-446655440000";

// ── Materials ─────────────────────────────────────────

describe("Material Schemas", () => {
  it("accepts valid material", () => {
    const result = schemas.createMaterial.safeParse({
      code: "FB-001", name: "Cotton Jersey 200gsm", category: "fabric",
    });
    assert.ok(result.success);
    assert.equal(result.data.unit, "yard"); // default
  });

  it("rejects invalid category", () => {
    const result = schemas.createMaterial.safeParse({
      code: "FB-001", name: "x", category: "invalid",
    });
    assert.ok(!result.success);
  });

  it("rejects empty code", () => {
    const result = schemas.createMaterial.safeParse({
      code: "", name: "x", category: "fabric",
    });
    assert.ok(!result.success);
  });

  it("reserves quantity must be positive", () => {
    const r1 = schemas.reserveMaterial.safeParse({ qty: 0 });
    const r2 = schemas.reserveMaterial.safeParse({ qty: -5 });
    const r3 = schemas.reserveMaterial.safeParse({ qty: 100 });
    assert.ok(!r1.success);
    assert.ok(!r2.success);
    assert.ok(r3.success);
  });
});

// ── BOM ───────────────────────────────────────────────

describe("BOM Schemas", () => {
  it("accepts valid BOM with lines", () => {
    const result = schemas.createBOM.safeParse({
      style_number: "ST-001",
      product_type: "leggings",
      lines: [{
        material_id: FAKE_UUID,
        usage_qty: 1.5,
        is_critical: true,
      }],
    });
    assert.ok(result.success);
    assert.equal(result.data.size_category, "missy");
    assert.equal(result.data.lines[0].waste_pct, 3);
  });

  it("rejects negative usage", () => {
    const result = schemas.createBOM.safeParse({
      style_number: "ST-001",
      product_type: "leggings",
      lines: [{ material_id: FAKE_UUID, usage_qty: -1 }],
    });
    assert.ok(!result.success);
  });

  it("waste_pct max 50", () => {
    const result = schemas.createBOM.safeParse({
      style_number: "ST-001",
      product_type: "leggings",
      lines: [{ material_id: FAKE_UUID, usage_qty: 1, waste_pct: 60 }],
    });
    assert.ok(!result.success);
  });
});

// ── Procurement ───────────────────────────────────────

describe("Procurement Schemas", () => {
  it("accepts valid PO with multiple lines", () => {
    const result = schemas.createPO.safeParse({
      po_number: "PO-2026-001",
      supplier_id: FAKE_UUID,
      expected_date: "2026-05-01",
      lines: [
        { material_id: FAKE_UUID, qty_ordered: 1000, unit_price: 5.5 },
        { material_id: FAKE_UUID, qty_ordered: 500, unit_price: 3.2 },
      ],
    });
    assert.ok(result.success);
  });

  it("rejects PO without lines", () => {
    const result = schemas.createPO.safeParse({
      po_number: "PO-001",
      supplier_id: FAKE_UUID,
      expected_date: "2026-05-01",
      lines: [],
    });
    assert.ok(!result.success);
  });

  it("supplier email validation", () => {
    const r1 = schemas.createSupplier.safeParse({
      code: "SUP-001", name: "X Corp", contact_email: "not-an-email",
    });
    const r2 = schemas.createSupplier.safeParse({
      code: "SUP-001", name: "X Corp", contact_email: "valid@example.com",
    });
    const r3 = schemas.createSupplier.safeParse({
      code: "SUP-001", name: "X Corp", contact_email: "",
    });
    assert.ok(!r1.success);
    assert.ok(r2.success);
    assert.ok(r3.success); // empty allowed
  });

  it("receivePO requires non-empty lines", () => {
    const r1 = schemas.receivePO.safeParse({ lines: [] });
    const r2 = schemas.receivePO.safeParse({
      lines: [{ line_id: FAKE_UUID, qty_received: 100 }],
    });
    assert.ok(!r1.success);
    assert.ok(r2.success);
  });
});

// ── Quality ───────────────────────────────────────────

describe("Quality Schemas", () => {
  it("accepts valid inspection", () => {
    const result = schemas.createInspection.safeParse({
      inspection_type: "final",
      total_qty_inspected: 200,
      total_defects: 3,
      result: "pass",
    });
    assert.ok(result.success);
  });

  it("rejects invalid inspection type", () => {
    const result = schemas.createInspection.safeParse({
      inspection_type: "magic",
    });
    assert.ok(!result.success);
  });

  it("inspection with defects", () => {
    const result = schemas.createInspection.safeParse({
      inspection_type: "final",
      defects: [
        { defect_code: "DEF-001", severity: "major", qty: 5 },
        { defect_code: "DEF-002", severity: "critical", qty: 1 },
      ],
    });
    assert.ok(result.success);
  });

  it("rework with cost validation", () => {
    const r1 = schemas.createRework.safeParse({
      rework_qty: 50,
      cost: -100, // negative cost should fail
    });
    const r2 = schemas.createRework.safeParse({
      rework_qty: 50,
      cost: 500,
    });
    assert.ok(!r1.success);
    assert.ok(r2.success);
  });

  it("update rework requires at least one field", () => {
    const r1 = schemas.updateRework.safeParse({});
    const r2 = schemas.updateRework.safeParse({ status: "completed" });
    assert.ok(!r1.success);
    assert.ok(r2.success);
  });

  it("invalid responsible_party rejected", () => {
    const result = schemas.createRework.safeParse({
      rework_qty: 10,
      responsible_party: "AI",
    });
    assert.ok(!result.success);
  });
});

// ── Financials ────────────────────────────────────────

describe("Financials Schemas", () => {
  it("accepts financials with all costs", () => {
    const result = schemas.upsertFinancials.safeParse({
      order_id: FAKE_UUID,
      revenue: 50000,
      fabric_cost: 20000,
      cmt_cost: 10000,
      rework_cost: 2000,
      gross_margin_pct: 18,
    });
    assert.ok(result.success);
  });

  it("rejects negative cost", () => {
    const result = schemas.upsertFinancials.safeParse({
      order_id: FAKE_UUID,
      fabric_cost: -100,
    });
    assert.ok(!result.success);
  });
});

// ── Orders V2 ─────────────────────────────────────────

describe("Order V2 Schemas", () => {
  it("accepts valid order", () => {
    const result = schemas.createOrderV2.safeParse({
      order_number: "ORD-2026-100",
      product_type: "hoodie",
      total_qty: 1000,
      unit_price: 12.5,
    });
    assert.ok(result.success);
    assert.equal(result.data.currency, "USD");
    assert.equal(result.data.priority, 0);
  });

  it("rejects non-positive qty", () => {
    const result = schemas.createOrderV2.safeParse({
      order_number: "ORD-001",
      product_type: "hoodie",
      total_qty: 0,
    });
    assert.ok(!result.success);
  });
});

// ── LLM Question ──────────────────────────────────────

describe("LLM Question Schema", () => {
  it("accepts valid question", () => {
    const result = schemas.llmQuestion.safeParse({ question: "今天哪些订单有风险？" });
    assert.ok(result.success);
  });

  it("rejects empty question", () => {
    const result = schemas.llmQuestion.safeParse({ question: "" });
    assert.ok(!result.success);
  });

  it("rejects too-long question", () => {
    const result = schemas.llmQuestion.safeParse({
      question: "x".repeat(2001),
    });
    assert.ok(!result.success);
  });

  it("rejects non-string question", () => {
    const result = schemas.llmQuestion.safeParse({ question: 123 });
    assert.ok(!result.success);
  });
});
