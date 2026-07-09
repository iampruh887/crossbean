import { marked } from "https://cdn.jsdelivr.net/npm/marked@12.0.2/+esm";
import { initGraph, loadGraph, resizeGraph } from "/graph.js";

// ---------------------------------------------------------------- API client
const api = {
  async notes() { return (await fetch("/api/notes")).json(); },
  async note(id) { return (await fetch(`/api/notes/${id}`)).json(); },
  async create(title, body) {
    return (await fetch("/api/notes", { method: "POST", headers: json(), body: JSON.stringify({ title, body }) })).json();
  },
  async update(id, title, body) {
    return (await fetch(`/api/notes/${id}`, { method: "PUT", headers: json(), body: JSON.stringify({ title, body }) })).json();
  },
  async remove(id) { return (await fetch(`/api/notes/${id}`, { method: "DELETE" })).json(); },
  async storeEmbed(id, vector) {
    return (await fetch("/api/embed", { method: "POST", headers: json(), body: JSON.stringify({ id, vector }) })).json();
  },
  async search(vector, k = 20) {
    return (await fetch("/api/search", { method: "POST", headers: json(), body: JSON.stringify({ vector, k }) })).json();
  },
  async suggest(id) { return (await fetch(`/api/suggest/${id}`)).json(); },
  async health() { return (await fetch("/api/health")).json(); },
};
const json = () => ({ "content-type": "application/json" });

// ------------------------------------------------------------ embedding client
let worker, reqId = 0, modelReady = false;
const pending = new Map();
function initEmbedder() {
  worker = new Worker("/embed-worker.js", { type: "module" });
  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === "loading") setStatus(`downloading model… ${m.progress}%`, true);
    else if (m.type === "ready") { modelReady = true; setStatus("model ready"); setTimeout(() => setStatus(""), 1500); }
    else if (m.type === "vector") { pending.get(m.id)?.resolve(m.vector); pending.delete(m.id); }
    else if (m.type === "error") { pending.get(m.id)?.reject(new Error(m.error)); pending.delete(m.id); setStatus("embed error: " + m.error); }
  };
  worker.postMessage({ type: "warmup" });
}
function embed(text) {
  return new Promise((resolve, reject) => {
    const id = ++reqId;
    pending.set(id, { resolve, reject });
    worker.postMessage({ type: "embed", id, text });
  });
}

// ------------------------------------------------------------------- state/dom
const $ = (s) => document.querySelector(s);
const state = { notes: [], currentId: null, dirty: false };

const noteListEl = $("#noteList");
const titleEl = $("#titleInput");
const bodyEl = $("#bodyInput");
const previewEl = $("#preview");
const statusEl = $("#status");
const suggestionsEl = $("#suggestions");

function setStatus(msg, busy = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("busy", busy);
}

// --------------------------------------------------------------- note list UI
async function refreshNotes(selectId) {
  state.notes = await api.notes();
  renderNoteList();
  if (selectId != null) selectNote(selectId);
  else if (state.currentId == null && state.notes.length) selectNote(state.notes[0].id);
}

function renderNoteList(items) {
  const list = items || state.notes;
  noteListEl.innerHTML = "";
  if (!list.length) {
    noteListEl.innerHTML = `<div style="padding:20px;color:var(--text-dim);font-size:13px">No notes yet.</div>`;
    return;
  }
  for (const n of list) {
    const el = document.createElement("div");
    el.className = "note-item" + (n.id === state.currentId ? " active" : "");
    el.innerHTML = `
      <div class="n-title">
        <span class="n-vec-dot ${n.hasVec ? "" : "off"}" title="${n.hasVec ? "indexed" : "not indexed"}"></span>
        <span>${escapeHtml(n.title)}</span>
        ${n.sim != null ? `<span class="sim-badge">${(n.sim * 100).toFixed(0)}%</span>` : ""}
      </div>
      <div class="n-snip">${escapeHtml(n.snippet || "")}</div>`;
    el.onclick = () => selectNote(n.id);
    noteListEl.appendChild(el);
  }
}

// ------------------------------------------------------------------- editor
let saveTimer = null;
async function selectNote(id) {
  await flushSave();
  const n = await api.note(id);
  if (!n || n.error) return;
  state.currentId = id;
  titleEl.value = n.title === "Untitled" ? "" : n.title;
  bodyEl.value = n.body;
  renderPreview();
  renderNoteList();
  loadSuggestions(id);
}

function renderPreview() {
  const raw = bodyEl.value || "";
  const withLinks = raw.replace(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g, (_, t) => `[${t}](wikilink:${encodeURIComponent(t.trim())})`);
  previewEl.innerHTML = marked.parse(withLinks, { breaks: true });
  previewEl.querySelectorAll('a[href^="wikilink:"]').forEach((a) => {
    a.classList.add("wikilink");
    a.onclick = (e) => {
      e.preventDefault();
      const title = decodeURIComponent(a.getAttribute("href").slice("wikilink:".length));
      const target = state.notes.find((x) => x.title.toLowerCase() === title.toLowerCase());
      if (target) selectNote(target.id);
    };
  });
}

function scheduleSave() {
  state.dirty = true;
  setStatus("editing…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 700);
}

async function flushSave() {
  clearTimeout(saveTimer);
  if (!state.dirty || state.currentId == null) return;
  const id = state.currentId;
  const title = titleEl.value.trim() || "Untitled";
  const body = bodyEl.value;
  state.dirty = false;
  await api.update(id, title, body);
  setStatus("saved");
  // re-embed + reindex in the background
  reindex(id, `${title}\n\n${body}`);
  const idx = state.notes.find((n) => n.id === id);
  if (idx) { idx.title = title; idx.snippet = body.slice(0, 120); }
  renderNoteList();
}

// Embed any notes that don't yet have a vector (e.g. imported, or created
// before the model was ready). Runs quietly in the background on boot.
async function indexMissing() {
  const missing = state.notes.filter((n) => !n.hasVec).map((n) => n.id);
  for (const id of missing) {
    const n = await api.note(id);
    if (!n || n.error) continue;
    await reindex(id, `${n.title}\n\n${n.body}`);
  }
}

async function reindex(id, text) {
  try {
    setStatus("indexing…", true);
    const vector = await embed(text);
    await api.storeEmbed(id, vector);
    setStatus("indexed");
    setTimeout(() => setStatus(""), 1200);
    const n = state.notes.find((x) => x.id === id);
    if (n) n.hasVec = true;
    renderNoteList();
    if (state.currentId === id) loadSuggestions(id);
  } catch (e) {
    setStatus("index failed: " + e.message);
  }
}

// --------------------------------------------------------------- suggestions
async function loadSuggestions(id) {
  const sug = await api.suggest(id);
  suggestionsEl.innerHTML = "";
  if (!sug.length) return;
  const label = document.createElement("span");
  label.className = "sg-label";
  label.textContent = "Related";
  suggestionsEl.appendChild(label);
  for (const s of sug.slice(0, 6)) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.innerHTML = `${escapeHtml(s.title)} <span class="chip-sim">${(s.sim * 100).toFixed(0)}%</span>`;
    chip.title = "Open note";
    chip.onclick = () => selectNote(s.id);
    suggestionsEl.appendChild(chip);
  }
}

// ------------------------------------------------------------------- search
async function runSearch() {
  const q = $("#searchInput").value.trim();
  if (!q) { renderNoteList(); return; }
  setStatus("searching…", true);
  try {
    const vector = await embed(q);
    const hits = await api.search(vector, 30);
    renderNoteList(hits);
    setStatus(`${hits.length} results`);
  } catch (e) {
    setStatus("search failed: " + e.message);
  }
}

// ------------------------------------------------------------------- theme
const THEME_KEY = "cb-theme";
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem(THEME_KEY, t);
  $("#themeBtn").textContent = t === "paper" ? "> terminal" : "¶ paper";
}
function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === "paper" ? "terminal" : "paper");
}

// -------------------------------------------------------------------- tabs
function switchView(view) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  $("#editorView").classList.toggle("active", view === "editor");
  $("#graphView").classList.toggle("active", view === "graph");
  if (view === "graph") {
    resizeGraph();
    loadGraph(Number($("#threshold").value), (id) => { switchView("editor"); selectNote(id); });
  }
}

// ------------------------------------------------------------------- utils
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ------------------------------------------------------------------- wiring
function wire() {
  $("#newNoteBtn").onclick = async () => {
    await flushSave();
    const { id } = await api.create("Untitled", "");
    await refreshNotes(id);
    titleEl.focus();
  };
  titleEl.oninput = () => { scheduleSave(); };
  bodyEl.oninput = () => { renderPreview(); scheduleSave(); };
  $("#searchBtn").onclick = runSearch;
  $("#searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch();
    if (e.key === "Escape") { e.target.value = ""; renderNoteList(); }
  });
  document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => switchView(t.dataset.view)));
  $("#themeBtn").onclick = toggleTheme;
  $("#threshold").addEventListener("input", (e) => {
    $("#thVal").textContent = Number(e.target.value).toFixed(2);
    loadGraph(Number(e.target.value), (id) => { switchView("editor"); selectNote(id); });
  });
  $("#refreshGraph").onclick = () => loadGraph(Number($("#threshold").value), (id) => { switchView("editor"); selectNote(id); });

  // delete current note with Ctrl+Shift+Backspace
  document.addEventListener("keydown", async (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === "Backspace" && state.currentId != null) {
      const id = state.currentId;
      state.currentId = null; state.dirty = false;
      await api.remove(id);
      await refreshNotes();
    }
  });
  window.addEventListener("resize", resizeGraph);
  window.addEventListener("beforeunload", flushSave);
}

// ------------------------------------------------------------------- boot
async function boot() {
  applyTheme(localStorage.getItem(THEME_KEY) || "paper");
  wire();
  initGraph($("#graphCanvas"), $("#graphEmpty"));
  initEmbedder();
  const h = await api.health().catch(() => ({ vec: false }));
  $("#vecBadge").textContent = h.vec ? "vector db: sqlite-vec" : "vector db: cosine";
  await refreshNotes();
  if (!state.notes.length) {
    const { id } = await api.create("Welcome to crossbean", WELCOME);
    await refreshNotes(id);
  }
  indexMissing(); // embed anything not yet in the vector db (background)
}

const WELCOME = `# Welcome to crossbean

This is a local-first notebook where your notes form a **knowledge graph**.

Two kinds of connections show up in the **Graph** tab:

- **Your links** — type \[[Note Title]] to link notes yourself.
- **AI connections** — every note is embedded into a vector database, and notes with similar *meaning* are linked automatically (cosine similarity).

Try it: make a couple of notes on related topics and watch them connect — even without linking them by hand.

Everything lives on your machine. Notes are mirrored to the \`vault/\` folder as plain markdown.`;

boot();
