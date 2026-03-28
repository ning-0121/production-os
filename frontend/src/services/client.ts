/**
 * HTTP Client — all network requests go through here.
 *
 * Responsibilities:
 *   - Prepend API_BASE_URL to all paths
 *   - Set JSON headers
 *   - Detect HTML responses (Vercel rewrite trap)
 *   - Normalize errors into readable messages
 *   - Health check with content-type validation
 */

import { API_BASE_URL } from "./config";

// ── Error types ─────────────────────────────────────────

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

// ── Core request function ───────────────────────────────

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${API_BASE_URL}${path}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
  } catch (err) {
    // Network-level failure: offline, DNS, CORS preflight blocked, etc.
    const msg = err instanceof Error ? err.message : "Network request failed";
    throw new NetworkError(`Cannot reach API at ${API_BASE_URL}: ${msg}`);
  }

  // 204 No Content — valid empty response
  if (res.status === 204) return undefined as unknown as T;

  // Check content-type BEFORE trying to parse body.
  // If Vercel's SPA rewrite returned HTML instead of JSON, catch it here.
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    if (res.ok) {
      // Got 200 but HTML — backend is unreachable, Vercel served index.html
      throw new NetworkError(
        `API at ${API_BASE_URL} returned HTML instead of JSON. ` +
        `Backend is likely unreachable. Set VITE_API_BASE_URL to your deployed backend.`,
      );
    }
    // Non-JSON error (e.g. 502 from proxy)
    throw new ApiError(`HTTP ${res.status} (non-JSON response)`, res.status);
  }

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    const message = (body as { error?: string }).error ?? `HTTP ${res.status}`;
    throw new ApiError(message, res.status, body);
  }

  return body as T;
}

// ── Health check ────────────────────────────────────────

export type ApiHealth = {
  ok: boolean;
  latency_ms: number;
  base_url: string;
  error?: string;
};

export async function checkHealth(): Promise<ApiHealth> {
  const start = Date.now();
  try {
    // Use a lightweight GET that should always return JSON
    await request<unknown[]>("/factories");
    return {
      ok: true,
      latency_ms: Date.now() - start,
      base_url: API_BASE_URL,
    };
  } catch (err) {
    return {
      ok: false,
      latency_ms: Date.now() - start,
      base_url: API_BASE_URL,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}
