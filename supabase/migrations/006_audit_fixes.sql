-- Migration 006: Audit fixes — missing constraints and indexes

BEGIN;

-- Add UNIQUE constraint required by materials.js readiness/check upsert
ALTER TABLE public.material_requirements
  DROP CONSTRAINT IF EXISTS uq_mat_req_order_material;
ALTER TABLE public.material_requirements
  ADD CONSTRAINT uq_mat_req_order_material UNIQUE (order_id, material_id);

COMMIT;
