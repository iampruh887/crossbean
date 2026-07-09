# crossbean — design document

## Vision

An Obsidian-style personal knowledge base where the graph is not just a picture
of links you typed, but a map of what your notes *mean*. Every note is embedded
into a vector space; notes that talk about the same thing find each other. You
still link by hand when you want to — the two kinds of connection are drawn
side by side and color-coded.

Non-goals (v0.1): sync, collaboration, plugins, mobile.

## System overview

```
┌────────────────────── native window (OS webview) ───────────────────────┐
│  ui/app.js        editor · note list · semantic search · theming        │
│  ui/graph.js      force-directed canvas graph                           │
│  ui/embed-worker  all-MiniLM-L6-v2 on wasm (Transformers.js)            │
└───────────────▲──────────────────────────────────────────────────────────┘
                │ http (loopback only, ephemeral port)
┌───────────────▼─────────────── bun process ──────────────────────────────┐
│  main thread      webview.run() — blocking native event loop             │
│  worker thread    Bun.serve engine                                       │
│                   ├─ src/store.ts   sqlite + sqlite-vec (vector KNN)     │
│                   ├─ src/graph.ts   edge derivation (user + AI)          │
│                   └─ src/vault.ts   vault/*.md mirror + wikilink parse   │
└───────────────────────────────────────────────────────────────────────────┘
```

The window is a native OS webview (WebView2 / WebKitGTK / WKWebView) — not
Electron, not a browser tab. The engine binds `127.0.0.1` on an ephemeral port
and is only ever connected to by the app's own window.

## Why the responsibilities sit where they do

**Embedding runs in the renderer.** The natural place — next to the database —
doesn't work: onnxruntime's native addon segfaults under Bun on Windows.
Transformers.js on WebAssembly inside the webview is the reliable path, and it
gives model caching (the OS webview's HTTP cache) for free. The renderer embeds
text and POSTs the vector to the engine; the engine owns all persistence.

**The engine runs on a worker thread.** `webview.run()` blocks the main thread's
event loop for the lifetime of the window. A same-thread `Bun.serve` accepts the
socket but never runs its handler — the window white-screens waiting on a
response that can't be scheduled. Discovered the hard way; see AGENTS.md for the
other landmines.

**SQLite is the source of truth; markdown is an export.** `vault/*.md` is
regenerated on every save so the data outlives the app (openable in Obsidian or
any editor), but the app never reads it back — no two-way sync conflicts.

## Data model

```sql
notes      (id, title, body, updated)
links      (src, dst)                  -- resolved [[wikilinks]], rebuilt on save
embeddings (note_id, dim, data BLOB)   -- durable float32 vectors
vec_notes  vec0(embedding float[384])  -- sqlite-vec index, cosine metric
```

`embeddings` (plain table) is the durable copy; `vec_notes` (virtual table) is
the fast index, rebuilt from `embeddings` at startup if missing. This means a
build of the app without the native extension still works — `knn()` falls back
to brute-force cosine over the BLOBs — and the index can always be regenerated.

## The graph

Nodes are notes. Two edge sets:

- **User edges** — `[[wikilinks]]` re-resolved live at graph-build time (not at
  save time), so links connect regardless of note creation order.
- **AI edges** — for each embedded note, KNN over the vector index; pairs above
  the similarity threshold (default **0.30**) get an edge weighted by cosine.
  An AI edge is suppressed when a user edge already connects the pair.

Threshold calibration matters: all-MiniLM-L6-v2 produces modest cosines
(~0.3–0.5) for related-but-distinct prose. The UI exposes a live slider
(0.15–0.6) because the right value depends on how homogeneous a vault is.

Rendering is a custom ~200-line force simulation (repulsion + springs +
centering) on a 2D canvas — no graph library. User edges are drawn stronger and
pull harder than AI edges. Colors are read from the active theme's CSS
variables every frame, so the graph restyles instantly on theme toggle.

## Embedding pipeline

```
save note ──▶ /api/notes PUT ──▶ sqlite + vault mirror
        └──▶ renderer worker embeds title+body (384-d, normalized)
                     └──▶ /api/embed POST ──▶ embeddings + vec_notes
boot ──▶ indexMissing(): embed any note without a vector
search ──▶ embed query in renderer ──▶ /api/search ──▶ KNN over vec_notes
```

Model: `Xenova/all-MiniLM-L6-v2`, quantized ONNX (~30 MB), mean-pooled,
normalized. Downloads once on first launch; cached by the webview thereafter
(offline after that). Swapping models = changing `EMBED_DIM` + a re-index.

## Theming

Two complete themes as CSS variable sets on `:root[data-theme=…]`:

| | paper (default) | terminal |
|---|---|---|
| Surface | warm off-white `#faf8f2` | near-black `#0c0e0c` |
| Content type | Georgia serif | monospace |
| User edges | ink `#1a1812` | amber `#d9a94d` |
| AI edges | sepia `#a06b2e` | green `#5db35d` |
| Radius | 4px | 0 |

Choice persists in `localStorage`. Everything themable — including the canvas —
derives from the variables; no theme logic lives in components.

## Packaging model

`bun build --compile` produces a single self-contained binary (bun runtime +
bundled TS, including the server worker as a second entrypoint). Two native
libraries ship next to it: `libwebview` and sqlite-vec's `vec0`. `src/paths.ts`
switches the app between repo layout (dev) and executable-relative resources +
OS-conventional data dir (installed).

Because native libs are per-platform npm packages, each OS builds its own
artifacts; `.github/workflows/release.yml` runs the matrix (Windows exe/installer,
deb + rpm + tarball, macOS dmg for arm64 and x64) on a `v*` tag.

## Rejected alternatives

- **Electron / Tauri** — Electron: 200 MB+ of Chromium per app and Node
  (unavailable here); Tauri: needs a Rust toolchain. The OS webview + bun gets
  the same result with two native libs.
- **Embedding in the bun process** — segfaults (above). Also considered a
  Python sidecar: heavy, second runtime to install.
- **Dedicated vector DB (Qdrant/Chroma)** — a server process for a
  single-user desktop app is operational overkill; sqlite-vec keeps vectors in
  the same file as the notes, transactionally.
- **Graph library (d3-force / cytoscape)** — the custom sim is ~200 lines,
  dependency-free, and trivially themeable.

## Future work

- Incremental re-embed (paragraph-level chunks) for long notes
- Backlinks panel; tag support
- Vault import (point at an existing folder of .md)
- Model picker (bge-small, multilingual models) with re-index migration
- Auto-updater for installed builds
