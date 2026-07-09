// Headless end-to-end test of the loopback API (no webview, fake embeddings).
// Runs against an isolated scratch data dir — never touches your real notes.
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const scratch = join(tmpdir(), `crossbean-test-${process.pid}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
process.env.CROSSBEAN_DATA_DIR = scratch;

// dynamic imports so the env var above is set before paths.ts reads it
const { startServer } = await import("./src/server");
const { EMBED_DIM } = await import("./src/store");

// deterministic pseudo-embedding so "similar text" -> similar vectors
function fakeVec(seed: number): number[] {
  const v = new Array(EMBED_DIM);
  let s = seed;
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) {
    s = (s * 9301 + 49297) % 233280;
    v[i] = (s / 233280) - 0.5;
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < EMBED_DIM; i++) v[i] /= norm;
  return v;
}

const srv = startServer("ui");
const base = `http://127.0.0.1:${srv.port}`;
const j = (r: Response) => r.json();
const post = (p: string, b: any) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(j);
const put = (p: string, b: any) => fetch(base + p, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(j);
const get = (p: string) => fetch(base + p).then(j);

let fail = 0;
const ok = (cond: boolean, msg: string) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) fail++; };

const health = await get("/api/health");
ok(health.ok === true, "health ok, vec=" + health.vec);

// create 3 notes; two share a wikilink, and A/B get near-identical vectors
const a = await post("/api/notes", { title: "Alpha", body: "About cats. See [[Beta]]." });
const b = await post("/api/notes", { title: "Beta", body: "More about cats and kittens." });
const c = await post("/api/notes", { title: "Gamma", body: "Rocket engines and thrust." });
ok(a.id && b.id && c.id, `created notes ${a.id},${b.id},${c.id}`);

// small perturbation so B is genuinely near A (cosine ~0.97), C stays far
function perturb(base: number[], amount: number, seed: number): number[] {
  let s = seed;
  const v = base.map((x) => {
    s = (s * 9301 + 49297) % 233280;
    return x + (s / 233280 - 0.5) * amount;
  });
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return v.map((x) => x / norm);
}
const aVec = fakeVec(100);
await post("/api/embed", { id: a.id, vector: aVec });
await post("/api/embed", { id: b.id, vector: perturb(aVec, 0.25, 7) });
await post("/api/embed", { id: c.id, vector: fakeVec(5000) });

// re-embed an existing note (vec0 has no INSERT OR REPLACE — regression check)
const re = await post("/api/embed", { id: a.id, vector: aVec });
ok(re.ok === true, "re-embedding an existing note succeeds");

const notes = await get("/api/notes");
ok(notes.length === 3, "list has 3 notes");
ok(notes.every((n: any) => n.hasVec), "all notes indexed");

// semantic search near A's vector -> A should rank first
const results = await post("/api/search", { vector: fakeVec(100), k: 3 });
ok(results[0]?.id === a.id, `search top hit is Alpha (got ${results[0]?.title})`);

// graph: user edge Alpha<->Beta must exist
const g = await get("/api/graph?threshold=0.9");
const userEdge = g.edges.find((e: any) => e.type === "user" && ((e.source === a.id && e.target === b.id) || (e.source === b.id && e.target === a.id)));
ok(!!userEdge, "graph has user edge Alpha<->Beta");
ok(g.nodes.length === 3, "graph has 3 nodes");

// suggestions for A should include B (closest vector)
const sug = await get(`/api/suggest/${a.id}`);
ok(sug.some((s: any) => s.id === b.id), "suggestions for Alpha include Beta");

// update note body + verify persisted
await put(`/api/notes/${c.id}`, { title: "Gamma", body: "Updated: propulsion." });
const c2 = await get(`/api/notes/${c.id}`);
ok(c2.body.includes("propulsion"), "update persisted");

// vault files written (inside the scratch data dir)
const { readdirSync } = await import("node:fs");
const files = readdirSync(join(scratch, "vault"));
ok(files.length >= 3, `vault mirrored ${files.length} md files`);

srv.stop(true);
// best-effort cleanup — on Windows the sqlite handle may still hold a lock,
// and the OS temp dir gets purged anyway
try { rmSync(scratch, { recursive: true, force: true }); } catch {}
console.log(fail === 0 ? "\nALL_PASS" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
