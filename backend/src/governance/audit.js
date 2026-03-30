/**
 * Server-side audit helper.
 *
 * Fire-and-forget insertion into pilot_audit_log.
 * Never throws — logging failures must not break the action being logged.
 */

import { supabase } from "../supabase.js";

const PILOT_MODE = process.env.PILOT_MODE === "true";

/**
 * Log a governance-relevant action.
 *
 * @param {object} params
 * @param {string} params.action — what happened
 * @param {string} params.category — optimizer | allocation | calibration | factory | system
 * @param {"success"|"blocked"|"failed"|"partial"} params.result_status
 * @param {object} [params.req] — Express request (extracts identity)
 * @param {string} [params.error_code]
 * @param {string} [params.run_id]
 * @param {object} [params.detail]
 */
export function auditLog(params) {
  const {
    action,
    category = "system",
    result_status = "success",
    req,
    error_code,
    run_id,
    detail,
  } = params;

  const identity = req?.pilotIdentity ?? { operator: "system", role: "system" };

  const entry = {
    occurred_at: new Date().toISOString(),
    operator: identity.operator,
    role: identity.role,
    action,
    category,
    result_status,
    error_code: error_code ?? null,
    request_id: null,
    run_id: run_id ?? null,
    blocked: result_status === "blocked",
    page: null,
    detail: detail ?? {},
    environment: PILOT_MODE ? "pilot" : "production",
  };

  // Fire-and-forget
  supabase
    .from("pilot_audit_log")
    .insert(entry)
    .then(({ error }) => {
      if (error) console.log("[AUDIT FALLBACK]", JSON.stringify(entry));
    })
    .catch(() => {
      console.log("[AUDIT FALLBACK]", JSON.stringify(entry));
    });
}
