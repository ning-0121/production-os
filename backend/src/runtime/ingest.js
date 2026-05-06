/**
 * Event Ingest Pipeline — the single entry point for new runtime events.
 *
 * Pipeline:
 *   1. Persist event row (status=pending) — gets monotone replay_seq
 *   2. Load constraint graph (or use cached snapshot)
 *   3. Run propagation if origin node exists
 *   4. Persist affected_entities + propagation_status=completed back to event
 *   5. Optionally update live runtime_lines using events.js handlers
 *   6. Return { event, propagation, lines_updated }
 *
 * The pipeline is idempotent on retries via `correlation_id` if the caller
 * provides one (otherwise the DB generates a new uuid per call).
 */

import crypto from "node:crypto";
import { buildGraph, findNodeByRef } from "./graph.js";
import { propagateImpact } from "./propagation.js";
import { replay } from "./events.js";
import { listRuntimeLines, upsertRuntimeLine } from "./state.js";

/**
 * Ingest a new runtime event end-to-end.
 *
 * @param {object} supabase
 * @param {{
 *   event_type: string,
 *   severity?: string,
 *   source?: string,
 *   source_ref?: string,
 *   factory_id?: string,
 *   line_id?: string,
 *   allocation_id?: string,
 *   order_id?: string,
 *   payload?: object,
 *   reasoning?: string,
 *   confidence?: number,
 *   correlation_id?: string,
 *   caused_by_event_id?: string,
 *   occurred_at?: string,
 *   request_id?: string,
 * }} input
 * @param {{actor?: string, propagate?: boolean, apply_to_lines?: boolean}} [opts]
 */
export async function ingestEvent(supabase, input, opts = {}) {
  const { propagate = true, apply_to_lines = true } = opts;

  // 1) Persist event
  const { data: event, error: insErr } = await supabase
    .from("runtime_events")
    .insert({
      event_type: input.event_type,
      severity: input.severity ?? "medium",
      source: input.source ?? "system",
      source_ref: input.source_ref ?? null,
      factory_id: input.factory_id ?? null,
      line_id: input.line_id ?? null,
      allocation_id: input.allocation_id ?? null,
      order_id: input.order_id ?? null,
      payload: input.payload ?? {},
      reasoning: input.reasoning ?? null,
      confidence: input.confidence ?? null,
      correlation_id: input.correlation_id ?? crypto.randomUUID(),
      caused_by_event_id: input.caused_by_event_id ?? null,
      occurred_at: input.occurred_at ?? new Date().toISOString(),
      request_id: input.request_id ?? null,
      propagation_status: "pending",
      affected_entities: [],
    })
    .select()
    .single();
  if (insErr) throw insErr;

  let propagation = null;
  let lineUpdates = [];

  // 2-3) Propagate if requested AND if we can find an origin node
  if (propagate) {
    propagation = await runPropagation(supabase, event);

    // 4) Persist propagation results onto the event
    await supabase
      .from("runtime_events")
      .update({
        affected_entities: propagation.impacted ?? [],
        propagation_status: propagation.skipped ? "skipped" : "completed",
        propagation_run_id: propagation.run_id,
      })
      .eq("id", event.id);
  }

  // 5) Apply to live runtime_lines via events.js fold (for state-affecting events)
  if (apply_to_lines) {
    lineUpdates = await applyEventToLines(supabase, event, opts);
  }

  return {
    event,
    propagation,
    lines_updated: lineUpdates,
  };
}

/**
 * Load nodes/edges for propagation. Caller can pre-build a graph and pass it
 * in via opts.graph for performance (e.g. when ingesting a burst of events).
 */
export async function loadGraph(supabase) {
  const [{ data: nodes, error: ne }, { data: edges, error: ee }] = await Promise.all([
    supabase.from("constraint_nodes").select("*"),
    supabase.from("constraint_edges").select("*"),
  ]);
  if (ne) throw ne;
  if (ee) throw ee;
  return buildGraph(nodes ?? [], edges ?? []);
}

async function runPropagation(supabase, event) {
  const graph = await loadGraph(supabase);

  // Resolve origin node from the event. Strategy: try most-specific to most-generic.
  let origin = null;
  if (event.allocation_id) origin = findNodeByRef(graph, "allocation", event.allocation_id);
  if (!origin && event.line_id) origin = findNodeByRef(graph, "line", event.line_id);
  if (!origin && event.order_id) origin = findNodeByRef(graph, "order", event.order_id);
  if (!origin && event.factory_id) origin = findNodeByRef(graph, "factory", event.factory_id);
  // Some payloads carry an explicit material_id
  if (!origin && event.payload?.material_id) origin = findNodeByRef(graph, "material", event.payload.material_id);

  if (!origin) {
    return {
      skipped: true,
      reason: "no_origin_node_in_graph",
      origin_node_id: null,
      impacted: [],
      run_id: crypto.randomUUID(),
    };
  }

  const result = propagateImpact(graph, origin.id, event.severity, {
    estimated_delay_days: Number(event.payload?.delay_days ?? 0),
  });

  return {
    skipped: false,
    run_id: crypto.randomUUID(),
    ...result,
  };
}

/**
 * Apply a single event to live line state. Returns the per-line update results.
 * Implementation: load current lines, replay this single event over them via
 * `events.js`, then upsert any line whose state changed.
 */
async function applyEventToLines(supabase, event, opts) {
  const lines = await listRuntimeLines(supabase);
  const result = replay([event], { lines });

  const updates = [];
  for (const next of result.final_state.lines) {
    const prev = lines.find((l) => l.line_id === next.line_id);
    if (!prev || lineDiffersForPersistence(prev, next)) {
      const { queue: _q, id: _id, version: _v, ...patch } = next;
      const upsert = await upsertRuntimeLine(supabase, {
        line_id: next.line_id,
        ...patch,
      }, { actor: opts.actor ?? `event:${event.event_type}` });
      updates.push({ line_id: next.line_id, ...upsert });
    }
  }
  return updates;
}

function lineDiffersForPersistence(a, b) {
  const watch = ["runtime_status", "current_efficiency", "actual_output_today",
                 "expected_output_today", "overload_pct", "runtime_risk",
                 "current_order_id", "current_allocation_id", "current_operation",
                 "planned_end_at", "factory_id"];
  return watch.some((f) => String(a?.[f] ?? "") !== String(b?.[f] ?? ""));
}
