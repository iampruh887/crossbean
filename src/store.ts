// Notes + vector store, backed by bun:sqlite.
// Primary vector search uses the sqlite-vec extension (a real on-disk vector DB).
// If the native extension fails to load, we fall back to brute-force cosine in JS
// over vectors persisted as BLOBs — same storage, same results, just slower.

import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { bundledLib, dbPath, libSuffix } from "./paths";

export const EMBED_DIM = 384; // all-MiniLM-L6-v2

// Load the sqlite-vec extension: from a lib shipped next to the executable
// (installed mode), else via the npm platform package (dev mode — its
// import.meta.resolve lookup only works with node_modules present).
function loadVec(database: Database) {
  const local = bundledLib(`vec0.${libSuffix}`);
  if (local) database.loadExtension(local);
  else sqliteVec.load(database);
}

export interface NoteMeta {
  id: number;
  title: string;
  updated: number;
  snippet: string;
  hasVec: boolean;
}
export interface Note extends NoteMeta {
  body: string;
}

let db: Database;
let vecEnabled = false;

export function initStore(path = dbPath): { vecEnabled: boolean } {
  db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      title   TEXT NOT NULL DEFAULT 'Untitled',
      body    TEXT NOT NULL DEFAULT '',
      updated INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS links (
      src INTEGER NOT NULL,
      dst INTEGER NOT NULL,
      PRIMARY KEY (src, dst)
    );
    -- Fallback vector storage (always written, so we can rebuild the vec index).
    CREATE TABLE IF NOT EXISTS embeddings (
      note_id INTEGER PRIMARY KEY,
      dim     INTEGER NOT NULL,
      data    BLOB NOT NULL
    );
  `);

  try {
    loadVec(db);
    db.query("SELECT vec_version()").get();
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS vec_notes USING vec0(embedding float[${EMBED_DIM}] distance_metric=cosine)`
    );
    vecEnabled = true;
    // Re-sync the vec index from durable BLOB storage (covers a prior fallback
    // run). vec0 tables don't support INSERT OR REPLACE, so only add missing.
    const have = new Set(
      (db.query("SELECT rowid FROM vec_notes").all() as any[]).map((r) => r.rowid)
    );
    const rows = db.query("SELECT note_id, data FROM embeddings").all() as any[];
    for (const r of rows) {
      if (have.has(r.note_id)) continue;
      db.query("INSERT INTO vec_notes(rowid, embedding) VALUES (?, ?)").run(r.note_id, r.data);
    }
  } catch (e) {
    vecEnabled = false;
    console.error("[store] sqlite-vec unavailable, using JS cosine fallback:", (e as Error).message);
  }

  return { vecEnabled };
}

export function isVecEnabled() {
  return vecEnabled;
}

const snippetOf = (body: string) =>
  body.replace(/[#*_`>\-\[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);

export function listNotes(): NoteMeta[] {
  const rows = db
    .query(
      `SELECT n.id, n.title, n.body, n.updated,
              (SELECT 1 FROM embeddings e WHERE e.note_id = n.id) AS hv
       FROM notes n ORDER BY n.updated DESC`
    )
    .all() as any[];
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    updated: r.updated,
    snippet: snippetOf(r.body),
    hasVec: !!r.hv,
  }));
}

export function getNote(id: number): Note | null {
  const r = db.query("SELECT id, title, body, updated FROM notes WHERE id = ?").get(id) as any;
  if (!r) return null;
  const hv = db.query("SELECT 1 FROM embeddings WHERE note_id = ?").get(id);
  return { id: r.id, title: r.title, body: r.body, updated: r.updated, snippet: snippetOf(r.body), hasVec: !!hv };
}

export function createNote(title: string, body: string): number {
  const now = Date.now();
  const info = db
    .query("INSERT INTO notes(title, body, updated) VALUES (?, ?, ?)")
    .run(title || "Untitled", body || "", now);
  return Number(info.lastInsertRowid);
}

export function updateNote(id: number, title: string, body: string): void {
  db.query("UPDATE notes SET title = ?, body = ?, updated = ? WHERE id = ?").run(
    title || "Untitled",
    body || "",
    Date.now(),
    id
  );
}

export function deleteNote(id: number): void {
  db.query("DELETE FROM notes WHERE id = ?").run(id);
  db.query("DELETE FROM links WHERE src = ? OR dst = ?").run(id, id);
  db.query("DELETE FROM embeddings WHERE note_id = ?").run(id);
  if (vecEnabled) db.query("DELETE FROM vec_notes WHERE rowid = ?").run(id);
}

// --- user links (parsed from [[wikilinks]]) -------------------------------

export function resolveTitle(title: string): number | null {
  const r = db
    .query("SELECT id FROM notes WHERE lower(title) = lower(?) ORDER BY id LIMIT 1")
    .get(title.trim()) as any;
  return r ? r.id : null;
}

export function setUserLinks(srcId: number, targetTitles: string[]): void {
  db.query("DELETE FROM links WHERE src = ?").run(srcId);
  const seen = new Set<number>();
  for (const t of targetTitles) {
    const dst = resolveTitle(t);
    if (dst && dst !== srcId && !seen.has(dst)) {
      seen.add(dst);
      db.query("INSERT OR IGNORE INTO links(src, dst) VALUES (?, ?)").run(srcId, dst);
    }
  }
}

export function userEdges(): { src: number; dst: number }[] {
  return db.query("SELECT src, dst FROM links").all() as any[];
}

// All notes with bodies, so wikilinks can be resolved live (independent of the
// order notes were created in).
export function notesWithBodies(): { id: number; title: string; body: string }[] {
  return db.query("SELECT id, title, body FROM notes").all() as any[];
}

// --- embeddings -----------------------------------------------------------

function toBlob(vec: number[] | Float32Array): Uint8Array {
  const f = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
}

export function storeEmbedding(noteId: number, vec: number[]): void {
  if (vec.length !== EMBED_DIM) throw new Error(`expected ${EMBED_DIM} dims, got ${vec.length}`);
  const blob = toBlob(vec);
  db.query("INSERT OR REPLACE INTO embeddings(note_id, dim, data) VALUES (?, ?, ?)").run(
    noteId,
    EMBED_DIM,
    blob
  );
  if (vecEnabled) {
    // vec0 doesn't support INSERT OR REPLACE — delete then insert.
    db.query("DELETE FROM vec_notes WHERE rowid = ?").run(noteId);
    db.query("INSERT INTO vec_notes(rowid, embedding) VALUES (?, ?)").run(noteId, blob);
  }
}

function readVec(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
}

export interface Hit {
  id: number;
  sim: number;
}

// k nearest notes to a query vector. Returns cosine similarity in [-1,1].
export function knn(vec: number[], k: number, excludeId?: number): Hit[] {
  if (vecEnabled) {
    const blob = toBlob(vec);
    const rows = db
      .query(
        `SELECT rowid AS id, distance FROM vec_notes
         WHERE embedding MATCH ? AND k = ?
         ORDER BY distance`
      )
      .all(blob, k + (excludeId != null ? 1 : 0)) as any[];
    return rows
      .filter((r) => r.id !== excludeId)
      .slice(0, k)
      .map((r) => ({ id: r.id, sim: 1 - r.distance })); // cosine distance -> similarity
  }
  // fallback: brute-force cosine over all stored vectors
  const q = Float32Array.from(vec);
  const rows = db.query("SELECT note_id, data FROM embeddings").all() as any[];
  const hits: Hit[] = [];
  for (const r of rows) {
    if (r.note_id === excludeId) continue;
    hits.push({ id: r.note_id, sim: cosine(q, readVec(r.data)) });
  }
  hits.sort((a, b) => b.sim - a.sim);
  return hits.slice(0, k);
}

export function embeddedIds(): number[] {
  return (db.query("SELECT note_id FROM embeddings").all() as any[]).map((r) => r.note_id);
}

export function getEmbedding(noteId: number): Float32Array | null {
  const r = db.query("SELECT data FROM embeddings WHERE note_id = ?").get(noteId) as any;
  return r ? readVec(r.data) : null;
}
