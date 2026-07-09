// Loopback engine for the app. Bound to 127.0.0.1 on an ephemeral port and only
// ever talked to by our own native WebView2 window — it is not a public website.
// Serves the UI assets and a small JSON API over the store/vault/graph modules.

import { join, extname, basename } from "node:path";
import { mkdirSync } from "node:fs";
import { uiDir as defaultUiDir, attachmentsDir } from "./paths";
import {
  initStore,
  isVecEnabled,
  listNotes,
  getNote,
  createNote,
  updateNote,
  deleteNote,
  setUserLinks,
  storeEmbedding,
  knn,
} from "./store";
import { initVault, writeNoteFile, deleteNoteFile, parseWikilinks } from "./vault";
import { buildGraph, suggestFor } from "./graph";
import { APP_VERSION, REPO, checkForUpdate } from "./update";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

// Accepted image upload types -> file extension used on disk.
const EXT_FOR_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};
const MAX_UPLOAD = 15 * 1024 * 1024; // 15 MB

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

// keep the on-disk markdown + user links in sync after a body change
async function syncDerived(id: number, title: string, body: string) {
  setUserLinks(id, parseWikilinks(body));
  await writeNoteFile(id, title, body);
}

export function startServer(uiDir = defaultUiDir) {
  const { vecEnabled } = initStore();
  initVault();
  console.log(`[store] vector backend: ${vecEnabled ? "sqlite-vec (native)" : "JS cosine fallback"}`);

  const server = Bun.serve({
    // Ephemeral port by default; PORT env overrides it for headless preview/tests.
    port: Number(process.env.PORT ?? 0),
    hostname: "127.0.0.1",
    idleTimeout: 240,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      try {
        // ---- API ----
        if (path === "/api/health") {
          return json({ ok: true, vec: isVecEnabled() });
        }

        if (path === "/api/version" && req.method === "GET") {
          return json({ version: APP_VERSION, repo: REPO });
        }

        // check GitHub Releases for a newer version (done here, not in the
        // renderer, to avoid CORS and keep a single User-Agent).
        if (path === "/api/update-check" && req.method === "GET") {
          return json(await checkForUpdate());
        }

        if (path === "/api/notes" && req.method === "GET") {
          return json(listNotes());
        }

        if (path === "/api/notes" && req.method === "POST") {
          const b = (await req.json()) as any;
          const id = createNote(b.title ?? "Untitled", b.body ?? "", b.grp);
          await syncDerived(id, b.title ?? "Untitled", b.body ?? "");
          return json({ id });
        }

        const noteMatch = path.match(/^\/api\/notes\/(\d+)$/);
        if (noteMatch) {
          const id = Number(noteMatch[1]);
          if (req.method === "GET") {
            const n = getNote(id);
            return n ? json(n) : json({ error: "not found" }, 404);
          }
          if (req.method === "PUT") {
            const b = (await req.json()) as any;
            updateNote(id, b.title ?? "Untitled", b.body ?? "", b.grp);
            await syncDerived(id, b.title ?? "Untitled", b.body ?? "");
            return json({ ok: true });
          }
          if (req.method === "DELETE") {
            deleteNote(id);
            deleteNoteFile(id);
            return json({ ok: true });
          }
        }

        // image upload: raw image bytes in the body, content-type sets the kind.
        // Saved under the data dir and served back on /files/.
        if (path === "/api/upload" && req.method === "POST") {
          const ct = (req.headers.get("content-type") ?? "").split(";")[0].trim();
          const ext = EXT_FOR_MIME[ct];
          if (!ext) return json({ error: `unsupported image type: ${ct || "none"}` }, 415);
          const buf = new Uint8Array(await req.arrayBuffer());
          if (buf.byteLength === 0) return json({ error: "empty upload" }, 400);
          if (buf.byteLength > MAX_UPLOAD) return json({ error: "image too large (max 15 MB)" }, 413);
          mkdirSync(attachmentsDir, { recursive: true });
          const name = `${crypto.randomUUID()}.${ext}`;
          await Bun.write(join(attachmentsDir, name), buf);
          return json({ url: `/files/${name}` });
        }

        // serve a previously uploaded image
        if (path.startsWith("/files/")) {
          const name = basename(decodeURIComponent(path.slice("/files/".length)));
          if (!name || name.includes("..") || name.includes("/")) {
            return new Response("bad path", { status: 400 });
          }
          const f = Bun.file(join(attachmentsDir, name));
          if (await f.exists()) {
            return new Response(f, {
              headers: { "content-type": MIME[extname(name)] ?? "application/octet-stream" },
            });
          }
          return new Response("not found", { status: 404 });
        }

        // store an embedding computed in the renderer
        if (path === "/api/embed" && req.method === "POST") {
          const b = (await req.json()) as any;
          storeEmbedding(b.id, b.vector);
          return json({ ok: true });
        }

        // semantic search over a query embedding computed in the renderer
        if (path === "/api/search" && req.method === "POST") {
          const b = (await req.json()) as any;
          const hits = knn(b.vector, b.k ?? 20);
          const byId = new Map(listNotes().map((n) => [n.id, n]));
          return json(
            hits
              .map((h) => ({ ...byId.get(h.id), sim: h.sim }))
              .filter((r) => r.id != null)
          );
        }

        if (path === "/api/graph" && req.method === "GET") {
          const threshold = Number(url.searchParams.get("threshold") ?? "0.3");
          const neighbors = Number(url.searchParams.get("neighbors") ?? "6");
          return json(buildGraph(threshold, neighbors));
        }

        const sugMatch = path.match(/^\/api\/suggest\/(\d+)$/);
        if (sugMatch && req.method === "GET") {
          return json(suggestFor(Number(sugMatch[1])));
        }

        // ---- static UI ----
        let file = path === "/" ? "/index.html" : path;
        const asset = Bun.file(join(uiDir, file));
        if (await asset.exists()) {
          return new Response(asset, {
            headers: { "content-type": MIME[extname(file)] ?? "application/octet-stream" },
          });
        }

        return new Response("not found", { status: 404 });
      } catch (e) {
        console.error("[server]", (e as Error).message);
        return json({ error: (e as Error).message }, 500);
      }
    },
  });

  return server;
}
