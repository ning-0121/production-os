-- Migration 007: Anomaly review feedback loop
--
-- Persists user verdicts on anomalies surfaced by the statistical detector
-- so the system can track false-positive rate and improve over time.

BEGIN;

CREATE TABLE IF NOT EXISTS public.anomaly_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Deterministic anomaly identifier from the detector:
  -- format `anomaly:{key}:{date}:{type}` — see backend/src/agents/anomaly-detector.js
  anomaly_id text NOT NULL,

  -- Snapshot of what was flagged (denormalized for historical accuracy)
  anomaly_type text NOT NULL CHECK (anomaly_type IN ('output_low', 'output_high', 'persistent_dip')),
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  factory_id uuid REFERENCES public.factories(id) ON DELETE SET NULL,
  allocation_id uuid,
  order_id text,
  report_date date,
  z_score numeric,
  rolling_mean numeric,
  actual_output numeric,

  -- The verdict
  review_reason text NOT NULL CHECK (review_reason IN (
    'confirmed_real_issue',
    'data_entry_error',
    'material_issue',
    'factory_execution_issue',
    'customer_change',
    'ignored'
  )),
  notes text,

  -- Outcome bookkeeping
  is_false_positive boolean GENERATED ALWAYS AS (
    review_reason IN ('data_entry_error', 'ignored')
  ) STORED,
  is_confirmed boolean GENERATED ALWAYS AS (
    review_reason IN ('confirmed_real_issue', 'material_issue', 'factory_execution_issue', 'customer_change')
  ) STORED,

  -- Optional escalation linkage
  escalated_incident_id uuid REFERENCES public.incidents(id) ON DELETE SET NULL,

  reviewed_by text,
  reviewed_at timestamptz NOT NULL DEFAULT now(),

  -- Each anomaly can only carry one terminal verdict
  CONSTRAINT uq_anomaly_review UNIQUE (anomaly_id)
);

CREATE INDEX IF NOT EXISTS idx_anomaly_reviews_type ON public.anomaly_reviews(anomaly_type);
CREATE INDEX IF NOT EXISTS idx_anomaly_reviews_factory ON public.anomaly_reviews(factory_id);
CREATE INDEX IF NOT EXISTS idx_anomaly_reviews_alloc ON public.anomaly_reviews(allocation_id);
CREATE INDEX IF NOT EXISTS idx_anomaly_reviews_date ON public.anomaly_reviews(report_date);
CREATE INDEX IF NOT EXISTS idx_anomaly_reviews_reviewed_at ON public.anomaly_reviews(reviewed_at);

COMMIT;
