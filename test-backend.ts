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

// --- grouping (folders) ---------------------------------------------------
const gA = await post("/api/notes", { title: "Grouped", body: "x", grp: "Work" });
const listG = await get("/api/notes");
ok(listG.find((n: any) => n.id === gA.id)?.grp === "Work", "note created with group");
await put(`/api/notes/${gA.id}`, { title: "Grouped", body: "x", grp: "Personal" });
ok((await get(`/api/notes/${gA.id}`)).grp === "Personal", "group updated on note");
await put(`/api/notes/${gA.id}`, { title: "Grouped", body: "x", grp: "  " });
ok((await get(`/api/notes/${gA.id}`)).grp === null, "blank group clears to null (ungrouped)");

// --- delete ---------------------------------------------------------------
const del = await post("/api/notes", { title: "Temp", body: "bye" });
await fetch(`${base}/api/notes/${del.id}`, { method: "DELETE" });
ok(!(await get("/api/notes")).some((n: any) => n.id === del.id), "deleted note removed from list");

// --- image upload + serve -------------------------------------------------
const up = await fetch(base + "/api/upload", {
  method: "POST",
  headers: { "content-type": "image/png" },
  body: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
}).then(j);
ok(typeof up.url === "string" && up.url.startsWith("/files/"), "upload returns a /files/ url");
const served = await fetch(base + up.url);
ok(
  served.status === 200 && (served.headers.get("content-type") || "").startsWith("image/png"),
  "uploaded image is served back with image mime"
);
const badUp = await fetch(base + "/api/upload", {
  method: "POST",
  headers: { "content-type": "text/plain" },
  body: "not an image",
});
ok(badUp.status === 415, "non-image upload rejected (415)");
const traversal = await fetch(base + "/files/..%2F..%2Fcrossbean.db");
ok(traversal.status === 400 || traversal.status === 404, "path traversal on /files/ blocked");

// --- migration idempotency ------------------------------------------------
const { initStore } = await import("./src/store");
let migOk = true;
try { initStore(); } catch { migOk = false; }
ok(migOk, "re-running initStore (grp migration) is idempotent");

// --- self-update ----------------------------------------------------------
const { isNewer, pickAsset, APP_VERSION } = await import("./src/update");
ok(isNewer("v0.2.0", "0.1.0") === true, "isNewer: v0.2.0 > 0.1.0");
ok(isNewer("0.1.0", "0.1.0") === false, "isNewer: equal is not newer");
ok(isNewer("0.1.9", "0.1.10") === false, "isNewer: 0.1.9 < 0.1.10 (numeric, not lexical)");
ok(isNewer("1.0.0", "0.9.9") === true, "isNewer: major bump wins");
const assets = [
  { name: "crossbean-setup-windows-x64.exe", browser_download_url: "http://x/win.exe" },
  { name: "crossbean-macos-arm64.dmg", browser_download_url: "http://x/mac-arm.dmg" },
  { name: "crossbean_0.2.0_amd64.deb", browser_download_url: "http://x/app.deb" },
];
ok(pickAsset(assets, "win32", "x64") === "http://x/win.exe", "pickAsset: windows -> setup exe");
ok(pickAsset(assets, "darwin", "arm64") === "http://x/mac-arm.dmg", "pickAsset: mac arm -> arm64 dmg");
ok(pickAsset(assets, "linux", "x64") === null, "pickAsset: linux -> null (release page fallback)");

const ver = await get("/api/version");
ok(ver.version === APP_VERSION && typeof ver.repo === "string", "/api/version returns current version + repo");

const upd = await get("/api/update-check");
ok(ver.version === upd.current && typeof upd.updateAvailable === "boolean",
  "/api/update-check returns a stable shape (current + boolean, even offline)");

srv.stop(true);
// best-effort cleanup — on Windows the sqlite handle may still hold a lock,
// and the OS temp dir gets purged anyway
try { rmSync(scratch, { recursive: true, force: true }); } catch {}
console.log(fail === 0 ? "\nALL_PASS" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
