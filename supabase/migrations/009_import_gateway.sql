-- Migration 009: AI Production Data Gateway (Phase 1)
--
-- The factory upload layer. Factories should NOT change their Excel formats —
-- this gateway adapts to them. Two-phase ingestion:
--   1. STAGE: parse + recognize columns + normalize rows → import_rows
--   2. COMMIT: write to target table + emit runtime_events
--
-- Designed as the first version of the future real-time manufacturing
-- integration layer (ERP / hanging line / barcode / IoT all flow through here).

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ════════════════════════════════════════════════════════════
-- 1) import_templates — saved column-mapping templates per source
-- ════════════════════════════════════════════════════════════
-- One template per "this factory's hanging system Excel". After a user
-- confirms a mapping once, we save it here so the second upload from the
-- same source is fully automatic.

CREATE TABLE IF NOT EXISTS public.import_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  source_hint text,                        -- e.g. "Factory A hanging line v2"
  import_type text NOT NULL CHECK (import_type IN (
    'daily_report', 'hanging_line', 'qc', 'rework', 'generic'
  )),
  factory_id uuid,                         -- optional scoping
  -- [{ external_header, internal_field, transform?, required? }]
  column_mappings jsonb NOT NULL DEFAULT '[]',
  -- learning bookkeeping
  use_count integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_import_templates_type ON public.import_templates(import_type);
CREATE INDEX IF NOT EXISTS idx_import_templates_factory ON public.import_templates(factory_id);

-- ════════════════════════════════════════════════════════════
-- 2) import_runs — one row per upload attempt
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.import_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  filename text,
  file_size_bytes integer,
  file_hash text,                          -- sha256, for dedup detection
  uploaded_by text,

  -- Detected during parse phase
  import_type text NOT NULL CHECK (import_type IN (
    'daily_report', 'hanging_line', 'qc', 'rework', 'generic'
  )),
  detected_factory_id uuid,
  template_id uuid REFERENCES public.import_templates(id) ON DELETE SET NULL,

  sheet_name text,
  total_rows integer NOT NULL DEFAULT 0,

  status text NOT NULL DEFAULT 'parsing' CHECK (status IN (
    'parsing',                             -- file received, being parsed
    'awaiting_confirmation',               -- preview ready, waiting on user
    'committing',                          -- user confirmed, writing
    'completed',                           -- all committed
    'partial',                             -- some rows committed, some failed
    'failed',                              -- aborted before any commit
    'rolled_back'                          -- explicit rollback
  )),

  -- Final mappings used (after any user confirmation)
  column_mappings jsonb NOT NULL DEFAULT '[]',

  -- Aggregate summary: { created, skipped, warnings, errors, events_emitted }
  summary jsonb NOT NULL DEFAULT '{}',

  -- Why a run was rejected / partial
  reasoning text,

  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_import_runs_status ON public.import_runs(status);
CREATE INDEX IF NOT EXISTS idx_import_runs_type ON public.import_runs(import_type);
CREATE INDEX IF NOT EXISTS idx_import_runs_started ON public.import_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_import_runs_file_hash ON public.import_runs(file_hash) WHERE file_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_import_runs_factory ON public.import_runs(detected_factory_id) WHERE detected_factory_id IS NOT NULL;

-- ════════════════════════════════════════════════════════════
-- 3) import_rows — staged rows from one run (pre-commit)
-- ════════════════════════════════════════════════════════════
-- Each row carries its raw original cells AND the normalized typed payload.
-- After commit, committed_entity_id points to the row created in the target
-- table (e.g. daily_production_reports.id).

CREATE TABLE IF NOT EXISTS public.import_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.import_runs(id) ON DELETE CASCADE,
  row_number integer NOT NULL,             -- Excel row index (1-based, after header)

  raw_data jsonb NOT NULL DEFAULT '{}',    -- original cell values keyed by external header
  normalized jsonb NOT NULL DEFAULT '{}',  -- typed entity ready for target table

  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'committed', 'rejected', 'warning', 'skipped_duplicate'
  )),
  error_message text,

  -- Where it landed after commit
  committed_entity_type text,              -- 'daily_production_report' | 'qc_inspection' | ...
  committed_entity_id text,

  -- Events emitted for this row, if any
  emitted_event_ids uuid[] DEFAULT '{}',

  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_import_rows_run ON public.import_rows(run_id);
CREATE INDEX IF NOT EXISTS idx_import_rows_status ON public.import_rows(status);

-- ════════════════════════════════════════════════════════════
-- 4) unresolved_import_mappings — external value → internal entity tasks
-- ════════════════════════════════════════════════════════════
-- Example: external Excel says "工厂A 一号车间" but our `factories` table
-- has no exact match. Instead of failing, we stage an unresolved mapping
-- task that the user can fix later. Once resolved, future runs auto-apply.

CREATE TABLE IF NOT EXISTS public.unresolved_import_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES public.import_runs(id) ON DELETE CASCADE,

  external_field text NOT NULL CHECK (external_field IN (
    'factory_name', 'line_name', 'order_no', 'product_type', 'material_code',
    'customer_code', 'supplier_code', 'operator', 'shift'
  )),
  external_value text NOT NULL,
  occurrences integer NOT NULL DEFAULT 1,

  -- AI / fuzzy-match suggestions: [{ id, name, score }]
  suggested_matches jsonb NOT NULL DEFAULT '[]',

  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'resolved', 'ignored'
  )),
  resolved_internal_type text,             -- e.g. 'factory'
  resolved_internal_id text,
  resolved_by text,
  resolved_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  -- One row per (run, field, value) so retries don't bloat
  CONSTRAINT uq_unresolved UNIQUE (run_id, external_field, external_value)
);
CREATE INDEX IF NOT EXISTS idx_unresolved_status ON public.unresolved_import_mappings(status);
CREATE INDEX IF NOT EXISTS idx_unresolved_field ON public.unresolved_import_mappings(external_field);

-- ════════════════════════════════════════════════════════════
-- 5) import_field_mappings — learned external_header → internal_field
-- ════════════════════════════════════════════════════════════
-- Each time a user confirms (or implicitly accepts) a column mapping, we
-- bump approved_count. Next time the same header is seen, this row drives
-- automatic high-confidence recognition.

CREATE TABLE IF NOT EXISTS public.import_field_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_header text NOT NULL,           -- normalized: lowercased, trimmed
  internal_field text NOT NULL,
  import_type text NOT NULL,
  factory_id uuid,                         -- optional scoping

  -- Bayesian-flavored confidence: approved / (approved + rejected)
  approved_count integer NOT NULL DEFAULT 0,
  rejected_count integer NOT NULL DEFAULT 0,
  confidence numeric(4,3) NOT NULL DEFAULT 0.5,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_field_mapping UNIQUE (external_header, internal_field, import_type, factory_id)
);
CREATE INDEX IF NOT EXISTS idx_field_mappings_header ON public.import_field_mappings(external_header);
CREATE INDEX IF NOT EXISTS idx_field_mappings_type ON public.import_field_mappings(import_type);

-- ════════════════════════════════════════════════════════════
-- 6) import_errors — per-run + per-row error log
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.import_errors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.import_runs(id) ON DELETE CASCADE,
  row_id uuid REFERENCES public.import_rows(id) ON DELETE CASCADE,

  severity text NOT NULL CHECK (severity IN ('error', 'warning', 'info')),
  code text NOT NULL,                      -- e.g. 'negative_output', 'cumulative_regression'
  message text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',

  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_import_errors_run ON public.import_errors(run_id);
CREATE INDEX IF NOT EXISTS idx_import_errors_severity ON public.import_errors(severity);
CREATE INDEX IF NOT EXISTS idx_import_errors_code ON public.import_errors(code);

-- ════════════════════════════════════════════════════════════
-- Documentation
-- ════════════════════════════════════════════════════════════

COMMENT ON TABLE  public.import_templates              IS 'Saved column-mapping templates per data source. Reused across runs to make repeat uploads fully automatic.';
COMMENT ON TABLE  public.import_runs                   IS 'One row per Excel upload. Two-phase: parsing → awaiting_confirmation → committing → completed.';
COMMENT ON TABLE  public.import_rows                   IS 'Staged rows (raw_data + normalized) before commit. Survives even after commit for auditability.';
COMMENT ON TABLE  public.unresolved_import_mappings    IS 'External values (factory name, order no, ...) that could not be matched to internal entities. Resolved manually, then auto-applied to future runs.';
COMMENT ON TABLE  public.import_field_mappings         IS 'Learned dictionary: external_header → internal_field with confidence. Drives column auto-recognition.';
COMMENT ON TABLE  public.import_errors                 IS 'Validation + processing errors per row or per run, with severity grading.';

COMMIT;
