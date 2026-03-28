/**
 * API Configuration — single source of truth for base URL resolution.
 *
 * Resolution order:
 *   1. VITE_API_BASE_URL env var (set in Vercel / .env.local)
 *   2. "/api" fallback (works with Vite dev proxy)
 *
 * The env var MUST include the /api prefix:
 *   VITE_API_BASE_URL=https://my-backend.railway.app/api
 */

function resolveBaseUrl(): string {
  const fromEnv = import.meta.env.VITE_API_BASE_URL;
  if (fromEnv) {
    // Strip trailing slash for consistency
    return fromEnv.replace(/\/+$/, "");
  }
  return "/api";
}

export const API_BASE_URL = resolveBaseUrl();

/**
 * Whether the base URL points to a remote server (not same-origin proxy).
 * When true, requests are cross-origin and need CORS.
 */
export const IS_REMOTE_API = API_BASE_URL.startsWith("http");

/**
 * Whether we're running in development mode.
 */
export const IS_DEV = import.meta.env.DEV === true;

/**
 * Diagnostics — expose config for debugging.
 * Call from browser console: __prodOS.config
 */
export const diagnostics = {
  api_base_url: API_BASE_URL,
  is_remote: IS_REMOTE_API,
  is_dev: IS_DEV,
  env_var_set: !!import.meta.env.VITE_API_BASE_URL,
  resolved_at: new Date().toISOString(),
};

// Attach to window for console debugging
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__prodOS = { config: diagnostics };
}

// Log config on startup in dev
if (IS_DEV) {
  console.log("[Production-OS] API config:", diagnostics);
}
