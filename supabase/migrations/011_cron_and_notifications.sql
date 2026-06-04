-- Migration 011: Scheduled automation + minimal notification loop
--
-- Makes the execution loop autonomous: cron triggers auto-generation +
-- escalation, and responsible people get notified. No human click required.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ════════════════════════════════════════════════════════════
-- 1) cron_runs — log of every scheduled automation run
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.cron_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name text NOT NULL,                 -- 'sweep' (combined) | 'auto_generate' | 'escalation' | 'due_soon'
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),

  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer,

  -- Per-job counters (null when not applicable)
  generated_count integer DEFAULT 0,
  escalated_count integer DEFAULT 0,
  notified_count integer DEFAULT 0,
  due_soon_count integer DEFAULT 0,
  failed_count integer DEFAULT 0,

  error_message text,
  triggered_by text,                      -- 'github_actions' | 'railway_cron' | 'manual' | 'external'
  detail jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON public.cron_runs(job_name);
CREATE INDEX IF NOT EXISTS idx_cron_runs_started ON public.cron_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cron_runs_status ON public.cron_runs(status);

-- ════════════════════════════════════════════════════════════
-- 2) notification_events — in-app notifications (adapter-ready)
-- ════════════════════════════════════════════════════════════
-- recipient can be an operator id/email OR a role name (supervisor, plant_head,
-- vp, production_manager). channel is in_app today; email/wechat/whatsapp are
-- future adapters. dedup_key + partial unique index guarantee cron re-runs
-- never produce duplicate notifications.

CREATE TABLE IF NOT EXISTS public.notification_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  recipient text NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'task_created', 'task_due_soon', 'task_overdue_escalated', 'task_resolved', 'task_reassigned'
  )),
  channel text NOT NULL DEFAULT 'in_app' CHECK (channel IN ('in_app', 'email', 'wechat', 'whatsapp')),

  title text NOT NULL,
  body text,
  task_id uuid REFERENCES public.decision_tasks(id) ON DELETE CASCADE,

  severity text CHECK (severity IS NULL OR severity IN ('ok', 'warn', 'critical')),
  metadata jsonb NOT NULL DEFAULT '{}',

  -- Idempotency anchor — see notify.js. Same (task_id, kind, dedup_key) never
  -- inserts twice, so re-running the cron is safe.
  dedup_key text NOT NULL DEFAULT 'default',

  -- Delivery bookkeeping (for future email/wechat adapters)
  delivered_at timestamptz,
  delivery_status text DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'delivered', 'failed', 'skipped')),
  delivery_error text,

  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Idempotency: one notification per (task, kind, dedup_key).
CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_dedup
  ON public.notification_events(task_id, kind, dedup_key)
  WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notif_recipient ON public.notification_events(recipient);
CREATE INDEX IF NOT EXISTS idx_notif_unread ON public.notification_events(recipient, read_at) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notif_task ON public.notification_events(task_id);
CREATE INDEX IF NOT EXISTS idx_notif_created ON public.notification_events(created_at DESC);

COMMENT ON TABLE public.cron_runs IS 'Log of scheduled automation runs (auto-generate + escalation + due-soon). For observability + retry safety.';
COMMENT ON TABLE public.notification_events IS 'In-app notifications. recipient = operator OR role. dedup_key makes cron re-runs idempotent. channel is adapter-ready (email/wechat future).';

COMMIT;
