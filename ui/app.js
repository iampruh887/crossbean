import { marked } from "https://cdn.jsdelivr.net/npm/marked@12.0.2/+esm";
import { initGraph, loadGraph, resizeGraph, setGraphSource } from "/graph.js";

// ---------------------------------------------------------------- API client
// The adapter is chosen by /config.js: local HTTP engine on desktop,
// Supabase on web. Same interface either way — assigned during boot().
const CONFIG = window.CB_CONFIG || { platform: "desktop" };
let api;
async function loadApi() {
  const mod = await import(CONFIG.platform === "web" ? "/api-supabase.js" : "/api-local.js");
  return mod.createApi(CONFIG);
}

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
const state = { notes: [], currentId: null, currentGroup: "", dirty: false, vaults: [] };

const noteListEl = $("#noteList");
const titleEl = $("#titleInput");
const bodyEl = $("#bodyInput");
const previewEl = $("#preview");
const statusEl = $("#status");
const suggestionsEl = $("#suggestions");
const groupSelect = $("#groupSelect");

// collapsed group headers persist across sessions
const COLLAPSE_KEY = "cb-collapsed-groups";
const UNGROUPED_KEY = "\u0000ungrouped";
const NEW_GROUP = "__new__";
let collapsedGroups = new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "[]"));
function toggleCollapse(key) {
  if (collapsedGroups.has(key)) collapsedGroups.delete(key);
  else collapsedGroups.add(key);
  localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsedGroups]));
  renderNoteList();
}

function setStatus(msg, busy = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("busy", busy);
}

// Surface a fatal boot/setup failure instead of hanging silently on "connecting…".
function fatalError(err) {
  console.error("[crossbean] boot failed:", err);
  const msg = (err && err.message) || String(err);
  const badge = $("#vecBadge");
  if (badge) badge.textContent = "error";
  let banner = document.getElementById("bootError");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "bootError";
    banner.className = "boot-error";
    document.body.appendChild(banner);
  }
  banner.innerHTML = `<b>Couldn't reach the backend.</b> <span class="be-msg"></span><button class="be-x" title="dismiss">✕</button>`;
  banner.querySelector(".be-msg").textContent = msg;
  banner.querySelector(".be-x").onclick = () => banner.remove();
}

// --------------------------------------------------------------- note list UI
async function refreshNotes(selectId) {
  state.notes = await api.notes();
  renderNoteList();
  if (selectId != null) selectNote(selectId);
  else if (state.currentId == null && state.notes.length) selectNote(state.notes[0].id);
}

// A single note row (title, indexed dot, optional similarity, delete button).
function noteItemEl(n) {
  const el = document.createElement("div");
  el.className = "note-item" + (n.id === state.currentId ? " active" : "");
  el.innerHTML = `
    <div class="n-title">
      <span class="n-vec-dot ${n.hasVec ? "" : "off"}" title="${n.hasVec ? "indexed" : "not indexed"}"></span>
      <span class="n-name">${escapeHtml(n.title)}</span>
      ${n.sim != null ? `<span class="sim-badge">${(n.sim * 100).toFixed(0)}%</span>` : ""}
      <button class="n-del" title="Delete note">✕</button>
    </div>
    <div class="n-snip">${escapeHtml(n.snippet || "")}</div>`;
  el.onclick = () => selectNote(n.id);
  el.querySelector(".n-del").onclick = (e) => { e.stopPropagation(); deleteNoteFlow(n.id, n.title); };
  return el;
}

// A collapsible group header. name === null renders the "Ungrouped" section.
function groupHeaderEl(name, count) {
  const key = name ?? UNGROUPED_KEY;
  const collapsed = collapsedGroups.has(key);
  const el = document.createElement("div");
  el.className = "group-header" + (collapsed ? " collapsed" : "");
  el.innerHTML = `
    <span class="grp-caret">▾</span>
    <span class="grp-name">${escapeHtml(name ?? "Ungrouped")}</span>
    <span class="grp-count">${count}</span>`;
  el.onclick = () => toggleCollapse(key);
  return el;
}

function renderNoteList(items) {
  const searching = items != null;
  const list = items || state.notes;
  noteListEl.innerHTML = "";
  if (!list.length) {
    noteListEl.innerHTML = `<div style="padding:20px;color:var(--text-dim);font-size:13px">${searching ? "No results." : "No notes yet."}</div>`;
    renderGroupSelect();
    return;
  }

  // Search results are shown as a flat list (no group headers).
  if (searching) {
    for (const n of list) noteListEl.appendChild(noteItemEl(n));
    renderGroupSelect();
    return;
  }

  // Group notes by folder; keep an "Ungrouped" bucket.
  const groups = new Map();
  const ungrouped = [];
  for (const n of list) {
    if (!n.grp) { ungrouped.push(n); continue; }
    if (!groups.has(n.grp)) groups.set(n.grp, []);
    groups.get(n.grp).push(n);
  }
  const names = [...groups.keys()].sort((a, b) => a.localeCompare(b));

  // No real groups yet → keep the original flat list (unchanged experience).
  if (!names.length) {
    for (const n of ungrouped) noteListEl.appendChild(noteItemEl(n));
    renderGroupSelect();
    return;
  }

  const renderSection = (name, notes) => {
    const key = name ?? UNGROUPED_KEY;
    noteListEl.appendChild(groupHeaderEl(name, notes.length));
    if (!collapsedGroups.has(key)) for (const n of notes) noteListEl.appendChild(noteItemEl(n));
  };
  for (const name of names) renderSection(name, groups.get(name));
  if (ungrouped.length) renderSection(null, ungrouped);
  renderGroupSelect();
}

async function deleteNoteFlow(id, title) {
  if (!confirm(`Delete "${title || "Untitled"}"?\n\nThis can't be undone.`)) return;
  if (state.currentId === id) {
    state.currentId = null; state.currentGroup = ""; state.dirty = false;
    titleEl.value = ""; bodyEl.value = ""; renderPreview(); suggestionsEl.innerHTML = "";
  }
  await api.remove(id);
  await refreshNotes();
}

// ------------------------------------------------------------------- editor
let saveTimer = null;
async function selectNote(id) {
  await flushSave();
  const n = await api.note(id);
  if (!n || n.error) return;
  state.currentId = id;
  state.currentGroup = n.grp || "";
  titleEl.value = n.title === "Untitled" ? "" : n.title;
  bodyEl.value = n.body;
  renderPreview();
  renderNoteList();
  loadSuggestions(id);
}

// Populate the editor's group picker: "No group", existing groups, "New group…".
function renderGroupSelect() {
  const cur = state.currentGroup || "";
  const names = [...new Set(state.notes.map((n) => n.grp).filter(Boolean))];
  if (cur && !names.includes(cur)) names.push(cur);
  names.sort((a, b) => a.localeCompare(b));
  groupSelect.innerHTML = "";
  groupSelect.appendChild(new Option("No group", ""));
  for (const name of names) groupSelect.appendChild(new Option(name, name));
  groupSelect.appendChild(new Option("＋ New group…", NEW_GROUP));
  groupSelect.value = cur;
  groupSelect.disabled = state.currentId == null;
}

async function changeGroup() {
  if (state.currentId == null) return;
  let val = groupSelect.value;
  if (val === NEW_GROUP) {
    const name = (prompt("New group name:") || "").trim();
    if (!name) { groupSelect.value = state.currentGroup || ""; return; }
    val = name;
  }
  state.currentGroup = val;
  state.dirty = true;
  await flushSave();     // persists title + body + group together
  renderNoteList();      // reflect the move (and refresh the picker)
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
  const grp = state.currentGroup || "";
  state.dirty = false;
  await api.update(id, title, body, grp);
  setStatus("saved");
  // re-embed + reindex in the background
  reindex(id, `${title}\n\n${body}`);
  const idx = state.notes.find((n) => n.id === id);
  if (idx) { idx.title = title; idx.snippet = body.slice(0, 120); idx.grp = grp || null; }
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

// --------------------------------------------------------------- images
function insertAtCursor(text) {
  const start = bodyEl.selectionStart ?? bodyEl.value.length;
  const end = bodyEl.selectionEnd ?? bodyEl.value.length;
  bodyEl.value = bodyEl.value.slice(0, start) + text + bodyEl.value.slice(end);
  const pos = start + text.length;
  bodyEl.selectionStart = bodyEl.selectionEnd = pos;
  bodyEl.focus();
  renderPreview();
  scheduleSave();
}

// Upload each image file and drop a markdown reference at the cursor.
async function handleImageFiles(files) {
  const imgs = [...files].filter((f) => f.type.startsWith("image/"));
  if (!imgs.length || state.currentId == null) return;
  for (const f of imgs) {
    try {
      setStatus("uploading image…", true);
      const url = await api.upload(f);
      const alt = (f.name || "image").replace(/\.[a-z0-9]+$/i, "").replace(/[\[\]]/g, "");
      insertAtCursor(`\n![${alt}](${url})\n`);
      setStatus("image added");
      setTimeout(() => setStatus(""), 1200);
    } catch (e) {
      setStatus("image upload failed: " + e.message);
    }
  }
}

// ------------------------------------------------------------- self-update
async function initVersion() {
  try {
    const v = await api.version();
    $("#appVersion").textContent = v.version === "web" ? "" : "v" + v.version;
  } catch { /* offline / non-fatal */ }
}

function showUpdateModal(info) {
  $("#updateText").innerHTML =
    `crossbean <b>${escapeHtml(info.latest)}</b> is available — you have v${escapeHtml(info.current)}.`;
  const notesEl = $("#updateNotes");
  const notes = (info.notes || "").trim();
  notesEl.textContent = notes.length > 600 ? notes.slice(0, 600) + "…" : notes;
  notesEl.style.display = notes ? "block" : "none";
  const modal = $("#updateModal");
  const close = () => { modal.hidden = true; };
  $("#updateClose").onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };
  $("#updateDownload").onclick = () => window.open(info.downloadUrl || info.releaseUrl, "_blank", "noopener");
  $("#updateView").onclick = () => window.open(info.releaseUrl || info.downloadUrl, "_blank", "noopener");
  modal.hidden = false;
}

// manual=true surfaces "up to date" / failure feedback; the boot check is silent.
async function checkForUpdates(manual = false) {
  try {
    if (manual) setStatus("checking for updates…", true);
    const info = await api.updateCheck();
    if (info.updateAvailable) showUpdateModal(info);
    else if (manual) { setStatus(info.error ? "update check failed" : "up to date"); setTimeout(() => setStatus(""), 1600); }
  } catch {
    if (manual) { setStatus("update check failed"); setTimeout(() => setStatus(""), 1600); }
  }
}

// ----------------------------------------------------------- auth (web only)
// Shows the login screen (Clerk's prebuilt sign-in/up UI) and resolves once
// there's a session. Email delivery, verification, MFA etc. are all Clerk's.
async function requireAuth() {
  const screen = $("#authScreen");
  screen.hidden = false;
  await api.mountAuth($("#clerkAuth"));
  screen.hidden = true;
}

// -------------------------------------------------------- vaults (web only)
const NEW_VAULT = "__newv__";

async function loadVaults() {
  const list = await api.vaults();
  const sel = $("#vaultSelect");
  sel.innerHTML = "";
  for (const v of list) sel.appendChild(new Option(v.name + (v.mine ? "" : " (shared)"), v.id));
  sel.appendChild(new Option("＋ New vault…", NEW_VAULT));
  sel.value = api.currentVault() ?? list[0]?.id ?? "";
  state.vaults = list;
}

async function switchVault(id) {
  if (id === NEW_VAULT) {
    const name = (prompt("New vault name:") || "").trim();
    if (!name) { $("#vaultSelect").value = api.currentVault() || ""; return; }
    await api.createVault(name);
    await loadVaults();
  } else {
    await api.setVault(id);
  }
  state.currentId = null; state.currentGroup = ""; state.dirty = false;
  titleEl.value = ""; bodyEl.value = ""; renderPreview(); suggestionsEl.innerHTML = "";
  await refreshNotes();
  indexMissing();
}

async function openShareDialog() {
  const modal = $("#shareModal");
  const errEl = $("#shareError");
  errEl.textContent = "";
  const render = async () => {
    try {
      const members = await api.members();
      const mine = state.vaults?.find((v) => v.id === api.currentVault())?.mine;
      const listEl = $("#memberList");
      listEl.innerHTML = "";
      for (const m of members) {
        const row = document.createElement("div");
        row.className = "member-row";
        row.innerHTML = `
          <span class="member-email">${escapeHtml(m.email)}</span>
          <span class="member-role">${escapeHtml(m.role)}</span>
          ${mine && m.role !== "owner" ? `<button class="btn icon-btn member-remove" title="Remove">✕</button>` : ""}`;
        row.querySelector(".member-remove")?.addEventListener("click", async () => {
          try { await api.removeMember(m.user_id); render(); }
          catch (e) { errEl.textContent = e.message; }
        });
        listEl.appendChild(row);
      }
    } catch (e) { errEl.textContent = e.message; }
  };
  $("#inviteForm").onsubmit = async (e) => {
    e.preventDefault();
    errEl.textContent = "";
    try {
      await api.invite($("#inviteEmail").value.trim(), $("#inviteRole").value);
      $("#inviteEmail").value = "";
      render();
    } catch (err) { errEl.textContent = err.message; }
  };
  $("#shareClose").onclick = () => { modal.hidden = true; };
  modal.onclick = (e) => { if (e.target === modal) modal.hidden = true; };
  await render();
  modal.hidden = false;
}

// --------------------------------------------------------- star-the-repo prompt
const REPO_URL = "https://github.com/iampruh887/crossbean";
const FIRST_RUN_KEY = "cb-first-run";
const STAR_KEY = "cb-star-prompt"; // set once handled → never shown again
const STAR_DELAY = 2 * 24 * 60 * 60 * 1000; // 2 days

// Show a gentle "star us" modal to engaged users, once, a couple days after
// their first launch. Records first-run time on the very first boot.
function maybeShowStarPrompt() {
  if (localStorage.getItem(STAR_KEY)) return;
  const first = Number(localStorage.getItem(FIRST_RUN_KEY));
  if (!first) { localStorage.setItem(FIRST_RUN_KEY, String(Date.now())); return; }
  if (Date.now() - first < STAR_DELAY) return;
  const modal = $("#starModal");
  const done = (why) => { modal.hidden = true; localStorage.setItem(STAR_KEY, why); };
  $("#starClose").onclick = () => done("dismissed");
  $("#starLater").onclick = () => done("dismissed");
  $("#starGo").onclick = () => { window.open(REPO_URL, "_blank", "noopener"); done("starred"); };
  modal.onclick = (e) => { if (e.target === modal) done("dismissed"); };
  modal.hidden = false;
}

// ------------------------------------------------------------------- utils
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ------------------------------------------------------------------- wiring
function wire() {
  $("#newNoteBtn").onclick = async () => {
    await flushSave();
    // new notes inherit the group you're currently viewing
    const { id } = await api.create("Untitled", "", state.currentGroup || "");
    await refreshNotes(id);
    titleEl.focus();
  };
  titleEl.oninput = () => { scheduleSave(); };
  bodyEl.oninput = () => { renderPreview(); scheduleSave(); };

  // grouping
  groupSelect.onchange = changeGroup;

  // image attach: toolbar button, file picker, paste, drag & drop
  $("#attachImgBtn").onclick = () => $("#imgFileInput").click();
  $("#imgFileInput").onchange = (e) => { handleImageFiles(e.target.files); e.target.value = ""; };
  bodyEl.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.items || [])]
      .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter(Boolean);
    if (files.length) { e.preventDefault(); handleImageFiles(files); }
  });
  bodyEl.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types?.includes("Files")) { e.preventDefault(); bodyEl.classList.add("drag-over"); }
  });
  bodyEl.addEventListener("dragleave", () => bodyEl.classList.remove("drag-over"));
  bodyEl.addEventListener("drop", (e) => {
    bodyEl.classList.remove("drag-over");
    if (e.dataTransfer?.files?.length) { e.preventDefault(); handleImageFiles(e.dataTransfer.files); }
  });
  $("#searchBtn").onclick = runSearch;
  $("#checkUpdateBtn").onclick = () => checkForUpdates(true);

  // web-only chrome
  $("#vaultSelect").onchange = (e) => switchVault(e.target.value);
  $("#shareVaultBtn").onclick = openShareDialog;
  $("#signOutBtn").onclick = async () => { await api.signOut(); location.reload(); };
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

  // delete current note with Ctrl+Shift+Backspace (now with a confirmation)
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === "Backspace" && state.currentId != null) {
      e.preventDefault();
      const n = state.notes.find((x) => x.id === state.currentId);
      deleteNoteFlow(state.currentId, n?.title);
    }
  });
  window.addEventListener("resize", resizeGraph);
  window.addEventListener("beforeunload", flushSave);
}

// ------------------------------------------------------------------- boot
async function boot() {
  applyTheme(localStorage.getItem(THEME_KEY) || "paper");
  document.body.dataset.platform = CONFIG.platform;
  api = await loadApi();
  setGraphSource((threshold) => api.graph(threshold));

  if (CONFIG.platform === "web") {
    const session = await api.init();
    if (!session.authed) await requireAuth();
  }

  wire();
  initGraph($("#graphCanvas"), $("#graphEmpty"));
  initEmbedder();

  if (CONFIG.platform === "web") {
    await loadVaults();
    $("#vecBadge").textContent = "cloud: supabase";
  } else {
    const h = await api.health().catch(() => ({ vec: false }));
    $("#vecBadge").textContent = h.vec ? "vector db: sqlite-vec" : "vector db: cosine";
  }

  await refreshNotes();
  if (!state.notes.length) {
    // first run: seed a welcome note (skipped for read-only vault members)
    try {
      const { id } = await api.create("Welcome to crossbean", WELCOME);
      await refreshNotes(id);
    } catch { /* viewer role — fine */ }
  }
  indexMissing(); // embed anything not yet in the vector db (background)
  if (CONFIG.platform === "desktop") {
    initVersion();
    checkForUpdates(false); // silent update check on launch
  }
  maybeShowStarPrompt();
}

const WELCOME = `# Welcome to crossbean

This is a local-first notebook where your notes form a **knowledge graph**.

Two kinds of connections show up in the **Graph** tab:

- **Your links** — type \[[Note Title]] to link notes yourself.
- **AI connections** — every note is embedded into a vector database, and notes with similar *meaning* are linked automatically (cosine similarity).

Try it: make a couple of notes on related topics and watch them connect — even without linking them by hand.

Everything lives on your machine. Notes are mirrored to the \`vault/\` folder as plain markdown.`;

boot().catch(fatalError);
