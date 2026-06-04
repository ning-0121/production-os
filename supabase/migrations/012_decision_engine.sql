-- Migration 012: V6-A Decision Engine Core
--
-- The transition from "system tells me what is wrong" to "system tells me what
-- to do, why, and what happens if I do nothing". For each serious risk the
-- engine produces multiple scored options, recommends one, and lets a human
-- apply or ignore — every decision recorded for learning.
--
-- DISCIPLINE: generating a decision NEVER executes it. Applying an option is
-- explicit (decision_logs row + actions). Deterministic, auditable.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ════════════════════════════════════════════════════════════
-- 1) decision_assessments — a generated set of options (read-only artifact)
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.decision_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  subject_type text NOT NULL CHECK (subject_type IN (
    'order', 'allocation', 'line', 'factory', 'material', 'incident'
  )),
  subject_id text NOT NULL,

  decision_type text NOT NULL CHECK (decision_type IN (
    'delay_resolution', 'material_shortage_resolution', 'qc_rework_resolution',
    'vip_insertion', 'line_disruption_resolution'
  )),
  urgency text NOT NULL DEFAULT 'medium' CHECK (urgency IN ('low', 'medium', 'high', 'critical')),

  -- Full snapshots (the engine's output, frozen at compute time)
  current_state jsonb NOT NULL DEFAULT '{}',
  options jsonb NOT NULL DEFAULT '[]',
  recommended_option_id text,
  recommendation_reason text,
  confidence_score numeric CHECK (confidence_score IS NULL OR (confidence_score >= 0 AND confidence_score <= 1)),
  if_no_action jsonb NOT NULL DEFAULT '{}',

  computed_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);
CREATE INDEX IF NOT EXISTS idx_decisions_subject ON public.decision_assessments(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_decisions_type ON public.decision_assessments(decision_type);
CREATE INDEX IF NOT EXISTS idx_decisions_urgency ON public.decision_assessments(urgency);
CREATE INDEX IF NOT EXISTS idx_decisions_computed ON public.decision_assessments(computed_at DESC);

-- ════════════════════════════════════════════════════════════
-- 2) decision_logs — what option a human chose + what was executed
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.decision_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id uuid NOT NULL REFERENCES public.decision_assessments(id) ON DELETE CASCADE,

  selected_option_id text NOT NULL,
  selected_by text,
  selected_at timestamptz NOT NULL DEFAULT now(),

  action_status text NOT NULL DEFAULT 'pending' CHECK (action_status IN (
    'pending', 'applied', 'partial', 'failed', 'dismissed', 'approval_requested'
  )),
  actions_taken jsonb NOT NULL DEFAULT '[]',     -- [{action_type, status, ref_id, error?}]
  result_summary jsonb NOT NULL DEFAULT '{}',
  override_reason text,                          -- set if a non-recommended option was chosen

  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_decision_logs_decision ON public.decision_logs(decision_id);
CREATE INDEX IF NOT EXISTS idx_decision_logs_option ON public.decision_logs(selected_option_id);
CREATE INDEX IF NOT EXISTS idx_decision_logs_status ON public.decision_logs(action_status);
CREATE INDEX IF NOT EXISTS idx_decision_logs_selected_at ON public.decision_logs(selected_at DESC);

-- ════════════════════════════════════════════════════════════
-- 3) decision_option_feedback — was the option/recommendation good?
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.decision_option_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id uuid NOT NULL REFERENCES public.decision_assessments(id) ON DELETE CASCADE,
  option_id text NOT NULL,

  feedback_type text NOT NULL CHECK (feedback_type IN (
    'helpful', 'not_helpful', 'wrong_recommendation', 'missing_option', 'inaccurate_impact'
  )),
  feedback_note text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_decision_feedback_decision ON public.decision_option_feedback(decision_id);
CREATE INDEX IF NOT EXISTS idx_decision_feedback_type ON public.decision_option_feedback(feedback_type);

COMMENT ON TABLE public.decision_assessments IS 'V6-A: generated decision options for a risk. Read-only artifact; generating does NOT execute.';
COMMENT ON TABLE public.decision_logs IS 'V6-A: human-selected option + actions executed. The audit trail of decisions.';
COMMENT ON TABLE public.decision_option_feedback IS 'V6-A: feedback on options/recommendations for future learning.';

COMMIT;
