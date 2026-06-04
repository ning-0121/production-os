-- Migration 010: Execution Engine — Decision → Owner → Deadline → Escalation → Retrospective
--
-- The accountability core of the Enterprise Runtime System. Turns "we see a
-- risk" into "this risk has an owner, a deadline, an escalation path, and a
-- retrospective". This is the moat — not the AI, the closed loop.
--
-- DISCIPLINE (Decision Engine boundary):
--   This engine writes ONLY: decision_tasks, task_events, retrospectives,
--   task_watchers, escalation_policies.
--   It NEVER writes orders / allocations / financials / shipments / production.
--   AI may SUGGEST owner+deadline; humans confirm. AI never auto-resolves.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ════════════════════════════════════════════════════════════
-- 1) escalation_policies — how long until escalation, and to whom
-- ════════════════════════════════════════════════════════════
-- A policy maps a task category + severity to a chain of escalation steps.
-- Each step = "after N minutes unresolved, notify role R". Ordered by level.

CREATE TABLE IF NOT EXISTS public.escalation_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  -- Match criteria (null = wildcard)
  category text,                         -- 'production_delay' | 'quality' | 'material' | 'shipment' | 'general'
  min_severity text CHECK (min_severity IS NULL OR min_severity IN ('ok','warn','critical')),
  -- Ordered escalation steps:
  -- [{ level: 1, after_minutes: 240, notify_role: 'supervisor' },
  --  { level: 2, after_minutes: 720, notify_role: 'plant_head' }, ...]
  steps jsonb NOT NULL DEFAULT '[]',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_esc_policies_active ON public.escalation_policies(is_active);
CREATE INDEX IF NOT EXISTS idx_esc_policies_category ON public.escalation_policies(category);

-- ════════════════════════════════════════════════════════════
-- 2) decision_tasks — the accountable unit of work
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.decision_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  title text NOT NULL,
  description text,
  category text NOT NULL DEFAULT 'general' CHECK (category IN (
    'production_delay', 'quality', 'material', 'shipment', 'capacity', 'general'
  )),
  -- Canonical risk severity at creation (mirrors risk-engine scale)
  severity text NOT NULL DEFAULT 'warn' CHECK (severity IN ('ok', 'warn', 'critical')),

  -- What this task is about — links to a domain entity WITHOUT a hard FK
  -- (the engine must not depend on / cascade with the main chain).
  subject_type text CHECK (subject_type IS NULL OR subject_type IN (
    'order', 'allocation', 'line', 'factory', 'customer', 'material', 'shipment'
  )),
  subject_id text,

  -- Provenance — what created this task. Used for idempotency.
  -- e.g. ('anomaly', '<anomaly_id>'), ('runtime_event', '<correlation_id>'),
  --      ('risk', 'order:<id>'), ('manual', '<operator>')
  source_type text NOT NULL DEFAULT 'manual' CHECK (source_type IN (
    'anomaly', 'runtime_event', 'risk', 'incident', 'qc_failure', 'manual', 'ai_suggestion'
  )),
  source_ref text,                       -- the dedup anchor within source_type

  -- ── State machine ──
  status text NOT NULL DEFAULT 'open' CHECK (status IN (
    'open',          -- created, no owner has accepted yet
    'acknowledged',  -- an owner accepted responsibility
    'in_progress',   -- owner is actively working it
    'blocked',       -- owner cannot proceed (needs something)
    'resolved',      -- owner reports done
    'dismissed'      -- closed without action (needs reason)
  )),

  -- ── Accountability ──
  owner text,                            -- operator/role responsible NOW
  owner_role text,                       -- their role at assignment time
  due_at timestamptz,                    -- deadline; null = no deadline yet

  -- ── Escalation ──
  escalation_policy_id uuid REFERENCES public.escalation_policies(id) ON DELETE SET NULL,
  escalation_level integer NOT NULL DEFAULT 0,    -- 0 = not escalated
  last_escalated_at timestamptz,
  escalated_to text,                     -- role/person currently escalated to

  -- ── AI suggestion (advisory only) ──
  ai_suggested_owner text,
  ai_suggested_due_at timestamptz,
  ai_recommended_action text,
  ai_confidence numeric CHECK (ai_confidence IS NULL OR (ai_confidence >= 0 AND ai_confidence <= 1)),

  -- ── Resolution ──
  resolution_note text,
  resolved_by text,
  resolved_at timestamptz,
  blocked_reason text,
  dismissed_reason text,

  -- Optimistic concurrency
  version integer NOT NULL DEFAULT 0,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- IDEMPOTENCY: one active task per risk source. Partial unique so that
  -- once a task is terminal (resolved/dismissed) a new one can be opened
  -- for a recurrence.
  CONSTRAINT chk_dismiss_reason CHECK (status <> 'dismissed' OR dismissed_reason IS NOT NULL)
);

-- Idempotency guard: at most ONE non-terminal task per (source_type, source_ref).
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_task_per_source
  ON public.decision_tasks(source_type, source_ref)
  WHERE status NOT IN ('resolved', 'dismissed') AND source_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_status ON public.decision_tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON public.decision_tasks(owner);
CREATE INDEX IF NOT EXISTS idx_tasks_severity ON public.decision_tasks(severity);
CREATE INDEX IF NOT EXISTS idx_tasks_category ON public.decision_tasks(category);
CREATE INDEX IF NOT EXISTS idx_tasks_subject ON public.decision_tasks(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due_at ON public.decision_tasks(due_at) WHERE status NOT IN ('resolved','dismissed');
CREATE INDEX IF NOT EXISTS idx_tasks_esc_level ON public.decision_tasks(escalation_level) WHERE status NOT IN ('resolved','dismissed');
CREATE INDEX IF NOT EXISTS idx_tasks_created ON public.decision_tasks(created_at DESC);

-- Optimistic concurrency trigger (same pattern as runtime_lines)
CREATE OR REPLACE FUNCTION public.decision_tasks_version_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  IF NEW.version IS NULL THEN
    NEW.version := COALESCE(OLD.version, 0) + 1;
  ELSIF NEW.version = OLD.version THEN
    NEW.version := OLD.version + 1;
  ELSIF NEW.version = OLD.version + 1 THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'illegal version transition on decision_tasks.id=%: % -> %', OLD.id, OLD.version, NEW.version
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_decision_tasks_version ON public.decision_tasks;
CREATE TRIGGER trg_decision_tasks_version
  BEFORE UPDATE ON public.decision_tasks
  FOR EACH ROW EXECUTE FUNCTION public.decision_tasks_version_guard();

-- ════════════════════════════════════════════════════════════
-- 3) task_events — append-only audit log of everything that happened
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.task_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.decision_tasks(id) ON DELETE CASCADE,

  event_type text NOT NULL CHECK (event_type IN (
    'created', 'claimed', 'started', 'blocked', 'unblocked',
    'resolved', 'dismissed', 'reopened',
    'reassigned', 'deadline_set', 'deadline_changed',
    'escalated', 'comment', 'ai_suggested'
  )),
  from_status text,
  to_status text,
  actor text,                            -- who did it
  actor_role text,
  detail jsonb NOT NULL DEFAULT '{}',
  note text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  request_id text
);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON public.task_events(task_id);
CREATE INDEX IF NOT EXISTS idx_task_events_type ON public.task_events(event_type);
CREATE INDEX IF NOT EXISTS idx_task_events_occurred ON public.task_events(occurred_at DESC);

-- ════════════════════════════════════════════════════════════
-- 4) retrospectives — what did we learn after a task closed
-- ════════════════════════════════════════════════════════════
-- This is where company behaviour gets sedimented into learning. One
-- retrospective per resolved/dismissed task (optional but encouraged).

CREATE TABLE IF NOT EXISTS public.retrospectives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.decision_tasks(id) ON DELETE CASCADE,

  -- Structured root-cause taxonomy (mirrors anomaly review reasons + more)
  root_cause text CHECK (root_cause IS NULL OR root_cause IN (
    'material_delay', 'equipment_failure', 'labor_shortage', 'quality_issue',
    'planning_error', 'supplier_issue', 'customer_change', 'data_error',
    'external_factor', 'no_action_needed', 'other'
  )),
  what_happened text,
  what_we_did text,
  prevention text,                       -- how to prevent recurrence
  -- Was the escalation chain effective?
  resolution_time_minutes integer,
  was_escalated boolean DEFAULT false,
  max_escalation_level integer DEFAULT 0,
  -- Feedback for the detector that raised this
  was_false_positive boolean,

  authored_by text,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_retro_per_task UNIQUE (task_id)
);
CREATE INDEX IF NOT EXISTS idx_retro_root_cause ON public.retrospectives(root_cause);
CREATE INDEX IF NOT EXISTS idx_retro_created ON public.retrospectives(created_at DESC);

-- ════════════════════════════════════════════════════════════
-- 5) task_watchers — who else gets notified (besides owner)
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.task_watchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.decision_tasks(id) ON DELETE CASCADE,
  watcher text NOT NULL,                 -- operator/role
  reason text,                           -- 'escalation' | 'manual' | 'subscriber'
  added_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_task_watcher UNIQUE (task_id, watcher)
);
CREATE INDEX IF NOT EXISTS idx_task_watchers_task ON public.task_watchers(task_id);
CREATE INDEX IF NOT EXISTS idx_task_watchers_watcher ON public.task_watchers(watcher);

-- ════════════════════════════════════════════════════════════
-- Seed: a sensible default escalation policy
-- ════════════════════════════════════════════════════════════
INSERT INTO public.escalation_policies (name, category, min_severity, steps, is_active)
VALUES (
  '默认升级策略', NULL, 'warn',
  '[{"level":1,"after_minutes":240,"notify_role":"supervisor"},
    {"level":2,"after_minutes":720,"notify_role":"plant_head"},
    {"level":3,"after_minutes":1440,"notify_role":"vp"}]'::jsonb,
  true
)
ON CONFLICT DO NOTHING;

COMMENT ON TABLE public.decision_tasks IS 'V6 Execution Engine: accountable units (owner+deadline+escalation). Engine writes here only — never the main chain.';
COMMENT ON TABLE public.task_events IS 'Append-only audit of every task state change.';
COMMENT ON TABLE public.retrospectives IS 'Post-resolution learning. Company behaviour sediment.';
COMMENT ON COLUMN public.decision_tasks.source_ref IS 'Idempotency anchor: one active task per (source_type, source_ref).';

COMMIT;
