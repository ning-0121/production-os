import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;

if (!url || !key) {
  console.warn(
    "⚠ SUPABASE_URL / SUPABASE_SERVICE_KEY not set – DB calls will fail.\n" +
    "  Export them before starting the server.",
  );
}

export const supabase = createClient(url ?? "", key ?? "");
