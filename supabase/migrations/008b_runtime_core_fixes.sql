-- Migration 008b: V5-A Runtime Core — audit fixes
--
-- Companion to 008_runtime_core.sql. Addresses 5 blockers + 7 should-fix items
-- raised in the SQL audit. Idempotent where possible (IF EXISTS / IF NOT EXISTS).
-- Apply this AFTER 008 — together they form the V5-A runtime foundation.
--
-- Audit ref:
--   B1  factory_id NOT NULL on runtime lines
--   B2  trigger guards optimistic concurrency (version + updated_at)
--   B3  caused_by_event_id FK + CHECK self-cause
--   B4  drop node_type / edge_type CHECK enums (generic manufacturing)
--   B5  runtime_snapshots.schema_version
--   S1  CHECK overload_pct / output >= 0
--   S2  runtime_events(order_id) index
--   S3  runtime_events(caused_by_event_id) index
--   S4  runtime_events(factory_id, occurred_at DESC) composite
--   S5  runtime_snapshots partial UNIQUE on label
--   S6  production_runtime_lines.created_at
--   S7  weight precision tightened to numeric(4,3)

BEGIN;

-- ════════════════════════════════════════════════════════════
-- B1 + S1 + S6 : production_runtime_lines hardening
-- ════════════════════════════════════════════════════════════

-- Backfill any existing NULL factory_ids before NOT NULL (defensive — should be 0 in fresh DB)
UPDATE public.production_runtime_lines
SET factory_id = '00000000-0000-0000-0000-000000000000'::uuid
WHERE factory_id IS NULL;

ALTER TABLE public.production_runtime_lines
  ALTER COLUMN factory_id SET NOT NULL;

ALTER TABLE public.production_runtime_lines
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- Non-negative invariants
ALTER TABLE public.production_runtime_lines
  DROP CONSTRAINT IF EXISTS chk_rt_lines_overload_nonneg;
ALTER TABLE public.production_runtime_lines
  ADD CONSTRAINT chk_rt_lines_overload_nonneg CHECK (overload_pct >= 0);

ALTER TABLE public.production_runtime_lines
  DROP CONSTRAINT IF EXISTS chk_rt_lines_actual_nonneg;
ALTER TABLE public.production_runtime_lines
  ADD CONSTRAINT chk_rt_lines_actual_nonneg CHECK (actual_output_today >= 0);

ALTER TABLE public.production_runtime_lines
  DROP CONSTRAINT IF EXISTS chk_rt_lines_expected_nonneg;
ALTER TABLE public.production_runtime_lines
  ADD CONSTRAINT chk_rt_lines_expected_nonneg CHECK (expected_output_today >= 0);

-- ════════════════════════════════════════════════════════════
-- B2 : optimistic-concurrency trigger
-- ════════════════════════════════════════════════════════════
-- Rules:
--   1. updated_at is ALWAYS refreshed on UPDATE.
--   2. If application did not change version (NEW.version = OLD.version),
--      auto-bump it. This catches direct Studio UPDATEs that forgot to bump.
--   3. If application bumped version exactly +1, accept (the standard path).
--   4. Refuse any other version transition (going backwards or skipping ahead).
--
-- The trigger keeps existing app code (state.js sets `version: existing.version + 1`)
-- working unchanged — the +1 path falls through rule 3.

CREATE OR REPLACE FUNCTION public.rt_lines_version_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();

  IF NEW.version IS NULL THEN
    NEW.version := COALESCE(OLD.version, 0) + 1;
  ELSIF NEW.version = OLD.version THEN
    NEW.version := OLD.version + 1;            -- direct UPDATE forgot to bump
  ELSIF NEW.version = OLD.version + 1 THEN
    -- application path — accept
    NULL;
  ELSE
    RAISE EXCEPTION
      'illegal version transition on production_runtime_lines.line_id=%: % -> % (must be n or n+1)',
      OLD.line_id, OLD.version, NEW.version
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_rt_lines_version_guard ON public.production_runtime_lines;
CREATE TRIGGER trg_rt_lines_version_guard
  BEFORE UPDATE ON public.production_runtime_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.rt_lines_version_guard();

-- ════════════════════════════════════════════════════════════
-- B3 + S3 + Self-cause CHECK : runtime_events causality integrity
-- ════════════════════════════════════════════════════════════

-- Drop any orphan caused_by_event_id values (defensive — should be 0)
UPDATE public.runtime_events e
SET caused_by_event_id = NULL
WHERE caused_by_event_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.runtime_events p WHERE p.id = e.caused_by_event_id);

ALTER TABLE public.runtime_events
  DROP CONSTRAINT IF EXISTS fk_rt_events_caused_by;
ALTER TABLE public.runtime_events
  ADD CONSTRAINT fk_rt_events_caused_by
    FOREIGN KEY (caused_by_event_id)
    REFERENCES public.runtime_events(id)
    ON DELETE SET NULL;

ALTER TABLE public.runtime_events
  DROP CONSTRAINT IF EXISTS chk_rt_events_no_self_cause;
ALTER TABLE public.runtime_events
  ADD CONSTRAINT chk_rt_events_no_self_cause CHECK (caused_by_event_id IS DISTINCT FROM id);

CREATE INDEX IF NOT EXISTS idx_rt_events_caused_by
  ON public.runtime_events(caused_by_event_id)
  WHERE caused_by_event_id IS NOT NULL;

-- ════════════════════════════════════════════════════════════
-- S2 : runtime_events(order_id) index
-- ════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_rt_events_order
  ON public.runtime_events(order_id)
  WHERE order_id IS NOT NULL;

-- ════════════════════════════════════════════════════════════
-- S4 : composite (factory_id, occurred_at DESC) for "latest events per factory"
-- ════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_rt_events_factory_occurred
  ON public.runtime_events(factory_id, occurred_at DESC)
  WHERE factory_id IS NOT NULL;

-- Correlation lookups frequently want chronological order
CREATE INDEX IF NOT EXISTS idx_rt_events_correlation_seq
  ON public.runtime_events(correlation_id, replay_seq)
  WHERE correlation_id IS NOT NULL;

-- ════════════════════════════════════════════════════════════
-- B4 : drop hard-coded node_type / edge_type enums
-- ════════════════════════════════════════════════════════════
-- Generic manufacturing requires industry-extensible types. Type validity is
-- now enforced at the application layer (Zod schemas in middleware/validate.js).
-- We keep the columns NOT NULL and add a non-empty CHECK so garbage strings
-- still get rejected at the DB boundary.

ALTER TABLE public.constraint_nodes
  DROP CONSTRAINT IF EXISTS constraint_nodes_node_type_check;
ALTER TABLE public.constraint_nodes
  ADD CONSTRAINT chk_constraint_nodes_type_nonempty
    CHECK (length(trim(node_type)) > 0);

ALTER TABLE public.constraint_edges
  DROP CONSTRAINT IF EXISTS constraint_edges_edge_type_check;
ALTER TABLE public.constraint_edges
  ADD CONSTRAINT chk_constraint_edges_type_nonempty
    CHECK (length(trim(edge_type)) > 0);

-- ════════════════════════════════════════════════════════════
-- S7 : tighten edge weight precision
-- ════════════════════════════════════════════════════════════

ALTER TABLE public.constraint_edges
  ALTER COLUMN weight TYPE numeric(4,3)
  USING ROUND(weight::numeric, 3);

-- ════════════════════════════════════════════════════════════
-- B5 + S5 : runtime_snapshots schema versioning + label uniqueness
-- ════════════════════════════════════════════════════════════

ALTER TABLE public.runtime_snapshots
  ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT 1;

-- Optional but useful: track who/what triggered the rollback that consumed
-- this snapshot, so we can build "snapshots-still-restorable" views.
ALTER TABLE public.runtime_snapshots
  ADD COLUMN IF NOT EXISTS consumed_at timestamptz;
ALTER TABLE public.runtime_snapshots
  ADD COLUMN IF NOT EXISTS consumed_by text;

-- Partial unique on label so non-null labels are unambiguous
DROP INDEX IF EXISTS uq_runtime_snapshots_label;
CREATE UNIQUE INDEX uq_runtime_snapshots_label
  ON public.runtime_snapshots(label)
  WHERE label IS NOT NULL;

-- Index for retention sweeper jobs
CREATE INDEX IF NOT EXISTS idx_runtime_snapshots_consumed
  ON public.runtime_snapshots(consumed_at)
  WHERE consumed_at IS NOT NULL;

-- ════════════════════════════════════════════════════════════
-- Documentation comments (so DB introspection tools surface intent)
-- ════════════════════════════════════════════════════════════

COMMENT ON TABLE  public.production_runtime_lines IS 'V5-A live state per production line; one row per line_id; optimistic concurrency via version+trigger.';
COMMENT ON TABLE  public.runtime_events           IS 'V5-A append-only manufacturing event log. replay_seq is monotonic at insert time but not necessarily at commit time under concurrent writers.';
COMMENT ON TABLE  public.constraint_nodes         IS 'V5-A generic manufacturing dependency graph node. node_type is free-form string; valid set enforced at application layer.';
COMMENT ON TABLE  public.constraint_edges         IS 'V5-A directed dependency edge. edge_type free-form; weight in (0,1].';
COMMENT ON TABLE  public.runtime_snapshots       IS 'V5-A rollback baselines. schema_version tracks payload format.';

COMMENT ON COLUMN public.production_runtime_lines.version IS 'Optimistic concurrency token; trigger rt_lines_version_guard auto-bumps and rejects illegal transitions.';
COMMENT ON COLUMN public.runtime_events.replay_seq IS 'bigserial; monotonic at INSERT time; subscribers MUST tolerate gaps and out-of-commit-order arrival.';
COMMENT ON COLUMN public.constraint_nodes.node_type IS 'Free-form: material | order | allocation | line | factory | rework | shipment | quality_hold | equipment | worker_team | tool | inventory_lot | <industry-specific>';
COMMENT ON COLUMN public.constraint_edges.edge_type IS 'Free-form: requires | blocks | supplies | assigned_to | downstream_of | replaces | consumes | produces | precedes | setup_for | <industry-specific>';

COMMIT;
