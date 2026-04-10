-- Migration 002: Add missing production tables
-- These tables are required by the application but were created directly in Supabase
-- without migration files. This migration ensures schema reproducibility.
--
-- Tables added:
--   - production_lines (factory production lines with front/back capacity)
--   - line_schedules (schedule blocks on production lines)
--   - daily_production_reports (daily output reports)
--   - order_corrections (progress deviation tracking)
--
-- Also adds missing columns to existing tables:
--   - factories: quality_score, delay_score, cooperation_score, location, lat, lng
--   - production_allocations: column aliases (the schema uses start_at/end_at/quantity
--     but code uses planned_start_date/planned_end_date/allocated_qty — we add views/aliases)

BEGIN;

-- ══════════════════════════════════════════════════════════
-- 1) Add missing columns to factories
-- ══════════════════════════════════════════════════════════

ALTER TABLE public.factories
  ADD COLUMN IF NOT EXISTS location text,
  ADD COLUMN IF NOT EXISTS lat numeric(10,7),
  ADD COLUMN IF NOT EXISTS lng numeric(10,7),
  ADD COLUMN IF NOT EXISTS quality_score numeric(6,2) DEFAULT 80,
  ADD COLUMN IF NOT EXISTS delay_score numeric(6,2) DEFAULT 80,
  ADD COLUMN IF NOT EXISTS cooperation_score numeric(6,2) DEFAULT 80;

-- ══════════════════════════════════════════════════════════
-- 2) Add missing columns to production_allocations
--    Code uses: order_id, allocated_qty, planned_start_date, planned_end_date
--    Schema has: order_external_id, quantity, start_at, end_at
--    We add the code-expected columns if they don't exist
-- ══════════════════════════════════════════════════════════

ALTER TABLE public.production_allocations
  ADD COLUMN IF NOT EXISTS order_id text,
  ADD COLUMN IF NOT EXISTS allocated_qty numeric(14,4),
  ADD COLUMN IF NOT EXISTS planned_start_date timestamptz,
  ADD COLUMN IF NOT EXISTS planned_end_date timestamptz,
  ADD COLUMN IF NOT EXISTS recommendation_score numeric(6,2),
  ADD COLUMN IF NOT EXISTS is_locked boolean DEFAULT false;

-- Sync data from original columns to new columns (if original columns exist)
-- This is idempotent: only updates where new columns are null
DO $$
BEGIN
  -- Sync order_external_id → order_id
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='production_allocations' AND column_name='order_external_id') THEN
    UPDATE public.production_allocations SET order_id = order_external_id WHERE order_id IS NULL AND order_external_id IS NOT NULL;
  END IF;
  -- Sync quantity → allocated_qty
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='production_allocations' AND column_name='quantity') THEN
    UPDATE public.production_allocations SET allocated_qty = quantity WHERE allocated_qty IS NULL AND quantity IS NOT NULL;
  END IF;
  -- Sync start_at → planned_start_date
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='production_allocations' AND column_name='start_at') THEN
    UPDATE public.production_allocations SET planned_start_date = start_at WHERE planned_start_date IS NULL AND start_at IS NOT NULL;
  END IF;
  -- Sync end_at → planned_end_date
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='production_allocations' AND column_name='end_at') THEN
    UPDATE public.production_allocations SET planned_end_date = end_at WHERE planned_end_date IS NULL AND end_at IS NOT NULL;
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════
-- 3) Add missing columns to factory_capabilities
-- ══════════════════════════════════════════════════════════

ALTER TABLE public.factory_capabilities
  ADD COLUMN IF NOT EXISTS daily_capacity numeric(14,4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS efficiency_rate numeric(6,4),
  ADD COLUMN IF NOT EXISTS overtime_factor numeric(6,4) DEFAULT 1.0;

-- Sync base_capacity_units_per_day → daily_capacity
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='factory_capabilities' AND column_name='base_capacity_units_per_day') THEN
    UPDATE public.factory_capabilities SET daily_capacity = base_capacity_units_per_day WHERE daily_capacity = 0 AND base_capacity_units_per_day > 0;
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════
-- 4) Add missing columns to factory_performance_logs
-- ══════════════════════════════════════════════════════════

ALTER TABLE public.factory_performance_logs
  ADD COLUMN IF NOT EXISTS order_id text,
  ADD COLUMN IF NOT EXISTS delay_days numeric(10,2),
  ADD COLUMN IF NOT EXISTS actual_daily_output numeric(14,4),
  ADD COLUMN IF NOT EXISTS quality_issue_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS actual_start_date timestamptz,
  ADD COLUMN IF NOT EXISTS actual_end_date timestamptz,
  ADD COLUMN IF NOT EXISTS notes text;

-- ══════════════════════════════════════════════════════════
-- 5) production_lines
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.production_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  front_capacity_per_day numeric(14,4) DEFAULT 300,
  back_capacity_per_day numeric(14,4) DEFAULT 200,
  capacity numeric(14,4),
  product_types text[] DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lines_factory ON public.production_lines(factory_id);
CREATE INDEX IF NOT EXISTS idx_lines_status ON public.production_lines(status);

DROP TRIGGER IF EXISTS trg_production_lines_updated_at ON public.production_lines;
CREATE TRIGGER trg_production_lines_updated_at
BEFORE UPDATE ON public.production_lines
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ══════════════════════════════════════════════════════════
-- 6) line_schedules
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.line_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  line_id uuid NOT NULL REFERENCES public.production_lines(id) ON DELETE CASCADE,
  allocation_id uuid NOT NULL REFERENCES public.production_allocations(id) ON DELETE CASCADE,
  process text NOT NULL CHECK (process IN ('front', 'back')),
  seq integer NOT NULL DEFAULT 1,
  start_date text,
  end_date text,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_schedules_line ON public.line_schedules(line_id);
CREATE INDEX IF NOT EXISTS idx_schedules_line_process ON public.line_schedules(line_id, process);
CREATE INDEX IF NOT EXISTS idx_schedules_allocation ON public.line_schedules(allocation_id);

DROP TRIGGER IF EXISTS trg_line_schedules_updated_at ON public.line_schedules;
CREATE TRIGGER trg_line_schedules_updated_at
BEFORE UPDATE ON public.line_schedules
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ══════════════════════════════════════════════════════════
-- 7) daily_production_reports
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.daily_production_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date text NOT NULL,
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  line_id uuid REFERENCES public.production_lines(id) ON DELETE SET NULL,
  allocation_id uuid REFERENCES public.production_allocations(id) ON DELETE SET NULL,
  order_id text,
  planned_output numeric(14,4) DEFAULT 0,
  actual_output numeric(14,4) NOT NULL DEFAULT 0,
  cumulative_output numeric(14,4) DEFAULT 0,
  stage text DEFAULT 'front',
  is_abnormal boolean NOT NULL DEFAULT false,
  abnormal_reason text,
  note text,
  reporter text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_daily_reports_date ON public.daily_production_reports(date);
CREATE INDEX IF NOT EXISTS idx_daily_reports_factory ON public.daily_production_reports(factory_id);
CREATE INDEX IF NOT EXISTS idx_daily_reports_date_factory ON public.daily_production_reports(date, factory_id);
CREATE INDEX IF NOT EXISTS idx_daily_reports_allocation ON public.daily_production_reports(allocation_id);

-- ══════════════════════════════════════════════════════════
-- 8) order_corrections
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.order_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  allocation_id uuid NOT NULL REFERENCES public.production_allocations(id) ON DELETE CASCADE,
  order_id text,
  factory_id uuid REFERENCES public.factories(id) ON DELETE SET NULL,
  planned_cumulative numeric(14,4) DEFAULT 0,
  actual_cumulative numeric(14,4) DEFAULT 0,
  deviation_pct numeric(6,2) DEFAULT 0,
  risk_status text NOT NULL DEFAULT 'on_track' CHECK (risk_status IN ('on_track', 'falling_behind', 'critical')),
  estimated_end_date text,
  recommendations jsonb DEFAULT '[]'::jsonb,
  computed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_correction_allocation UNIQUE (allocation_id)
);

CREATE INDEX IF NOT EXISTS idx_corrections_allocation ON public.order_corrections(allocation_id);
CREATE INDEX IF NOT EXISTS idx_corrections_factory ON public.order_corrections(factory_id);
CREATE INDEX IF NOT EXISTS idx_corrections_risk ON public.order_corrections(risk_status);

DROP TRIGGER IF EXISTS trg_order_corrections_updated_at ON public.order_corrections;
CREATE TRIGGER trg_order_corrections_updated_at
BEFORE UPDATE ON public.order_corrections
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ══════════════════════════════════════════════════════════
-- 9) AI action logs (new table for P0-2.6 AI Action 闭环)
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.ai_action_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id text NOT NULL,
  agent text NOT NULL,
  action_type text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  summary text NOT NULL,
  urgency text NOT NULL DEFAULT 'medium',
  confidence numeric(4,3) DEFAULT 0.5,
  params jsonb DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'executed', 'rejected', 'failed')),
  executed_by text,
  executed_at timestamptz,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_actions_status ON public.ai_action_logs(status);
CREATE INDEX IF NOT EXISTS idx_ai_actions_agent ON public.ai_action_logs(agent);
CREATE INDEX IF NOT EXISTS idx_ai_actions_target ON public.ai_action_logs(target_type, target_id);

-- ══════════════════════════════════════════════════════════
-- 10) Schedule drafts (new table for P0-2.5 草稿→确认闭环)
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.schedule_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  allocation_id uuid NOT NULL REFERENCES public.production_allocations(id) ON DELETE CASCADE,
  line_id uuid NOT NULL REFERENCES public.production_lines(id) ON DELETE CASCADE,
  front_start text,
  front_end text,
  front_days integer,
  back_start text,
  back_end text,
  back_days integer,
  risk_level text DEFAULT 'SAFE',
  buffer_days integer DEFAULT 0,
  created_by text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'rejected', 'expired')),
  confirmed_by text,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_drafts_allocation ON public.schedule_drafts(allocation_id);
CREATE INDEX IF NOT EXISTS idx_drafts_status ON public.schedule_drafts(status);

COMMIT;
