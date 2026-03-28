/**
 * Application Configuration — single source of truth.
 *
 * API URL resolution:
 *   1. VITE_API_BASE_URL env var (set in Vercel / .env.local)
 *   2. "/api" fallback (works with Vite dev proxy)
 *
 * Pilot mode:
 *   VITE_PILOT_MODE=true → restrict writes, require confirmations, log actions
 *   Default: false (full write access)
 */

// ── API Base URL ────────────────────────────────────────

function resolveBaseUrl(): string {
  const fromEnv = import.meta.env.VITE_API_BASE_URL;
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  return "/api";
}

export const API_BASE_URL = resolveBaseUrl();
export const IS_REMOTE_API = API_BASE_URL.startsWith("http");
export const IS_DEV = import.meta.env.DEV === true;

// ── Pilot Mode ──────────────────────────────────────────

export const PILOT_MODE = import.meta.env.VITE_PILOT_MODE === "true";

/**
 * What pilot mode controls:
 *   - writes_blocked: optimizer confirm, allocation status changes, factory edits
 *   - preview_allowed: optimizer preview, data viewing, risk scan
 *   - confirmation_required: even if writes enabled, show confirmation dialog
 *   - audit_logging: log all significant actions
 */
export const pilotPolicy = {
  writes_blocked: PILOT_MODE,
  preview_allowed: true,             // always allowed
  confirmation_required: PILOT_MODE, // extra confirm dialog before writes
  audit_logging: PILOT_MODE,         // log actions to audit trail
} as const;

// ── Diagnostics ─────────────────────────────────────────

export const diagnostics = {
  api_base_url: API_BASE_URL,
  is_remote: IS_REMOTE_API,
  is_dev: IS_DEV,
  pilot_mode: PILOT_MODE,
  env_var_set: !!import.meta.env.VITE_API_BASE_URL,
  resolved_at: new Date().toISOString(),
};

if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__prodOS = { config: diagnostics };
}

if (IS_DEV) {
  console.log("[Production-OS] config:", diagnostics);
}
if (PILOT_MODE) {
  console.log("[Production-OS] PILOT MODE active — writes restricted, actions logged");
}
