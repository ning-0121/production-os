-- Migration 014: V7 Shopfloor Execution Layer
--
-- The "nervous system": lets supervisors / team leaders capture execution data
-- from the floor (output, defects, downtime, blocks). Every report flows into
-- the existing brain — runtime_events → production_runtime_lines → anomaly /
-- corrector / risk / task auto-gen / decision engine — closing the loop from
-- the floor to the AI.
--
-- NOT a generic MES: minimal, fast-capture, mobile-first execution capture.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ════════════════════════════════════════════════════════════
-- 1) shopfloor_work_orders — a unit of work assigned to a team leader
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.shopfloor_work_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  order_id text,                          -- soft ref (matches V3 text / V4 uuid)
  allocation_id uuid,                     -- soft ref to production_allocations
  factory_id uuid,
  line_id uuid,

  operation text,                         -- generic: cutting | sewing | qc | packing | ...
  planned_qty integer NOT NULL DEFAULT 0,
  completed_qty integer NOT NULL DEFAULT 0 CHECK (completed_qty >= 0),
  defect_qty integer NOT NULL DEFAULT 0 CHECK (defect_qty >= 0),

  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'in_progress', 'paused', 'completed', 'blocked'
  )),

  assigned_to text,                       -- team leader / operator
  planned_start_at timestamptz,
  planned_end_at timestamptz,
  actual_start_at timestamptz,
  actual_end_at timestamptz,

  block_reason text,                      -- set while status=blocked

  -- Optimistic concurrency (same trigger pattern as runtime/tasks)
  version integer NOT NULL DEFAULT 0,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_swo_status ON public.shopfloor_work_orders(status);
CREATE INDEX IF NOT EXISTS idx_swo_assigned ON public.shopfloor_work_orders(assigned_to);
CREATE INDEX IF NOT EXISTS idx_swo_line ON public.shopfloor_work_orders(line_id);
CREATE INDEX IF NOT EXISTS idx_swo_factory ON public.shopfloor_work_orders(factory_id);
CREATE INDEX IF NOT EXISTS idx_swo_order ON public.shopfloor_work_orders(order_id);
CREATE INDEX IF NOT EXISTS idx_swo_planned_start ON public.shopfloor_work_orders(planned_start_at);

CREATE OR REPLACE FUNCTION public.swo_version_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  IF NEW.version IS NULL THEN NEW.version := COALESCE(OLD.version,0)+1;
  ELSIF NEW.version = OLD.version THEN NEW.version := OLD.version + 1;
  ELSIF NEW.version = OLD.version + 1 THEN NULL;
  ELSE RAISE EXCEPTION 'illegal version transition on shopfloor_work_orders.id=%: % -> %', OLD.id, OLD.version, NEW.version USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_swo_version ON public.shopfloor_work_orders;
CREATE TRIGGER trg_swo_version BEFORE UPDATE ON public.shopfloor_work_orders
  FOR EACH ROW EXECUTE FUNCTION public.swo_version_guard();

-- ════════════════════════════════════════════════════════════
-- 2) shopfloor_reports — output / defect / downtime / shortage reports
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.shopfloor_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL REFERENCES public.shopfloor_work_orders(id) ON DELETE CASCADE,

  report_type text NOT NULL CHECK (report_type IN (
    'output', 'defect', 'downtime', 'material_shortage', 'labor_shortage', 'quality_issue'
  )),
  output_qty integer DEFAULT 0,
  defect_qty integer DEFAULT 0,
  downtime_minutes integer DEFAULT 0,
  reason text,
  note text,

  reported_by text,
  reported_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sr_wo ON public.shopfloor_reports(work_order_id);
CREATE INDEX IF NOT EXISTS idx_sr_type ON public.shopfloor_reports(report_type);
CREATE INDEX IF NOT EXISTS idx_sr_reported_at ON public.shopfloor_reports(reported_at DESC);

-- ════════════════════════════════════════════════════════════
-- 3) shopfloor_events — append-only audit of floor actions
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.shopfloor_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL REFERENCES public.shopfloor_work_orders(id) ON DELETE CASCADE,

  event_type text NOT NULL CHECK (event_type IN (
    'start_work', 'pause_work', 'resume_work', 'complete_work',
    'report_output', 'report_defect', 'report_blocked'
  )),
  payload jsonb NOT NULL DEFAULT '{}',
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_se_wo ON public.shopfloor_events(work_order_id);
CREATE INDEX IF NOT EXISTS idx_se_type ON public.shopfloor_events(event_type);
CREATE INDEX IF NOT EXISTS idx_se_created ON public.shopfloor_events(created_at DESC);

COMMENT ON TABLE public.shopfloor_work_orders IS 'V7 execution unit assigned to a team leader; optimistic concurrency via version trigger.';
COMMENT ON TABLE public.shopfloor_reports IS 'V7 floor reports; each feeds runtime_events → runtime_lines → AI brain.';
COMMENT ON TABLE public.shopfloor_events IS 'V7 append-only audit of floor actions.';

COMMIT;
