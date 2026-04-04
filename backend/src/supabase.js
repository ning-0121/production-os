import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;

if (!url || !key) {
  console.error(
    "❌ SUPABASE_URL / SUPABASE_SERVICE_KEY not set – cannot start.\n" +
    "  Export them before starting the server.",
  );
  process.exit(1);
}

// Service-role client — bypasses RLS, used for backend operations
export const supabaseAdmin = createClient(url, key);

// Alias for backward compatibility
export const supabase = supabaseAdmin;
