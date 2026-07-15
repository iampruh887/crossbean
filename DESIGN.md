# crossbean — design document

## Vision

An Obsidian-style personal knowledge base where the graph is not just a picture
of links you typed, but a map of what your notes *mean*. Every note is embedded
into a vector space; notes that talk about the same thing find each other. You
still link by hand when you want to — the two kinds of connection are drawn
side by side and color-coded.

Non-goals (v0.1): plugins, mobile.

## System overview

```
┌──────────────────────────── browser ────────────────────────────────────┐
│  ui/app.js          editor · note list · semantic search · theming      │
│  ui/graph.js        force-directed canvas graph                         │
│  ui/embed-worker    all-MiniLM-L6-v2 on wasm (Transformers.js)          │
│  ui/api-supabase.js data adapter (supabase-js + Clerk JWT)              │
└───────────────▲──────────────────────────────────────────────────────────┘
                │ HTTPS
┌───────────────▼──────────────── Supabase ────────────────────────────────┐
│  Postgres + pgvector    notes · links · embeddings (RLS-secured)         │
│  Storage                attachments                                      │
│  functions/ocr          optional image → text edge function              │
└───────────────────────────────────────────────────────────────────────────┘

Static host: Vercel (production) or web/server.ts (local dev, Bun)
Config: /config.js injects SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY,
        CLERK_PUBLISHABLE_KEY — all publishable; RLS is the security boundary.
```

## Why the responsibilities sit where they do

**Embedding runs in the browser.** Transformers.js on WebAssembly inside
`ui/embed-worker.js` is the reliable, dependency-free path: no server GPU, no
AI keys, no onnxruntime native addon. The browser caches the model (~30 MB)
after the first load. The adapter POSTs the 384-d vector to Supabase; Supabase
owns all persistence.

**Supabase is the source of truth.** Notes, links, embeddings, and attachments
all live in Postgres + pgvector + Storage, protected by Row-Level Security keyed
on the Clerk user id. There is no local file mirror or sqlite database.

## Data model

```sql
-- Supabase Postgres (see supabase/migrations/ for full DDL)
notes      (id, vault_id, title, body, updated)
links      (src, dst)                   -- resolved [[wikilinks]], rebuilt on save
embeddings (note_id, embedding vector(384))  -- pgvector, cosine metric
```

All tables are RLS-secured. The `embedding` column uses pgvector's `<=>` cosine
operator for KNN queries — no separate index rebuild step needed.

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
save note ──▶ adapter.saveNote() ──▶ Supabase Postgres
        └──▶ embed-worker embeds title+body (384-d, normalized)
                     └──▶ adapter.storeEmbedding() ──▶ Supabase pgvector
on load ──▶ indexMissing(): embed any note without a vector
search  ──▶ embed query in browser ──▶ adapter.search() ──▶ KNN via pgvector
```

Model: `Xenova/all-MiniLM-L6-v2`, quantized ONNX (~30 MB), mean-pooled,
normalized. Downloads once on first browser visit; cached by the browser
thereafter. Swapping models = changing `EMBED_DIM` + a Supabase migration +
a re-index.

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

## Deployment model

There are no native libs, no compiled binary, and no per-platform builds.
`vercel.json` points Vercel at `scripts/gen-config.mjs` (buildCommand) which
writes `ui/config.js` from the three publishable env vars; Vercel serves
`ui/` as a static site. Local dev uses `web/server.ts` (Bun) to do the same
thing at runtime. Pushing to `main` triggers a Vercel deploy.

## Rejected alternatives

- **Embedding server-side** — adds a GPU dependency and an AI key to the
  server; the browser WebAssembly path is zero-cost operationally and cached
  after first load.
- **Dedicated vector DB (Qdrant/Chroma)** — a separate server process adds
  operational complexity; pgvector keeps vectors in the same Postgres database
  as the notes, transactionally, with RLS for free.
- **Graph library (d3-force / cytoscape)** — the custom sim is ~200 lines,
  dependency-free, and trivially themeable.

## Future work

- Incremental re-embed (paragraph-level chunks) for long notes
- Backlinks panel; tag support
- Vault import (point at an existing folder of .md)
- Model picker (bge-small, multilingual models) with re-index migration
- Auto-updater for installed builds
