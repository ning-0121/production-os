/**
 * useRiskBatch — fetch canonical RiskAssessments for a list of subjects in ONE
 * request, with a shared module-level cache so the same subject rendered on
 * multiple pages (or multiple times on one page) never refetches.
 *
 * This is the anti-N+1 layer. List pages call this once with all visible ids;
 * every row reads from the returned Map.
 *
 * Cache strategy:
 *   - module-level Map keyed by `${type}:${id}`
 *   - TTL so risk doesn't go stale (default 60s — risk changes minute-to-minute
 *     in a live factory, but not second-to-second)
 *   - invalidateRiskCache() exported for explicit refresh after mutations
 */

import React from "react";
import { fetchRiskBatch } from "../services/api";
import type { RiskAssessment } from "../types";

type SubjectType = RiskAssessment["subject"]["type"];

const TTL_MS = 60_000;

type CacheEntry = { assessment: RiskAssessment; fetchedAt: number };
const cache = new Map<string, CacheEntry>();

function key(type: SubjectType, id: string) {
  return `${type}:${id}`;
}

function getFresh(type: SubjectType, id: string): RiskAssessment | null {
  const e = cache.get(key(type, id));
  if (!e) return null;
  if (Date.now() - e.fetchedAt > TTL_MS) return null;
  return e.assessment;
}

/** Drop all cached risk (call after an action that changes production state). */
export function invalidateRiskCache(type?: SubjectType, id?: string) {
  if (type && id) cache.delete(key(type, id));
  else cache.clear();
}

/**
 * @returns {
 *   map: Map<id, RiskAssessment>,   // lookup by subject id
 *   loading: boolean,
 *   error: string | null,
 *   refetch: () => void,
 * }
 */
export function useRiskBatch(subjectType: SubjectType, ids: string[]) {
  const [map, setMap] = React.useState<Map<string, RiskAssessment>>(new Map());
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [nonce, setNonce] = React.useState(0);

  // Stable signature so the effect only reruns when the id set actually changes.
  const idSig = React.useMemo(() => [...new Set(ids.filter(Boolean))].sort().join(","), [ids]);

  React.useEffect(() => {
    let cancelled = false;
    const uniqueIds = idSig ? idSig.split(",") : [];
    if (uniqueIds.length === 0) {
      setMap(new Map());
      return;
    }

    // Seed from cache; only fetch the misses.
    const next = new Map<string, RiskAssessment>();
    const misses: string[] = [];
    for (const id of uniqueIds) {
      const fresh = getFresh(subjectType, id);
      if (fresh) next.set(id, fresh);
      else misses.push(id);
    }
    setMap(new Map(next));

    if (misses.length === 0) return;

    setLoading(true);
    setError(null);
    fetchRiskBatch(subjectType, misses)
      .then((res) => {
        if (cancelled) return;
        const merged = new Map(next);
        for (const a of res.assessments ?? []) {
          cache.set(key(subjectType, a.subject.id), { assessment: a, fetchedAt: Date.now() });
          merged.set(a.subject.id, a);
        }
        setMap(merged);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [subjectType, idSig, nonce]);

  const refetch = React.useCallback(() => {
    invalidateRiskCache(subjectType);
    setNonce((n) => n + 1);
  }, [subjectType]);

  return { map, loading, error, refetch };
}
