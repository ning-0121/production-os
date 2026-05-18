/**
 * Import Gateway routes — `/api/imports/*`
 *
 * Two-phase pipeline:
 *   POST /upload       parse + recognize + stage rows → status=awaiting_confirmation
 *   POST /:id/confirm  user-confirmed mappings → normalize + resolve + commit
 *
 * Reads:
 *   GET /runs           paginated history
 *   GET /:id            detail (run + rows + errors)
 *   GET /unresolved     pending external→internal mappings
 *   POST /unresolved/:id/resolve   user picks the internal entity
 *
 * Always runs through request_id + audit log.
 */

import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validate, schemas } from "../middleware/validate.js";
import { auditLog } from "../governance/audit.js";

import { recognizeColumns, detectImportType } from "../import-gateway/recognizer.js";
import { normalizeRow, dedupKey } from "../import-gateway/normalizer.js";
import { resolveFactoryName, resolveLineName, resolveOrderNo } from "../import-gateway/resolver.js";
import { commitRun } from "../import-gateway/committer.js";
import { normalizeHeader } from "../import-gateway/dictionary.js";

const router = Router();

// ════════════════════════════════════════════════════════════
// PHASE 1: Upload + parse + recognize + stage
// ════════════════════════════════════════════════════════════

router.post("/upload", validate(schemas.importUpload), asyncHandler(async (req, res) => {
  const { filename, file_size_bytes, file_hash, sheet_name, headers, rows,
          suggested_import_type, factory_id } = req.body;

  // 1) Detect import type (or use hint)
  const detection = detectImportType(headers);
  const importType = suggested_import_type ?? detection.import_type;

  // 2) Load learned mappings for these headers
  const normHeaders = headers.map(normalizeHeader);
  const { data: learned } = await supabase
    .from("import_field_mappings")
    .select("external_header, internal_field, confidence")
    .in("external_header", normHeaders)
    .eq("import_type", importType);

  const learnedByHeader = {};
  for (const m of learned ?? []) {
    if (!learnedByHeader[m.external_header]) learnedByHeader[m.external_header] = [];
    learnedByHeader[m.external_header].push(m);
  }

  // 3) Recognize columns
  const recognition = recognizeColumns({ headers, learnedByHeader, importType });

  // 4) Create import_run
  const { data: run, error: runErr } = await supabase
    .from("import_runs")
    .insert({
      filename,
      file_size_bytes: file_size_bytes ?? null,
      file_hash: file_hash ?? null,
      uploaded_by: req.pilotIdentity?.operator ?? "system",
      import_type: importType,
      detected_factory_id: factory_id ?? null,
      sheet_name: sheet_name ?? null,
      total_rows: rows.length,
      status: "parsing",
      column_mappings: recognition.mappings,
    })
    .select()
    .single();
  if (runErr) throw runErr;

  // 5) Stage every row (raw + lightweight pre-normalization just to compute warnings)
  const dupSeen = new Set();
  let runningMaxCum = 0;
  let runningSum = 0;
  let runningCount = 0;

  const stagePayloads = [];
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const { normalized, warnings, errors } = normalizeRow({
      mappings: recognition.mappings,
      rawRow: raw,
      importType,
      context: {
        running_mean: runningCount > 0 ? runningSum / runningCount : null,
        running_max_cumulative: runningMaxCum,
      },
    });

    // Running stats update
    const actual = Number(normalized.actual_output);
    if (Number.isFinite(actual) && actual > 0) {
      runningSum += actual; runningCount++;
    }
    const cum = Number(normalized.cumulative_output);
    if (Number.isFinite(cum) && cum > runningMaxCum) runningMaxCum = cum;

    // In-run dedup detection
    const key = dedupKey(normalized, importType);
    const isDup = dupSeen.has(key);
    if (key) dupSeen.add(key);

    let status = "pending";
    if (errors.length > 0) status = "rejected";
    else if (isDup) status = "skipped_duplicate";
    else if (warnings.length > 0) status = "warning";

    stagePayloads.push({
      run_id: run.id,
      row_number: i + 2,        // +2: header row + 1-based excel
      raw_data: raw,
      normalized: { ...normalized, _warnings: warnings, _errors: errors },
      status,
      error_message: errors[0]?.message ?? null,
    });
  }

  // Bulk insert in chunks of 500 (Supabase row limit safety)
  for (let i = 0; i < stagePayloads.length; i += 500) {
    const slice = stagePayloads.slice(i, i + 500);
    const { error } = await supabase.from("import_rows").insert(slice);
    if (error) throw error;
  }

  // Capture errors into import_errors for the dashboard
  const errPayloads = [];
  for (const p of stagePayloads) {
    for (const e of (p.normalized._errors ?? [])) {
      errPayloads.push({ run_id: run.id, severity: "error", code: e.code, message: e.message,
        details: { row_number: p.row_number, field: e.field, raw: e.raw } });
    }
    for (const w of (p.normalized._warnings ?? [])) {
      errPayloads.push({ run_id: run.id, severity: "warning", code: w.code, message: w.message,
        details: { row_number: p.row_number, field: w.field } });
    }
  }
  if (errPayloads.length > 0) {
    for (let i = 0; i < errPayloads.length; i += 500) {
      await supabase.from("import_errors").insert(errPayloads.slice(i, i + 500));
    }
  }

  // 6) Update run status → awaiting_confirmation
  await supabase.from("import_runs").update({
    status: "awaiting_confirmation",
    summary: {
      detected_type: importType,
      detection_confidence: detection.confidence,
      recognition_summary: {
        mapped: recognition.mappings.filter((m) => m.internal_field).length,
        unmapped: recognition.unmapped_headers.length,
        needs_confirmation: recognition.needs_user_confirmation,
        missing_required: recognition.missing_required,
      },
      preview_rows: stagePayloads.length,
      preview_errors: errPayloads.filter((e) => e.severity === "error").length,
      preview_warnings: errPayloads.filter((e) => e.severity === "warning").length,
    },
  }).eq("id", run.id);

  auditLog({
    action: "import.upload", category: "system", result_status: "success", req,
    detail: { run_id: run.id, filename, type: importType, rows: rows.length },
  });

  res.status(201).json({
    run_id: run.id,
    import_type: importType,
    detection,
    recognition,
    preview: stagePayloads.slice(0, 10).map((p) => ({
      row_number: p.row_number, raw: p.raw_data, normalized: p.normalized, status: p.status,
    })),
    counts: {
      rows: stagePayloads.length,
      errors: errPayloads.filter((e) => e.severity === "error").length,
      warnings: errPayloads.filter((e) => e.severity === "warning").length,
    },
  });
}));

// ════════════════════════════════════════════════════════════
// PHASE 2: Confirm + resolve + commit
// ════════════════════════════════════════════════════════════

router.post("/:id/confirm", validate(schemas.importConfirm), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { column_mappings, save_as_template, template_name } = req.body;

  const { data: run, error: rErr } = await supabase
    .from("import_runs").select("*").eq("id", id).maybeSingle();
  if (rErr) throw rErr;
  if (!run) return res.status(404).json({ error: "import run not found" });
  if (run.status !== "awaiting_confirmation" && run.status !== "partial") {
    return res.status(409).json({ error: `run status is ${run.status}, cannot commit` });
  }

  // Persist confirmed mappings
  await supabase.from("import_runs").update({ status: "committing", column_mappings }).eq("id", id);

  // Update learning dictionary with approved mappings
  for (const m of column_mappings) {
    if (!m.internal_field) continue;
    const norm = normalizeHeader(m.external_header);
    await supabase.from("import_field_mappings").upsert({
      external_header: norm,
      internal_field: m.internal_field,
      import_type: run.import_type,
      approved_count: 1,
      confidence: 0.95,
      updated_at: new Date().toISOString(),
    }, { onConflict: "external_header,internal_field,import_type,factory_id" });
  }

  // Optional template save
  if (save_as_template && template_name) {
    await supabase.from("import_templates").insert({
      name: template_name,
      source_hint: run.filename,
      import_type: run.import_type,
      factory_id: run.detected_factory_id,
      column_mappings,
      use_count: 1,
      last_used_at: new Date().toISOString(),
      created_by: req.pilotIdentity?.operator ?? "system",
    });
  }

  // Pull staged rows + re-normalize with the FINAL mappings (in case user changed)
  const { data: stagedRows, error: srErr } = await supabase
    .from("import_rows").select("*").eq("run_id", id).neq("status", "rejected").order("row_number");
  if (srErr) throw srErr;

  // Resolve entities
  const resolvedRows = [];
  const unresolvedAgg = new Map();    // (field, value) → occurrences
  for (const row of stagedRows ?? []) {
    const n = { ...(row.normalized ?? {}) };

    // Resolve factory
    if (n.factory_name) {
      const r = await resolveFactoryName(supabase, n.factory_name);
      if (r.resolved) n._resolved_factory_id = r.resolved.id;
      else tallyUnresolved(unresolvedAgg, "factory_name", n.factory_name);
    }
    // Resolve line (scoped to resolved factory if any)
    if (n.line_name) {
      const r = await resolveLineName(supabase, n.line_name, n._resolved_factory_id);
      if (r.resolved) n._resolved_line_id = r.resolved.id;
      else tallyUnresolved(unresolvedAgg, "line_name", n.line_name);
    }
    // Resolve order
    if (n.order_no) {
      const r = await resolveOrderNo(supabase, n.order_no);
      if (r.resolved) n._resolved_order_id = r.resolved.id;
      else tallyUnresolved(unresolvedAgg, "order_no", n.order_no);
    }
    resolvedRows.push({ ...row, normalized: n, warnings: (row.normalized?._warnings ?? []) });
  }

  // Persist unresolved mappings
  for (const [key, info] of unresolvedAgg) {
    const [field, value] = key.split("\0");
    await supabase.from("unresolved_import_mappings").upsert({
      run_id: id,
      external_field: field,
      external_value: value,
      occurrences: info.count,
      suggested_matches: info.suggestions ?? [],
    }, { onConflict: "run_id,external_field,external_value" });
  }

  // Commit
  const commitResult = await commitRun(supabase, run, resolvedRows, { actor: req.pilotIdentity?.operator });

  const finalStatus = commitResult.errors > 0
    ? (commitResult.created > 0 ? "partial" : "failed")
    : "completed";
  await supabase.from("import_runs").update({
    status: finalStatus,
    completed_at: new Date().toISOString(),
    summary: {
      ...(run.summary ?? {}),
      committed: commitResult.created,
      skipped_duplicates: commitResult.skipped,
      commit_errors: commitResult.errors,
      events_emitted: commitResult.events.length,
      unresolved_mappings: unresolvedAgg.size,
    },
  }).eq("id", id);

  auditLog({
    action: "import.commit", category: "system",
    result_status: finalStatus === "completed" ? "success" : finalStatus === "partial" ? "partial" : "failed",
    req,
    detail: { run_id: id, ...commitResult, unresolved: unresolvedAgg.size },
  });

  res.json({
    run_id: id,
    status: finalStatus,
    committed: commitResult.created,
    skipped_duplicates: commitResult.skipped,
    errors: commitResult.errors,
    events_emitted: commitResult.events.length,
    unresolved_mappings: unresolvedAgg.size,
  });
}));

function tallyUnresolved(map, field, value) {
  const key = `${field}\0${value}`;
  const cur = map.get(key) ?? { count: 0, suggestions: [] };
  cur.count++;
  map.set(key, cur);
}

// ════════════════════════════════════════════════════════════
// Read endpoints
// ════════════════════════════════════════════════════════════

router.get("/runs", asyncHandler(async (req, res) => {
  const limit = Math.min(100, Number(req.query.limit ?? 30));
  const { data, error } = await supabase
    .from("import_runs").select("*")
    .order("started_at", { ascending: false }).limit(limit);
  if (error) throw error;
  res.json({ count: data?.length ?? 0, runs: data ?? [] });
}));

router.get("/runs/:id", asyncHandler(async (req, res) => {
  const { data: run, error } = await supabase.from("import_runs").select("*").eq("id", req.params.id).maybeSingle();
  if (error) throw error;
  if (!run) return res.status(404).json({ error: "not found" });

  const [rowsRes, errsRes, unresolvedRes] = await Promise.all([
    supabase.from("import_rows").select("*").eq("run_id", run.id).order("row_number").limit(500),
    supabase.from("import_errors").select("*").eq("run_id", run.id).order("created_at"),
    supabase.from("unresolved_import_mappings").select("*").eq("run_id", run.id),
  ]);

  res.json({
    run,
    rows: rowsRes.data ?? [],
    errors: errsRes.data ?? [],
    unresolved: unresolvedRes.data ?? [],
  });
}));

router.get("/unresolved", asyncHandler(async (_req, res) => {
  const { data, error } = await supabase
    .from("unresolved_import_mappings")
    .select("*").eq("status", "pending")
    .order("created_at", { ascending: false }).limit(200);
  if (error) throw error;
  res.json({ count: data?.length ?? 0, items: data ?? [] });
}));

router.post("/unresolved/:id/resolve", validate(schemas.importResolveMapping), asyncHandler(async (req, res) => {
  const { resolved_internal_type, resolved_internal_id } = req.body;
  const { data, error } = await supabase
    .from("unresolved_import_mappings")
    .update({
      status: "resolved",
      resolved_internal_type, resolved_internal_id,
      resolved_by: req.pilotIdentity?.operator ?? "system",
      resolved_at: new Date().toISOString(),
    })
    .eq("id", req.params.id)
    .select().single();
  if (error) throw error;
  res.json(data);
}));

router.get("/templates", asyncHandler(async (_req, res) => {
  const { data, error } = await supabase
    .from("import_templates").select("*")
    .order("last_used_at", { ascending: false, nullsFirst: false }).limit(50);
  if (error) throw error;
  res.json({ count: data?.length ?? 0, templates: data ?? [] });
}));

export default router;
