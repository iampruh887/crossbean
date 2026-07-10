// crossbean web: a thin static host for the shared UI. There is NO application
// server — Clerk handles identity, and data/vectors/storage live in Supabase,
// secured by RLS (see supabase/migrations/). Env (auto-loaded from .env):
//
//   SUPABASE_URL=https://<ref>.supabase.co
//   SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
//   CLERK_PUBLISHABLE_KEY=pk_test_...
//
//   bun run web

import { join, extname } from "node:path";

const UI_DIR = join(import.meta.dir, "..", "ui");
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? "";
const CLERK_KEY = process.env.CLERK_PUBLISHABLE_KEY ?? "";

if (!SUPABASE_URL || !SUPABASE_KEY || !CLERK_KEY) {
  console.error(
    "[web] missing env vars. Required:\n" +
      "      SUPABASE_URL + SUPABASE_PUBLISHABLE_KEY  (Supabase → Settings → API)\n" +
      "      CLERK_PUBLISHABLE_KEY                    (Clerk → API Keys, pk_...)"
  );
  process.exit(1);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// All three values are publishable/public by design — RLS is the security boundary.
const configJs = `window.CB_CONFIG = ${JSON.stringify({
  platform: "web",
  supabaseUrl: SUPABASE_URL,
  supabaseKey: SUPABASE_KEY,
  clerkPublishableKey: CLERK_KEY,
})};`;

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  hostname: process.env.HOST ?? "0.0.0.0",
  async fetch(req) {
    const path = new URL(req.url).pathname;

    if (path === "/config.js") {
      return new Response(configJs, {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      });
    }
    if (path === "/healthz") {
      return new Response("ok");
    }

    const file = path === "/" ? "/index.html" : path;
    const asset = Bun.file(join(UI_DIR, file));
    if (await asset.exists()) {
      return new Response(asset, {
        headers: {
          "content-type": MIME[extname(file)] ?? "application/octet-stream",
          "x-content-type-options": "nosniff",
        },
      });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`[web] crossbean serving shared ui/ on http://${server.hostname}:${server.port}`);
console.log(`[web] backend: ${SUPABASE_URL}`);
