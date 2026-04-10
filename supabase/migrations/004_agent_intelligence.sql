-- Migration 004: P3 — Agent Intelligence Layer
-- Memory, Confidence, Forecasting, Workflow Automation

BEGIN;

-- ══════════════════════════════════════════════════════════
-- 1) agent_memory — aggregated historical patterns
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.agent_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,  -- factory, line, category, customer
  entity_id text NOT NULL,
  metric_type text NOT NULL,  -- delay_avg, rework_rate, throughput_avg, override_rate, deviation_avg, incident_rate, on_time_rate
  period text NOT NULL DEFAULT 'rolling_30d',  -- rolling_30d, rolling_90d, weekly, monthly
  value numeric(14,4) NOT NULL DEFAULT 0,
  sample_count integer NOT NULL DEFAULT 0,
  trend text DEFAULT 'stable',  -- improving, stable, declining
  computed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_memory UNIQUE (entity_type, entity_id, metric_type, period)
);

CREATE INDEX IF NOT EXISTS idx_memory_entity ON public.agent_memory(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_memory_metric ON public.agent_memory(metric_type);

-- ══════════════════════════════════════════════════════════
-- 2) forecasts — predicted future states
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.forecasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  forecast_type text NOT NULL,  -- capacity, completion, bottleneck, risk
  entity_type text NOT NULL,    -- factory, line, order
  entity_id text NOT NULL,
  horizon_days integer NOT NULL DEFAULT 7,
  forecast_date text,           -- the date being predicted
  predicted_value numeric(14,4),
  confidence_score numeric(4,3) DEFAULT 0.5,
  unit text,                    -- days, units, pct
  context jsonb DEFAULT '{}'::jsonb,
  actual_value numeric(14,4),   -- filled when date passes
  error_pct numeric(6,2),
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_forecasts_type ON public.forecasts(forecast_type);
CREATE INDEX IF NOT EXISTS idx_forecasts_entity ON public.forecasts(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_forecasts_date ON public.forecasts(forecast_date);

-- ══════════════════════════════════════════════════════════
-- 3) automation_rules — configurable trigger-action rules
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.automation_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  trigger_type text NOT NULL,
  condition_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  actions_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  priority integer DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rules_enabled ON public.automation_rules(enabled);

-- ══════════════════════════════════════════════════════════
-- 4) automation_logs — execution history
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.automation_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid REFERENCES public.automation_rules(id) ON DELETE SET NULL,
  rule_name text,
  trigger_type text NOT NULL,
  trigger_context jsonb DEFAULT '{}'::jsonb,
  actions_taken jsonb DEFAULT '[]'::jsonb,
  allocation_id uuid,
  factory_id uuid,
  outcome text,
  executed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auto_logs_date ON public.automation_logs(executed_at);
CREATE INDEX IF NOT EXISTS idx_auto_logs_rule ON public.automation_logs(rule_id);

-- ══════════════════════════════════════════════════════════
-- 5) watchlist — items under active monitoring
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.watchlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,  -- order, factory, line
  entity_id text NOT NULL,
  reason text NOT NULL,
  added_by text,
  added_at timestamptz NOT NULL DEFAULT now(),
  escalation_deadline timestamptz,
  escalated boolean DEFAULT false,
  resolved_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'escalated', 'resolved')),
  CONSTRAINT uq_watchlist UNIQUE (entity_type, entity_id, status)
);

CREATE INDEX IF NOT EXISTS idx_watchlist_status ON public.watchlist(status);
CREATE INDEX IF NOT EXISTS idx_watchlist_deadline ON public.watchlist(escalation_deadline);

-- ══════════════════════════════════════════════════════════
-- 6) Add confidence columns to order_scenarios
-- ══════════════════════════════════════════════════════════

ALTER TABLE public.order_scenarios
  ADD COLUMN IF NOT EXISTS confidence_score numeric(4,3),
  ADD COLUMN IF NOT EXISTS confidence_reason text,
  ADD COLUMN IF NOT EXISTS confidence_breakdown jsonb;

COMMIT;
