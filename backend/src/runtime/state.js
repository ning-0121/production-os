/**
 * Runtime State I/O — thin DB wrapper around production_runtime_lines.
 *
 * Pure logic lives in `scheduler.js` / `events.js` / `propagation.js`. This
 * file is the only place that reads/writes runtime state. Optimistic
 * concurrency (version column) prevents lost updates from concurrent runtime
 * events.
 */

/**
 * List runtime line states with optional filters.
 * @param {object} supabase
 * @param {{factory_id?: string, status?: string, risk?: string}} [filters]
 */
export async function listRuntimeLines(supabase, filters = {}) {
  let q = supabase.from("production_runtime_lines").select("*");
  if (filters.factory_id) q = q.eq("factory_id", filters.factory_id);
  if (filters.status) q = q.eq("runtime_status", filters.status);
  if (filters.risk) q = q.eq("runtime_risk", filters.risk);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

/** Get one runtime line by line_id, or null. */
export async function getRuntimeLine(supabase, line_id) {
  const { data, error } = await supabase
    .from("production_runtime_lines")
    .select("*")
    .eq("line_id", line_id)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

/**
 * Upsert a runtime line, enforcing optimistic concurrency. If `expected_version`
 * is provided, the update only succeeds when the row's current version matches.
 * Returns `{ updated: boolean, row, conflict?: {current_version} }`.
 *
 * @param {object} supabase
 * @param {object} patch        must include line_id; may include any updatable fields
 * @param {{expected_version?: number, actor?: string}} [opts]
 */
export async function upsertRuntimeLine(supabase, patch, opts = {}) {
  if (!patch?.line_id) throw new Error("upsertRuntimeLine: line_id required");

  const existing = await getRuntimeLine(supabase, patch.line_id);

  // Optimistic concurrency check
  if (existing && opts.expected_version != null && existing.version !== opts.expected_version) {
    return {
      updated: false,
      row: existing,
      conflict: { current_version: existing.version, expected_version: opts.expected_version },
    };
  }

  const next = {
    ...existing,
    ...patch,
    version: (existing?.version ?? 0) + 1,
    updated_at: new Date().toISOString(),
    updated_by: opts.actor ?? patch.updated_by ?? "system",
  };

  // Strip non-column fields that may sneak in (e.g. queue is computed, not stored)
  delete next.queue;

  // Insert or update
  if (!existing) {
    const { data, error } = await supabase
      .from("production_runtime_lines")
      .insert(next)
      .select()
      .single();
    if (error) throw error;
    return { updated: true, row: data, created: true };
  } else {
    const { data, error } = await supabase
      .from("production_runtime_lines")
      .update(next)
      .eq("id", existing.id)
      .eq("version", existing.version)   // belt-and-suspenders concurrency guard
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      // Row updated by someone else in between
      const fresh = await getRuntimeLine(supabase, patch.line_id);
      return {
        updated: false,
        row: fresh,
        conflict: { current_version: fresh?.version ?? null, expected_version: existing.version },
      };
    }
    return { updated: true, row: data };
  }
}

/**
 * Take a snapshot of the entire runtime state — used as the rollback baseline
 * before risky scheduling operations.
 */
export async function takeSnapshot(supabase, { reason, taken_by, label } = {}) {
  const lines = await listRuntimeLines(supabase);
  const { data: maxSeqRow } = await supabase
    .from("runtime_events")
    .select("replay_seq")
    .order("replay_seq", { ascending: false })
    .limit(1)
    .maybeSingle();

  const snapshot = {
    taken_by: taken_by ?? "system",
    reason: reason ?? "manual",
    label: label ?? null,
    payload: {
      lines,
      events_seq_max: maxSeqRow?.replay_seq ?? 0,
      taken_at_iso: new Date().toISOString(),
    },
  };

  const { data, error } = await supabase
    .from("runtime_snapshots")
    .insert(snapshot)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getSnapshot(supabase, id) {
  const { data, error } = await supabase
    .from("runtime_snapshots")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Apply a runtime plan (output of scheduler/insertEmergency/localReschedule)
 * by writing affected line state changes. Each line goes through optimistic
 * concurrency. Returns per-line outcome.
 */
export async function applyPlanToLines(supabase, plan, derivedLineUpdates, opts = {}) {
  const results = [];
  for (const update of derivedLineUpdates) {
    const r = await upsertRuntimeLine(supabase, update, {
      expected_version: update.expected_version,
      actor: opts.actor ?? "runtime-scheduler",
    });
    results.push({ line_id: update.line_id, ...r });
  }
  return { plan_action: plan?.action_type, line_results: results };
}
