/**
 * Supabase Auth Service
 *
 * Handles authentication state, login, logout, and session management.
 * Exports the supabase client for use by other services (Realtime, Storage).
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? "";

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn("[Auth] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY not set");
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Auth functions ──────────────────────────────────────

export async function login(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  return data;
}

export async function logout() {
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error(error.message);
}

export async function getSession() {
  const { data: { session } } = await supabase.auth.getSession();
  return session;
}

export function getAccessToken(): string | null {
  // Synchronous access to cached session (set after getSession or onAuthStateChange)
  return _cachedToken;
}

let _cachedToken: string | null = null;

// Initialize token from existing session
getSession().then((session) => {
  _cachedToken = session?.access_token ?? null;
});

// Keep token in sync with auth state changes
supabase.auth.onAuthStateChange((_event, session) => {
  _cachedToken = session?.access_token ?? null;
});

export type AuthUser = {
  id: string;
  email: string;
  role: string;
  name: string;
};

export function parseUser(session: { user: { id: string; email?: string; user_metadata?: Record<string, unknown> } }): AuthUser {
  const u = session.user;
  return {
    id: u.id,
    email: u.email ?? "",
    role: (u.user_metadata?.role as string) ?? "operator",
    name: (u.user_metadata?.name as string) ?? u.email?.split("@")[0] ?? "user",
  };
}
