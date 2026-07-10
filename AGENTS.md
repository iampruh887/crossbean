# AGENTS.md — working on crossbean

Instructions for AI coding agents (and useful for humans too).

## What this is

crossbean is a **local-first desktop note app** with a knowledge graph. Notes are
markdown; connections between them are either explicit `[[wikilinks]]` (user edges)
or discovered automatically via embedding cosine similarity in a vector database
(AI edges). Runs on **Bun** — Node is not installed and not required.

## Commands

| Task | Command |
|---|---|
| Run the app (dev) | `bun run start` (or `bun run dev` for watch mode) |
| Run tests | `bun run test` — headless API tests, isolated scratch data dir |
| Seed demo notes | `bun run seed` |
| Build release folder | `bun run build:release` → `dist/crossbean-<os>-<arch>/` |
| Package installers | see `packaging/` (per-OS scripts) and `.github/workflows/release.yml` |

## Code map

```
main.ts                  desktop entry: native webview window + engine worker
src/paths.ts             dev vs installed path resolution (resources, data dir)
src/server-worker.ts     runs the HTTP engine on a worker thread
src/server.ts            loopback JSON API + static UI host (Bun.serve)
src/store.ts             sqlite: notes/links/embeddings + sqlite-vec KNN
src/vault.ts             markdown mirror of notes + [[wikilink]] parsing
src/graph.ts             graph builder (user edges + AI similarity edges)
src/update.ts            GitHub-release version check (semver + asset picking)
ui/index.html            single-page UI shell (shared by desktop AND web)
ui/app.js                editor, note list, search, auth/vaults (web), theming
ui/api-local.js          desktop API adapter → loopback HTTP engine
ui/api-supabase.js       web API adapter → supabase-js (auth, pgvector, storage)
ui/graph.js              force-directed canvas graph (custom physics)
ui/embed-worker.js       Transformers.js all-MiniLM-L6-v2 in a Web Worker
ui/styles.css            two themes: "paper" (default) and "terminal"
web/server.ts            web: thin static host for ui/ + /config.js from env
supabase/migrations/     web backend: schema, RLS, RPCs, storage (run in order)
scripts/build-release.ts compile binary + assemble dist folder
packaging/               Inno Setup (.iss), deb/rpm scripts, macOS .app/dmg
test-backend.ts          headless end-to-end API tests
```

## Load-bearing constraints — do not "simplify" these away

1. **Embeddings run in the webview renderer, never in the Bun process.**
   The native `onnxruntime` addon segfaults under Bun on Windows. The renderer
   uses Transformers.js on WebAssembly (`ui/embed-worker.js`), POSTs vectors to
   `/api/embed`. Do not move embedding into `src/`.

2. **The HTTP server must run on a Worker thread** (`src/server-worker.ts`).
   `webview.run()` is a blocking native call on the main thread; a same-thread
   `Bun.serve` deadlocks — the window's requests are never answered.

3. **Worker specifiers must be plain relative strings** (`"./src/server-worker.ts"`).
   `new URL(...).href` percent-encodes the compiled binary's `~BUN` virtual root
   and breaks worker resolution in `bun build --compile` binaries.

4. **`vec0` virtual tables don't support `INSERT OR REPLACE`.**
   Always `DELETE` then `INSERT` (see `storeEmbedding` in `src/store.ts`).

5. **Dev vs installed paths go through `src/paths.ts` only.**
   Dev: everything in the repo. Installed: resources next to the executable,
   user data in the OS data dir (`%APPDATA%`, `~/Library/Application Support`,
   `~/.local/share`). Override with `CROSSBEAN_DATA_DIR`. Never hardcode
   `"ui"` / `"vault"` / `"crossbean.db"` paths elsewhere.

6. **webview-bun reads `WEBVIEW_PATH` at import time** — `main.ts` sets it
   before a *dynamic* `import("webview-bun")`. A static import would hoist
   above the assignment and load the wrong library in installed mode.

7. **The desktop engine binds a STABLE port (47821, fallback ephemeral).**
   The renderer's cached embedding model lives in origin-scoped browser
   storage; a random port per launch changes the origin and re-downloads
   ~30 MB every run. Don't switch back to `port: 0`.

8. **The UI is platform-agnostic; adapters own all I/O.** `/config.js`
   (served by each server) picks `ui/api-local.js` (desktop) or
   `ui/api-supabase.js` (web). Never call `fetch("/api/...")` or supabase-js
   directly from `app.js`/`graph.js` — add it to both adapters instead.
   Web authorization lives in Postgres RLS (`supabase/migrations/0002`),
   never in client JS.

## Conventions

- TypeScript in `src/`, plain JS (ES modules) in `ui/` — the UI is served raw,
  there is no bundler in dev.
- The UI's only external deps load from jsDelivr CDN (`marked`, Transformers.js)
  with the `/+esm` suffix; the model is cached by the OS webview after first run.
- Two UI themes via `:root[data-theme="paper"|"terminal"]` CSS variables.
  Canvas graph colors are read from CSS vars per frame — never hardcode colors
  in `ui/graph.js`.
- Similarity threshold default is **0.30** — all-MiniLM-L6-v2 cosines for
  related-but-distinct notes land around 0.3–0.5. Don't raise it back to
  "intuitive" values like 0.7; nothing will connect.
- Embedding dimension is 384 (`EMBED_DIM`); changing models means a migration.

## Testing

`bun run test` spins the real server against a scratch data dir (via
`CROSSBEAN_DATA_DIR`) with deterministic fake vectors — safe to run anytime,
never touches real notes. Every bug fixed so far has a regression assertion in
`test-backend.ts`; keep that up.

## Release

Native libs (`libwebview`, `vec0`) are per-platform npm packages, so each OS
builds its own artifacts — locally via `bun run build:release` + the script in
`packaging/<os>/`, or all at once by pushing a `v*` tag (CI matrix in
`.github/workflows/release.yml`). Version lives in `package.json` and is
duplicated in `packaging/windows/installer.iss` and the packaging scripts'
`VERSION` defaults — bump all when releasing.
