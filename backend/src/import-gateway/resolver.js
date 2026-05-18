/**
 * Entity Resolver — match external string values to internal entity IDs.
 *
 * "工厂A 一号车间" (Excel) → factories.id (UUID)
 * "ORD-2026-101"          → orders.id or orders.order_number
 *
 * Strategy:
 *   1. Exact case-insensitive match on canonical field (name, code, order_number)
 *   2. Substring containment (Excel includes our value or vice versa)
 *   3. Levenshtein distance (cheap, for typos)
 *
 * On miss: returns { resolved: null, suggestions: [...top 3] } and the caller
 * stages an `unresolved_import_mappings` row instead of failing the import.
 */

export async function resolveFactoryName(supabase, name) {
  return resolve(supabase, "factories", "name", name, ["id", "name"]);
}

export async function resolveLineName(supabase, name, factoryId = null) {
  let q = supabase.from("production_lines").select("id, name, factory_id");
  if (factoryId) q = q.eq("factory_id", factoryId);
  return await resolveFromQuery(q, "name", name);
}

/**
 * Order resolution is special: order_no in Excel can map to either
 * `orders.order_number` (V4) or `production_allocations.order_id` (V3 text).
 * Try the V4 orders table first since it's the modern source of truth.
 */
export async function resolveOrderNo(supabase, orderNo) {
  if (!orderNo) return { resolved: null, suggestions: [] };
  const norm = String(orderNo).trim();
  const { data: v4 } = await supabase
    .from("orders").select("id, order_number")
    .ilike("order_number", norm)
    .limit(5);
  if (v4 && v4.length === 1) return { resolved: { type: "order", id: v4[0].id, label: v4[0].order_number }, suggestions: [] };

  if (v4 && v4.length > 1) {
    return {
      resolved: null,
      suggestions: v4.map((r) => ({ id: r.id, label: r.order_number, score: 1.0 })),
    };
  }

  // Fuzzy V4
  const fuzzy = await fuzzyMatchTable(supabase, "orders", "order_number", norm);
  if (fuzzy.length > 0) {
    return {
      resolved: fuzzy[0].score >= 0.95 ? { type: "order", id: fuzzy[0].id, label: fuzzy[0].label } : null,
      suggestions: fuzzy.slice(0, 3),
    };
  }
  return { resolved: null, suggestions: [] };
}

// ── Generic resolver ────────────────────────────────────────

async function resolve(supabase, table, field, value, selectCols) {
  if (!value) return { resolved: null, suggestions: [] };
  const norm = String(value).trim();
  const q = supabase.from(table).select(selectCols.join(", "));
  return await resolveFromQuery(q, field, norm);
}

async function resolveFromQuery(query, field, value) {
  const norm = String(value).trim();
  const { data, error } = await query.ilike(field, norm).limit(5);
  if (error) return { resolved: null, suggestions: [], error: error.message };
  if (data && data.length === 1) {
    return { resolved: { type: "row", id: data[0].id, label: data[0][field] }, suggestions: [] };
  }
  if (data && data.length > 1) {
    return { resolved: null, suggestions: data.map((r) => ({ id: r.id, label: r[field], score: 1.0 })) };
  }
  // Fuzzy
  const { data: all } = await query.limit(200);
  if (!all || all.length === 0) return { resolved: null, suggestions: [] };
  const scored = all.map((r) => ({ id: r.id, label: r[field], score: similarity(norm, r[field] ?? "") }))
    .filter((s) => s.score > 0.4)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  if (scored.length > 0 && scored[0].score >= 0.95) {
    return { resolved: { type: "row", id: scored[0].id, label: scored[0].label }, suggestions: scored.slice(1) };
  }
  return { resolved: null, suggestions: scored.slice(0, 3) };
}

async function fuzzyMatchTable(supabase, table, field, value) {
  const { data } = await supabase.from(table).select(`id, ${field}`).limit(500);
  if (!data) return [];
  return data
    .map((r) => ({ id: r.id, label: r[field], score: similarity(value, r[field] ?? "") }))
    .filter((s) => s.score > 0.4)
    .sort((a, b) => b.score - a.score);
}

/**
 * Cheap similarity: normalized Levenshtein. Returns 0..1.
 * Good enough for matching "工厂A" vs "工厂 A" vs "factory A".
 */
export function similarity(a, b) {
  const sa = String(a).trim().toLowerCase().replace(/\s+/g, "");
  const sb = String(b).trim().toLowerCase().replace(/\s+/g, "");
  if (!sa || !sb) return 0;
  if (sa === sb) return 1;
  if (sa.includes(sb) || sb.includes(sa)) return Math.min(sa.length, sb.length) / Math.max(sa.length, sb.length);
  const dist = levenshtein(sa, sb);
  return 1 - dist / Math.max(sa.length, sb.length);
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array(n + 1).fill(0).map((_, i) => i);
  const curr = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}
