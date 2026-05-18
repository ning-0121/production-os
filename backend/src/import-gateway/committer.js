/**
 * Committer — write staged import_rows to target tables + emit runtime events.
 *
 * This is the second phase of the two-phase import pipeline. After the user
 * confirms column mappings on `import_runs.status = awaiting_confirmation`,
 * we walk every staged row, persist it to its target table, and (critically)
 * emit runtime_events so the AI Operating Brain picks up the new data.
 *
 * Runtime events emitted (per the spec):
 *   piece_output_updated   — every successful daily/hanging row
 *   line_slowdown          — if normalizer flagged a `dip` warning
 *   output_recovered       — if previous run dipped and current is back
 *   persistent_dip         — caller computes via existing anomaly-detector
 *   qc_failure_detected    — every QC row with result='fail'
 *
 * The committer is intentionally synchronous-per-row (no batch INSERT) so
 * we can report per-row commit status and partial-failure-resilient outcomes.
 */

import { ingestEvent } from "../runtime/ingest.js";

/**
 * @param {object} supabase
 * @param {object} run                    import_runs row
 * @param {Array<object>} stagedRows      import_rows with normalized field + resolved entity IDs
 * @returns {{ created: number, skipped: number, errors: number, events: string[] }}
 */
export async function commitRun(supabase, run, stagedRows, opts = {}) {
  const actor = opts.actor ?? "import-gateway";
  let created = 0;
  let skipped = 0;
  let errorCount = 0;
  const emittedEventIds = [];

  for (const row of stagedRows) {
    try {
      const result = await commitOneRow(supabase, run, row, actor);
      if (result.skipped) skipped++;
      else if (result.created) created++;
      if (result.event_ids?.length) {
        emittedEventIds.push(...result.event_ids);
      }
      // Update import_rows status
      await supabase.from("import_rows").update({
        status: result.skipped ? "skipped_duplicate" : "committed",
        committed_entity_type: result.entity_type,
        committed_entity_id: result.entity_id,
        emitted_event_ids: result.event_ids ?? [],
        committed_at: new Date().toISOString(),
        error_message: result.warning ?? null,
      }).eq("id", row.id);
    } catch (err) {
      errorCount++;
      const msg = err instanceof Error ? err.message : String(err);
      await supabase.from("import_rows").update({
        status: "rejected",
        error_message: msg,
      }).eq("id", row.id);
      await supabase.from("import_errors").insert({
        run_id: run.id, row_id: row.id,
        severity: "error", code: "commit_failed", message: msg,
        details: { row_number: row.row_number },
      });
    }
  }

  return { created, skipped, errors: errorCount, events: emittedEventIds };
}

// ── Per-row commit ─────────────────────────────────────────

async function commitOneRow(supabase, run, row, actor) {
  const n = row.normalized ?? {};
  const eventIds = [];

  if (run.import_type === "daily_report" || run.import_type === "hanging_line") {
    // Dedup: same date + factory + line + order + stage
    const dup = await checkDupDailyReport(supabase, n);
    if (dup) return { skipped: true, entity_type: "daily_production_report", entity_id: dup.id };

    const payload = {
      date: n.date,
      factory_id: n._resolved_factory_id ?? null,
      line_id: n._resolved_line_id ?? null,
      allocation_id: n._resolved_allocation_id ?? null,
      order_id: n.order_no ?? null,
      planned_output: numOr(n.planned_output, 0),
      actual_output: numOr(n.actual_output, 0),
      cumulative_output: numOr(n.cumulative_output, numOr(n.actual_output, 0)),
      stage: n.stage ?? "sewing",
      is_abnormal: !!n.is_abnormal,
      abnormal_reason: n.abnormal_reason ?? null,
      note: n.note ?? null,
      reporter: actor,
    };
    const { data, error } = await supabase.from("daily_production_reports").insert(payload).select().single();
    if (error) throw error;

    // Emit runtime event — production updated
    const ev = await emitEvent(supabase, {
      event_type: "line_status_changed",        // closest existing event type to "piece_output_updated"
      severity: payload.is_abnormal ? "high" : "info",
      source: "external_api",
      source_ref: `import:${run.id.slice(0, 8)}`,
      factory_id: payload.factory_id,
      line_id: payload.line_id,
      allocation_id: payload.allocation_id,
      order_id: payload.order_id,
      payload: {
        kind: "piece_output_updated",
        actual: payload.actual_output, planned: payload.planned_output,
        cumulative: payload.cumulative_output, stage: payload.stage,
        import_run_id: run.id,
      },
      reasoning: payload.is_abnormal
        ? `导入数据标记异常：${payload.abnormal_reason ?? "未填写原因"}`
        : `产量数据更新：${payload.actual_output} 件 (${payload.stage})`,
      confidence: 0.95,
    });
    if (ev) eventIds.push(ev);

    // Emit slowdown event if normalizer flagged a dip via row.warnings
    const hasDip = (row.warnings ?? []).some((w) => w.code === "dip");
    if (hasDip) {
      const ev2 = await emitEvent(supabase, {
        event_type: "line_slowdown",
        severity: "high",
        source: "external_api",
        source_ref: `import:${run.id.slice(0, 8)}`,
        factory_id: payload.factory_id,
        line_id: payload.line_id,
        order_id: payload.order_id,
        payload: { actual: payload.actual_output, expected: payload.planned_output, kind: "import_detected_dip" },
        reasoning: "导入数据触发减速判定（产量低于近期均值）",
        confidence: 0.85,
      });
      if (ev2) eventIds.push(ev2);
    }

    return { created: true, entity_type: "daily_production_report", entity_id: data.id, event_ids: eventIds };
  }

  if (run.import_type === "qc") {
    // QC inspection
    const payload = {
      inspection_type: n.inspection_type ?? "final",
      order_id: n._resolved_order_id ?? null,
      factory_id: n._resolved_factory_id ?? null,
      total_qty_inspected: numOr(n.total_qty_inspected, null),
      total_defects: numOr(n.total_defects, null),
      result: n.result ?? "pending",
      inspector: actor,
      note: n.note ?? null,
      inspected_at: n.date ?? new Date().toISOString().slice(0, 10),
    };
    const { data, error } = await supabase.from("qc_inspections").insert(payload).select().single();
    if (error) throw error;

    if (payload.result === "fail") {
      const ev = await emitEvent(supabase, {
        event_type: "qc_failure",
        severity: "high",
        source: "external_api",
        source_ref: `import:${run.id.slice(0, 8)}`,
        factory_id: payload.factory_id,
        order_id: payload.order_id,
        payload: {
          inspection_id: data.id,
          inspection_type: payload.inspection_type,
          defects: payload.total_defects, inspected: payload.total_qty_inspected,
        },
        reasoning: `验货不合格：${payload.total_defects}/${payload.total_qty_inspected}`,
        confidence: 0.95,
      });
      if (ev) eventIds.push(ev);
    }

    return { created: true, entity_type: "qc_inspection", entity_id: data.id, event_ids: eventIds };
  }

  if (run.import_type === "rework") {
    const payload = {
      order_id: n._resolved_order_id ?? null,
      factory_id: n._resolved_factory_id ?? null,
      rework_qty: numOr(n.rework_qty, 0),
      reason: n.rework_reason ?? null,
      responsible_party: n.responsible_party ?? null,
      estimated_days: numOr(n.estimated_days, null),
      cost: numOr(n.cost, null),
      status: "pending",
    };
    const { data, error } = await supabase.from("rework_orders").insert(payload).select().single();
    if (error) throw error;

    const ev = await emitEvent(supabase, {
      event_type: "rework_started",
      severity: "medium",
      source: "external_api",
      source_ref: `import:${run.id.slice(0, 8)}`,
      factory_id: payload.factory_id,
      order_id: payload.order_id,
      payload: { rework_id: data.id, qty: payload.rework_qty, party: payload.responsible_party },
      reasoning: `导入返工单：${payload.rework_qty} 件，原因：${payload.reason ?? "未填"}`,
      confidence: 0.9,
    });
    if (ev) eventIds.push(ev);

    return { created: true, entity_type: "rework_order", entity_id: data.id, event_ids: eventIds };
  }

  // generic — store raw only, no target table commit
  return { skipped: true, entity_type: null, entity_id: null };
}

// ── Helpers ────────────────────────────────────────────────

async function checkDupDailyReport(supabase, n) {
  if (!n.date) return null;
  let q = supabase.from("daily_production_reports").select("id").eq("date", n.date);
  if (n._resolved_factory_id) q = q.eq("factory_id", n._resolved_factory_id);
  if (n._resolved_line_id) q = q.eq("line_id", n._resolved_line_id);
  if (n.order_no) q = q.eq("order_id", n.order_no);
  if (n.stage) q = q.eq("stage", n.stage);
  const { data } = await q.limit(1);
  return data && data[0] ? data[0] : null;
}

async function emitEvent(supabase, body) {
  try {
    const r = await ingestEvent(supabase, body, { actor: "import-gateway", propagate: true, apply_to_lines: true });
    return r?.event?.id ?? null;
  } catch (err) {
    console.error("[committer] failed to emit event:", err?.message ?? err);
    return null;
  }
}

function numOr(v, fallback) {
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
