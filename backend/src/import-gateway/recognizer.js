/**
 * Column Recognizer — maps external Excel headers → internal fields.
 *
 * Three-pass strategy (pure function except for the optional learned-mappings input):
 *   1. Learned mappings (from import_field_mappings DB) — confidence = stored value
 *   2. Dictionary (dictionary.js)                       — confidence from matchScore
 *   3. LLM fallback                                     — only for headers below threshold
 *
 * Returns a deterministic mapping object suitable for stage-then-confirm UX.
 */

import { INTERNAL_FIELDS, FIELDS_PER_TYPE, TYPE_SIGNATURES, normalizeHeader, matchScore } from "./dictionary.js";

const CONFIDENCE_AUTO_ACCEPT = 0.9;   // ≥ this → auto-pick the mapping
const CONFIDENCE_FLOOR = 0.4;          // < this → leave unmapped, surface to user

/**
 * @param {string[]} headers   external headers from the workbook
 * @param {Record<string, Array<{internal_field: string, confidence: number}>>} learnedByHeader
 *        keyed by normalizeHeader(external). Each value is sorted candidates from DB.
 * @param {string} importType   'daily_report' | 'hanging_line' | 'qc' | 'rework' | 'generic'
 * @returns {{
 *   mappings: Array<{
 *     external_header: string,
 *     internal_field: string|null,
 *     confidence: number,
 *     source: 'learned'|'dictionary'|'llm'|null,
 *     candidates: Array<{internal_field: string, confidence: number, source: string}>,
 *     auto_accepted: boolean,
 *   }>,
 *   unmapped_headers: string[],
 *   missing_required: string[],
 *   needs_user_confirmation: boolean,
 * }}
 */
export function recognizeColumns({ headers, learnedByHeader = {}, importType = "daily_report" }) {
  const candidateFields = FIELDS_PER_TYPE[importType] ?? FIELDS_PER_TYPE.generic;
  const mappings = [];
  const claimedFields = new Set();        // an internal field maps to at most one column

  // First pass — collect all (header × field) candidates, then resolve conflicts.
  const allCandidates = [];
  for (const h of headers) {
    const norm = normalizeHeader(h);
    const fromLearned = (learnedByHeader[norm] ?? [])
      .filter((c) => candidateFields.includes(c.internal_field))
      .map((c) => ({ external_header: h, internal_field: c.internal_field, confidence: c.confidence, source: "learned" }));

    const fromDict = candidateFields
      .map((field) => ({ external_header: h, internal_field: field, confidence: matchScore(h, field), source: "dictionary" }))
      .filter((c) => c.confidence > 0);

    allCandidates.push({
      header: h,
      candidates: [...fromLearned, ...fromDict].sort((a, b) => b.confidence - a.confidence),
    });
  }

  // Second pass — greedy assign highest-confidence (header, field) pair, breaking ties.
  // We use a simple priority queue: sort all candidate pairs by confidence desc.
  const flat = allCandidates.flatMap((entry) => entry.candidates);
  flat.sort((a, b) => b.confidence - a.confidence);
  const headerAssigned = new Map();   // header → mapping
  for (const c of flat) {
    if (headerAssigned.has(c.external_header)) continue;
    if (claimedFields.has(c.internal_field)) continue;
    if (c.confidence < CONFIDENCE_FLOOR) continue;
    headerAssigned.set(c.external_header, c);
    claimedFields.add(c.internal_field);
  }

  // Build final mapping array — one entry per external header
  for (const { header, candidates } of allCandidates) {
    const chosen = headerAssigned.get(header) ?? null;
    mappings.push({
      external_header: header,
      internal_field: chosen?.internal_field ?? null,
      confidence: chosen?.confidence ?? 0,
      source: chosen?.source ?? null,
      candidates: candidates.slice(0, 5),
      auto_accepted: !!chosen && chosen.confidence >= CONFIDENCE_AUTO_ACCEPT,
    });
  }

  const unmapped_headers = mappings.filter((m) => !m.internal_field).map((m) => m.external_header);

  const requiredFields = candidateFields.filter((f) => INTERNAL_FIELDS[f]?.required);
  const mappedFields = new Set(mappings.filter((m) => m.internal_field).map((m) => m.internal_field));
  const missing_required = requiredFields.filter((f) => !mappedFields.has(f));

  const needs_user_confirmation = mappings.some((m) => m.internal_field && !m.auto_accepted)
    || unmapped_headers.length > 0
    || missing_required.length > 0;

  return { mappings, unmapped_headers, missing_required, needs_user_confirmation };
}

/**
 * Detect the most likely import_type from a list of headers using
 * TYPE_SIGNATURES. Returns the winning type + confidence.
 */
export function detectImportType(headers) {
  const normHeaders = headers.map(normalizeHeader);
  const scores = {};
  for (const [type, sigs] of Object.entries(TYPE_SIGNATURES)) {
    let hits = 0;
    for (const sig of sigs) {
      const ns = normalizeHeader(sig);
      if (normHeaders.some((h) => h.includes(ns) || ns.includes(h))) hits++;
    }
    scores[type] = hits / sigs.length;
  }
  let bestType = "daily_report";   // safe default
  let bestScore = 0;
  for (const [t, s] of Object.entries(scores)) {
    if (s > bestScore) { bestScore = s; bestType = t; }
  }
  return { import_type: bestType, confidence: bestScore, scores };
}
