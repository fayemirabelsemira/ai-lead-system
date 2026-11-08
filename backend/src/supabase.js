import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";

// Server-side client using the SECRET key.
// The secret key bypasses Row Level Security, so every query written with
// this client must filter by business explicitly. Never use it in a browser.
export const supabase = createClient(config.supabaseUrl, config.supabaseSecretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
