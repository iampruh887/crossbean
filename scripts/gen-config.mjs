// Vercel build step: generate ui/config.js from environment variables.
// The web UI loads /config.js before app.js to pick its adapter + creds.
// All three values are publishable/public by design (RLS is the boundary).
import { writeFileSync } from "node:fs";

const cfg = {
  platform: "web",
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_PUBLISHABLE_KEY,
  clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY,
};

const missing = Object.entries(cfg)
  .filter(([k, v]) => k !== "platform" && !v)
  .map(([k]) => k);
if (missing.length) {
  console.error("gen-config: missing env vars:", missing.join(", "));
  process.exit(1);
}

writeFileSync("ui/config.js", `window.CB_CONFIG = ${JSON.stringify(cfg)};\n`);
console.log("gen-config: wrote ui/config.js for", cfg.supabaseUrl);
