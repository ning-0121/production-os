-- Migration 003: P2 — Scenarios, Overrides, Incidents
-- Multi-scenario decision support, override learning, incident management

BEGIN;

-- ══════════════════════════════════════════════════════════
-- 1) order_scenarios — AI-generated alternative plans per order
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.order_scenarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id text NOT NULL,
  allocation_id uuid REFERENCES public.production_allocations(id) ON DELETE CASCADE,

  scenario_type text NOT NULL,  -- balanced, speed, cost, quality, manual
  scenario_label text NOT NULL, -- human-readable label e.g. "最快交付"

  target_factory_id uuid REFERENCES public.factories(id) ON DELETE SET NULL,
  target_factory_name text,
  target_line_id uuid,

  expected_finish_date text,
  risk_level text DEFAULT 'SAFE',
  buffer_days integer DEFAULT 0,
  cost_change_pct numeric(6,2) DEFAULT 0,

  impact_summary text,          -- "ORD-008 延后1天"
  impacted_orders jsonb DEFAULT '[]'::jsonb,

  recommendation_score numeric(6,2) DEFAULT 0,
  recommendation_reason text,
  score_breakdown jsonb DEFAULT '{}'::jsonb,

  payload jsonb DEFAULT '{}'::jsonb,  -- full optimizer output for this scenario
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'rejected', 'expired')),

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scenarios_order ON public.order_scenarios(order_id);
CREATE INDEX IF NOT EXISTS idx_scenarios_alloc ON public.order_scenarios(allocation_id);
CREATE INDEX IF NOT EXISTS idx_scenarios_status ON public.order_scenarios(status);

-- ══════════════════════════════════════════════════════════
-- 2) scenario_actions — execution log when a scenario is applied
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.scenario_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id uuid NOT NULL REFERENCES public.order_scenarios(id) ON DELETE CASCADE,
  action_type text NOT NULL,    -- assign_factory, create_schedule, update_allocation, etc.
  action_payload jsonb DEFAULT '{}'::jsonb,
  executed_by text,
  executed_at timestamptz DEFAULT now(),
  result jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_scenario_actions_scenario ON public.scenario_actions(scenario_id);

-- ══════════════════════════════════════════════════════════
-- 3) scheduling_overrides — tracks when humans override AI recommendations
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.scheduling_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id text,
  allocation_id uuid REFERENCES public.production_allocations(id) ON DELETE SET NULL,

  original_factory_id uuid,
  original_factory_name text,
  original_line_id uuid,
  original_finish_date text,
  original_scenario_type text,

  final_factory_id uuid,
  final_factory_name text,
  final_line_id uuid,
  final_finish_date text,
  final_scenario_type text,

  override_reason text,
  override_type text DEFAULT 'factory_change', -- factory_change, line_change, date_change, split_change
  overridden_by text,
  overridden_at timestamptz DEFAULT now(),

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_overrides_order ON public.scheduling_overrides(order_id);
CREATE INDEX IF NOT EXISTS idx_overrides_date ON public.scheduling_overrides(overridden_at);

-- ══════════════════════════════════════════════════════════
-- 4) incidents — production incidents (upgraded from exceptions)
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_type text NOT NULL,  -- factory_shutdown, material_delay, quality_issue, rush_order, equipment_failure
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('critical', 'high', 'medium', 'low')),

  factory_id uuid REFERENCES public.factories(id) ON DELETE SET NULL,
  line_id uuid,
  order_id text,

  description text NOT NULL,
  estimated_delay_days integer DEFAULT 0,
  affected_order_count integer DEFAULT 0,

  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'resolved', 'closed')),
  resolved_by text,
  resolved_at timestamptz,
  resolution_notes text,

  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_incidents_status ON public.incidents(status);
CREATE INDEX IF NOT EXISTS idx_incidents_severity ON public.incidents(severity);
CREATE INDEX IF NOT EXISTS idx_incidents_factory ON public.incidents(factory_id);

-- ══════════════════════════════════════════════════════════
-- 5) incident_impacts — which orders are affected by an incident
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.incident_impacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES public.incidents(id) ON DELETE CASCADE,
  affected_order_id text NOT NULL,
  allocation_id uuid REFERENCES public.production_allocations(id) ON DELETE SET NULL,
  impact_type text DEFAULT 'delay',  -- delay, quality, cost
  estimated_delay_days integer DEFAULT 0,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_impacts_incident ON public.incident_impacts(incident_id);
CREATE INDEX IF NOT EXISTS idx_impacts_order ON public.incident_impacts(affected_order_id);

-- ══════════════════════════════════════════════════════════
-- 6) incident_actions — response actions taken for incidents
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.incident_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES public.incidents(id) ON DELETE CASCADE,
  action_type text NOT NULL,  -- reassign, split, delay_notify, add_overtime, etc.
  action_payload jsonb DEFAULT '{}'::jsonb,
  executed_by text,
  executed_at timestamptz DEFAULT now(),
  result jsonb
);

CREATE INDEX IF NOT EXISTS idx_incident_actions_incident ON public.incident_actions(incident_id);

COMMIT;
