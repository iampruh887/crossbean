<div align="center">

<img src="assets/icon.svg" width="96" alt="crossbean icon" />

# crossbean

**Notes that find each other.**

A web notebook where your notes form a knowledge graph —
linked by hand with `[[wikilinks]]`, and by *meaning* with a vector database.

[![runtime: bun](https://img.shields.io/badge/runtime-bun-f9f1e1?logo=bun&logoColor=black)](https://bun.sh)
[![data: supabase](https://img.shields.io/badge/data-supabase-3fcf8e?logo=supabase&logoColor=white)](https://supabase.com)
[![auth: clerk](https://img.shields.io/badge/auth-clerk-6c47ff)](https://clerk.com)
[![embeddings: MiniLM](https://img.shields.io/badge/embeddings-all--MiniLM--L6--v2-ffcc4d)](https://huggingface.co/Xenova/all-MiniLM-L6-v2)
[![license: MIT](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE)

</div>

---

## Why

Obsidian's graph shows the links you *remembered* to make. crossbean also shows
the ones you didn't: every note is embedded into a vector space, and notes that
mean similar things connect automatically.

- **Write markdown** in a split editor with live preview
- **Link by hand** — `[[Note Title]]`, rendered as ink-blue edges
- **Linked by meaning** — cosine-similar notes connect as AI edges, with a
  live threshold slider
- **Semantic search** — find notes by what they're about, not keywords
- **Force-directed graph** — drag, zoom, click through your notes
- **Two personalities** — *paper & ink* (serif, warm, quiet) and
  *terminal* (mono, dark, dense), one click apart

## How it works

```
browser
  ui/app.js          editor · graph · search · auth
  ui/embed-worker.js all-MiniLM-L6-v2 (wasm, Web Worker)
  ui/api-supabase.js data adapter (supabase-js + Clerk JWT)

Supabase (Postgres + pgvector + storage)
  notes · links · embeddings   secured by Row-Level Security
  supabase/functions/ocr/      optional image→text edge function

Vercel / local Bun host
  static files from ui/        no application server
  /config.js                   injects the three publishable keys
```

Notes are stored in Supabase Postgres. Embeddings (384-d vectors) are computed
in your browser by Transformers.js — no server-side GPU or AI keys needed. The
model (~30 MB) downloads once and is cached by your browser.

## Run it

```sh
# requires bun — https://bun.sh
git clone <this repo> && cd crossbean

# put your keys in .env (see web/README.md for how to get them)
echo 'SUPABASE_URL=https://<ref>.supabase.co' >> .env
echo 'SUPABASE_PUBLISHABLE_KEY=sb_publishable_...' >> .env
echo 'CLERK_PUBLISHABLE_KEY=pk_test_...' >> .env

bun run start        # http://localhost:3000
```

Full setup guide (Supabase migrations, Clerk, OCR): **[web/README.md](web/README.md)**.

## Use it

| Action | How |
|---|---|
| New note | **+ New note**, write markdown |
| Link notes | type `[[Some Note Title]]` |
| See the graph | **Graph** tab — drag nodes, scroll to zoom, click to open |
| Tune AI edges | the similarity slider (default 0.30) |
| Search by meaning | sidebar search box, <kbd>Enter</kbd> |
| Related notes | chips under the editor, ranked by similarity |
| Switch theme | `> terminal` / `¶ paper` button, top right |
| Group notes | the folder picker above the editor |
| Add images | paste, drag-drop, or the image button |
| Delete note | hover a note in the sidebar → ✕ |

## Deploy

Vercel git integration — push to `main`. Set the three env vars
(`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `CLERK_PUBLISHABLE_KEY`) in your
Vercel project settings. The `vercel.json` build command (`node scripts/gen-config.mjs`)
generates `ui/config.js` from them; Vercel serves the `ui/` directory as static files.

## Stack

| Concern | Choice |
|---|---|
| Static host (local) | [Bun](https://bun.sh) — `web/server.ts` |
| Static host (prod) | [Vercel](https://vercel.com) |
| Identity | [Clerk](https://clerk.com) |
| Data + vectors + storage | [Supabase](https://supabase.com) (Postgres + pgvector) |
| Embeddings | [Transformers.js](https://huggingface.co/docs/transformers.js) · `Xenova/all-MiniLM-L6-v2` (in-browser, WebAssembly) |
| Markdown | [marked](https://marked.js.org) |
| Graph | hand-rolled force simulation on `<canvas>` (~200 lines, zero deps) |

## License

[MIT](LICENSE)
