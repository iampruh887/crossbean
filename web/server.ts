// crossbean web: a thin static host for the shared UI, configured for the
// Supabase backend. There is NO application server — auth, data, vectors and
// storage all live in Supabase, secured by RLS (see supabase/migrations/).
//
//   SUPABASE_URL=https://<ref>.supabase.co \
//   SUPABASE_PUBLISHABLE_KEY=sb_publishable_... \
//   bun run web/server.ts

import { join, extname } from "node:path";

const UI_DIR = join(import.meta.dir, "..", "ui");
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? "";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    "[web] missing SUPABASE_URL and/or SUPABASE_PUBLISHABLE_KEY env vars.\n" +
      "      Find both in your Supabase dashboard under Settings → API."
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

const configJs = `window.CB_CONFIG = ${JSON.stringify({
  platform: "web",
  supabaseUrl: SUPABASE_URL,
  supabaseKey: SUPABASE_KEY, // publishable key — safe to expose, RLS is the security boundary
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
