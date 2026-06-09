-- Migration 013: Decision Learning Loop
--
-- Gives the Decision Engine organizational memory: a cached, inspectable table
-- of per-(decision_type, option_type) effectiveness derived from real history
-- (decision_logs + decision_option_feedback). The engine reads this to apply a
-- BOUNDED, EXPLAINABLE, REVERSIBLE nudge to option scores.
--
-- DISCIPLINE: learning never replaces the deterministic core. It only adds a
-- capped adjustment (±12 pts) with a recorded reason, and only above a minimum
-- sample size. Set adjustment=0 everywhere (or ignore the table) to revert to
-- pure deterministic scoring.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.decision_learning (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  decision_type text NOT NULL,
  option_type text NOT NULL,

  -- Raw counts (from decision_logs + feedback)
  selected_count integer NOT NULL DEFAULT 0,
  applied_count integer NOT NULL DEFAULT 0,     -- action_status applied|partial
  failed_count integer NOT NULL DEFAULT 0,      -- action_status failed
  dismissed_count integer NOT NULL DEFAULT 0,
  helpful_count integer NOT NULL DEFAULT 0,
  not_helpful_count integer NOT NULL DEFAULT 0,
  override_in_count integer NOT NULL DEFAULT 0,  -- chosen over the recommendation
  override_out_count integer NOT NULL DEFAULT 0, -- recommended but a different option chosen

  -- Derived (0..1) + the bounded score nudge actually applied (e.g. -12..+12)
  exec_success_rate numeric NOT NULL DEFAULT 0.5,
  feedback_ratio numeric NOT NULL DEFAULT 0.5,
  effectiveness numeric NOT NULL DEFAULT 0.5,
  sample_size integer NOT NULL DEFAULT 0,
  adjustment numeric NOT NULL DEFAULT 0,
  reason text,

  recomputed_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_decision_learning UNIQUE (decision_type, option_type)
);

CREATE INDEX IF NOT EXISTS idx_decision_learning_type ON public.decision_learning(decision_type, option_type);
CREATE INDEX IF NOT EXISTS idx_decision_learning_recomputed ON public.decision_learning(recomputed_at DESC);

COMMENT ON TABLE public.decision_learning IS 'V6-A learning loop: cached per-option effectiveness driving a bounded, explainable score nudge. Recomputed by a sweep; read at evaluate time.';
COMMENT ON COLUMN public.decision_learning.adjustment IS 'Bounded score delta (±12). 0 when sample_size below threshold (cold start = pure deterministic).';

COMMIT;
