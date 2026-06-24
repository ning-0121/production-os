-- ════════════════════════════════════════════════════════════
-- 015 — Piece rates (计件工价) for shopfloor piece-wage TRIAL calc
-- ════════════════════════════════════════════════════════════
-- Run this in the Supabase SQL editor (same as 008–014).
--
-- Purpose: the single thing that makes workers WANT to scan — their scan turns
-- into money. This table holds the per-operation 工价 (unit price). Piece wages
-- are computed as Σ(report.output_qty × rate(operation, line)).
--
-- IMPORTANT (pilot guard): this powers a TRIAL / parallel-run calculation only.
-- It is NOT authoritative payroll. We run it alongside the factory's existing
-- wage sheet for at least one full pay cycle and reconcile (<1% error) before
-- anyone is paid from it. Nothing here writes to payroll.

CREATE TABLE IF NOT EXISTS public.piece_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  operation text NOT NULL,                       -- 工序: 平车 / 锁眼 / 裁剪 / 包装 …（与工单 operation 对应）
  line_id uuid,                                  -- NULL = 全厂通用；指定 = 该产线专用价（优先）

  unit_price numeric(12,4) NOT NULL CHECK (unit_price >= 0),  -- 元/件
  currency text NOT NULL DEFAULT 'CNY',

  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  active boolean NOT NULL DEFAULT true,
  note text,

  version integer NOT NULL DEFAULT 0,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- At most ONE active rate per (operation, line). NULL line_id is folded to a
-- sentinel so the "global" rate is also unique. A line-specific active rate and
-- a global active rate can coexist (resolver prefers the line-specific one).
CREATE UNIQUE INDEX IF NOT EXISTS uq_piece_rate_active
  ON public.piece_rates (operation, (COALESCE(line_id, '00000000-0000-0000-0000-000000000000'::uuid)))
  WHERE active;

CREATE INDEX IF NOT EXISTS idx_piece_rates_operation ON public.piece_rates(operation);
CREATE INDEX IF NOT EXISTS idx_piece_rates_line ON public.piece_rates(line_id) WHERE line_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_piece_rates_active ON public.piece_rates(active) WHERE active;
