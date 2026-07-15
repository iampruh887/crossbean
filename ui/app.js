import { marked } from "https://cdn.jsdelivr.net/npm/marked@12.0.2/+esm";
import { initGraph, loadGraph, resizeGraph, setGraphSource, stopGraph, focusNode, clearFocus, edgeBetween } from "/graph.js";
import { splitSentences, buildIntraGraph } from "/chunk.js";
import { createIntraGraph } from "/intra-graph.js";
import { initMiniEditors } from "/mini-editor.js";

// ---------------------------------------------------------------- API client
// The adapter is chosen at boot: the local HTTP engine (mode "local") or
// Supabase (mode "cloud"). Web is always cloud; desktop remembers the user's
// choice (default local) and can enter cloud mode only if the (public) keys
// were provided via /config.js. Same adapter interface either way.
const CONFIG = window.CB_CONFIG || { platform: "desktop" };
const MODE_KEY = "cb-mode";
const cloudCreds = CONFIG.platform === "web"
  ? (CONFIG.supabaseUrl ? { supabaseUrl: CONFIG.supabaseUrl, supabaseKey: CONFIG.supabaseKey, clerkPublishableKey: CONFIG.clerkPublishableKey } : null)
  : (CONFIG.cloud || null);
function currentMode() {
  if (CONFIG.platform === "web") return "cloud";
  if (!cloudCreds) return "local";
  return localStorage.getItem(MODE_KEY) === "cloud" ? "cloud" : "local";
}
let api;
async function loadApi(mode) {
  if (mode === "cloud") {
    const mod = await import("/api-supabase.js");
    return mod.createApi({ platform: "web", ...cloudCreds });
  }
  const mod = await import("/api-local.js");
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
  // no eager warmup — the model downloads on the first embed (lazy, off the boot path)
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

// Mini-editor manager — initialised in boot() once api + DOM are ready.
let miniMgr = null;

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
  // In cloud mode on desktop, offer a one-click drop back to offline Local mode.
  const canFallback = CONFIG.platform === "desktop" && document.body.dataset.mode === "cloud";
  banner.innerHTML = `<b>Couldn't reach the backend.</b> <span class="be-msg"></span>` +
    (canFallback ? `<button class="be-local">Use Local mode</button>` : "") +
    `<button class="be-x" title="dismiss">✕</button>`;
  banner.querySelector(".be-msg").textContent = msg;
  banner.querySelector(".be-x").onclick = () => banner.remove();
  banner.querySelector(".be-local")?.addEventListener("click", () => {
    localStorage.setItem(MODE_KEY, "local");
    location.reload();
  });
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
  _intraVecCache.delete(String(id)); // free the note's cached sentence vectors
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
  renderAttachments(id);
  scheduleIntraRefresh();
  if ($("#graphView").classList.contains("active")) spotlightCurrent();
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

// Render markdown text into an arbitrary element, including [[wikilink]] → link
// substitution and click-binding. Used by both the main preview and mini-editors.
export function renderMarkdownInto(el, text) {
  const raw = text || "";
  const withLinks = raw.replace(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g, (_, t) => `[${t}](wikilink:${encodeURIComponent(t.trim())})`);
  el.innerHTML = marked.parse(withLinks, { breaks: true });
  el.querySelectorAll('a[href^="wikilink:"]').forEach((a) => {
    a.classList.add("wikilink");
    a.onclick = (e) => {
      e.preventDefault();
      const title = decodeURIComponent(a.getAttribute("href").slice("wikilink:".length));
      const target = state.notes.find((x) => x.title.toLowerCase() === title.toLowerCase());
      if (target) selectNote(target.id);
    };
  });
  // Post-process images: lazy load, ensure alt, broken-image placeholder.
  el.querySelectorAll("img").forEach((img) => {
    img.loading = "lazy";
    if (!img.alt) img.alt = "image";
    img.onerror = () => {
      try {
        const span = document.createElement("span");
        span.className = "img-broken";
        span.textContent = img.alt || "image unavailable";
        img.parentNode?.replaceChild(span, img);
      } catch (_) { /* never throw */ }
    };
  });
}

function renderPreview() {
  renderMarkdownInto(previewEl, bodyEl.value);
}

// Debounced markdown render — avoids re-parsing the whole body on every keystroke.
let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 140);
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

// Remember the last text embedded per note, so saves that don't change the
// content (e.g. a group change) don't trigger a redundant embed round-trip.
const lastEmbedded = new Map();
async function reindex(id, text) {
  if (lastEmbedded.get(id) === text) return; // unchanged since last embed
  try {
    setStatus("indexing…", true);
    const vector = await embed(text);
    await api.storeEmbed(id, vector);
    lastEmbedded.set(id, text);
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

// --------------------------------------------------------- cross-vault spotlight
async function spotlightCurrent() {
  if (state.currentId == null) return;
  try {
    const hits = await api.suggestCross(state.currentId, 8);
    focusNode(state.currentId, hits.map((h) => h.id), hits);
  } catch (_) { /* never break selection */ }
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
    loadGraph(Number($("#threshold").value), openMiniFromNode).then(spotlightCurrent);
  } else {
    stopGraph(); // don't run the physics loop while the graph is hidden
    if (view === "editor") clearFocus();
  }
}

// Draggable divider to resize the left note-list pane. Width persists.
const SIDE_KEY = "cb-side-w";
function initSidebarSplit() {
  const app = $("#app");
  const div = $("#sidebarSplit");
  if (!app || !div) return;
  localStorage.removeItem("cb-sidebar-collapsed"); // clear the old collapse flag
  const saved = localStorage.getItem(SIDE_KEY);
  if (saved) app.style.setProperty("--side-w", saved);
  let dragging = false;
  div.addEventListener("mousedown", (e) => { e.preventDefault(); dragging = true; div.classList.add("dragging"); document.body.style.userSelect = "none"; });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const w = Math.max(180, Math.min(520, e.clientX)); // clamp so it can't disappear
    app.style.setProperty("--side-w", w + "px");
    resizeGraph();
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false; div.classList.remove("dragging"); document.body.style.userSelect = "";
    localStorage.setItem(SIDE_KEY, app.style.getPropertyValue("--side-w") || "280px");
  });
  div.addEventListener("dblclick", () => { app.style.setProperty("--side-w", "280px"); localStorage.setItem(SIDE_KEY, "280px"); resizeGraph(); });
}

// ---------------------------------------------------------- workspace splitter
// Persists per-pane pixel widths (not percentages, so they survive pane
// toggles without the editor collapsing). localStorage key: cb-pane-widths.
const PANE_WIDTHS_KEY = "cb-pane-widths";

// Ordered list of all (optional) panes that live right of the editor.
// "editor" always fills the remainder via flex-grow.
// intra and attach are now floating panels, not workspace columns.
const WORKSPACE_PANES = ["rendered"];
const PANE_DEFAULTS   = { rendered: 380 };

function loadPaneWidths() {
  try { return JSON.parse(localStorage.getItem(PANE_WIDTHS_KEY) || "{}"); }
  catch (_) { return {}; }
}
function savePaneWidths(widths) {
  try { localStorage.setItem(PANE_WIDTHS_KEY, JSON.stringify(widths)); }
  catch (_) { /* non-fatal */ }
}

// Apply stored (or default) flex-basis to each optional pane element.
function applyPaneWidths(widths) {
  for (const key of WORKSPACE_PANES) {
    const el = document.querySelector(`.workspace .pane[data-pane="${key}"]`);
    if (!el) continue;
    const w = widths[key] ?? PANE_DEFAULTS[key];
    el.style.flexBasis = w + "px";
    el.style.flexGrow = "0";
    el.style.flexShrink = "0";
  }
}

// Update splitter visibility so only splits between two VISIBLE panes show.
// (intra and attach are now floating panels, so only editor-rendered remains)
function syncSplitters() {
  const workspace = document.querySelector(".workspace");
  if (!workspace) return;
  const splits = [...workspace.querySelectorAll(".workspace-split")];
  for (const sp of splits) {
    const key = sp.dataset.split; // e.g. "editor-rendered"
    const [a, b] = key.split("-");
    const elA = workspace.querySelector(`.pane[data-pane="${a}"]`);
    const elB = workspace.querySelector(`.pane[data-pane="${b}"]`);
    const vis = elA && !elA.classList.contains("pane-hidden") &&
                elB && !elB.classList.contains("pane-hidden");
    sp.classList.toggle("split-hidden", !vis);
  }
}

function initWorkspaceSplits() {
  const workspace = document.querySelector(".workspace");
  if (!workspace) return;

  // Restore saved widths (or use defaults).
  const widths = loadPaneWidths();
  applyPaneWidths(widths);
  syncSplitters();

  // Wire each splitter handle.
  workspace.querySelectorAll(".workspace-split").forEach((div) => {
    const key = div.dataset.split;
    const [leftKey, rightKey] = key.split("-");
    let dragging = false;
    let startX, startLeftW, startRightW;

    div.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const elL = workspace.querySelector(`.pane[data-pane="${leftKey}"]`);
      const elR = workspace.querySelector(`.pane[data-pane="${rightKey}"]`);
      if (!elL || !elR) return;
      dragging = true;
      startX = e.clientX;
      startLeftW  = elL.getBoundingClientRect().width;
      startRightW = elR.getBoundingClientRect().width;
      div.classList.add("dragging");
      document.body.style.userSelect = "none";
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const delta = e.clientX - startX;
      const elL = workspace.querySelector(`.pane[data-pane="${leftKey}"]`);
      const elR = workspace.querySelector(`.pane[data-pane="${rightKey}"]`);
      if (!elL || !elR) return;
      // Editor pane (leftKey="editor") has flex-grow:1; resize right only.
      if (leftKey === "editor") {
        const newR = Math.max(80, startRightW - delta);
        elR.style.flexBasis = newR + "px";
        const cur = loadPaneWidths();
        cur[rightKey] = newR;
        savePaneWidths(cur);
      } else {
        const newL = Math.max(80, startLeftW + delta);
        const newR = Math.max(80, startRightW - delta);
        elL.style.flexBasis = newL + "px";
        elR.style.flexBasis = newR + "px";
        const cur = loadPaneWidths();
        cur[leftKey]  = newL;
        cur[rightKey] = newR;
        savePaneWidths(cur);
      }
      if (_intraInstance) _intraInstance.resize();
    });

    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      div.classList.remove("dragging");
      document.body.style.userSelect = "";
    });

    // Double-click: reset both sides to their defaults.
    div.addEventListener("dblclick", () => {
      const elL = workspace.querySelector(`.pane[data-pane="${leftKey}"]`);
      const elR = workspace.querySelector(`.pane[data-pane="${rightKey}"]`);
      const cur = loadPaneWidths();
      if (elR && rightKey !== "editor") {
        elR.style.flexBasis = PANE_DEFAULTS[rightKey] + "px";
        cur[rightKey] = PANE_DEFAULTS[rightKey];
      }
      if (elL && leftKey !== "editor") {
        elL.style.flexBasis = PANE_DEFAULTS[leftKey] + "px";
        cur[leftKey] = PANE_DEFAULTS[leftKey];
      }
      savePaneWidths(cur);
      if (_intraInstance) _intraInstance.resize();
    });
  });
}

// ---------------------------------------------------------- pane visibility
// Persist which optional panes are visible. Defaults: rendered=true, intra=false, attach=false.
const PANE_VIS_KEY = "cb-pane-vis";
const PANE_VIS_DEFAULTS = { rendered: true, intra: false, attach: false };

function loadPaneVis() {
  try { return { ...PANE_VIS_DEFAULTS, ...JSON.parse(localStorage.getItem(PANE_VIS_KEY) || "{}") }; }
  catch (_) { return { ...PANE_VIS_DEFAULTS }; }
}
function savePaneVis(vis) {
  try { localStorage.setItem(PANE_VIS_KEY, JSON.stringify(vis)); }
  catch (_) { /* non-fatal */ }
}

// Apply visibility to each optional workspace pane and sync checkboxes.
// Note: intra and attach are floating panels, handled separately by initFloatingPanels.
function applyPaneVis(vis) {
  // Only rendered is still a workspace column.
  const rendPane = document.querySelector('.workspace .pane[data-pane="rendered"]');
  if (rendPane) rendPane.classList.toggle("pane-hidden", !vis.rendered);
  const rendChk = $("#renderedToggle");
  if (rendChk) rendChk.checked = !!vis.rendered;
  syncSplitters();
}

function setPaneVisible(key, visible) {
  const vis = loadPaneVis();
  vis[key] = visible;
  savePaneVis(vis);
  if (key === "rendered") {
    applyPaneVis(vis);
  }
  // intra and attach are floating panels — their visibility is handled by initFloatingPanels.
}

function initPaneToggles() {
  const vis = loadPaneVis();
  applyPaneVis(vis);

  // Rendered toggle — still a workspace column
  const rendChk = $("#renderedToggle");
  if (rendChk) rendChk.onchange = () => setPaneVisible("rendered", rendChk.checked);

  // Intra and Attachments toggles are now wired by initFloatingPanels().
}

// ---------------------------------------------------------- floating panels
// localStorage keys for geometry persistence.
const FLOAT_INTRA_KEY  = "cb-float-intra";
const FLOAT_ATTACH_KEY = "cb-float-attach";

// Default positions: stacked on the right side of the viewport.
function floatDefaults(panelId) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (panelId === "floatIntra") {
    return { x: Math.max(0, vw - 340), y: 80,  w: 320, h: 360 };
  }
  return { x: Math.max(0, vw - 340), y: 460, w: 320, h: 260 };
}

function loadFloatGeom(key, panelId) {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    if (saved && typeof saved.x === "number") return saved;
  } catch (_) { /* ignore */ }
  return floatDefaults(panelId);
}

function saveFloatGeom(key, el) {
  try {
    localStorage.setItem(key, JSON.stringify({
      x: parseInt(el.style.left,  10) || 0,
      y: parseInt(el.style.top,   10) || 0,
      w: el.offsetWidth,
      h: el.offsetHeight,
    }));
  } catch (_) { /* non-fatal */ }
}

function applyFloatGeom(el, geom) {
  const maxX = Math.max(0, window.innerWidth  - 80);
  const maxY = Math.max(0, window.innerHeight - 40);
  el.style.left   = Math.min(geom.x, maxX) + "px";
  el.style.top    = Math.min(geom.y, maxY) + "px";
  el.style.width  = geom.w + "px";
  el.style.height = geom.h + "px";
}

// Make a floating panel draggable via its titlebar using pointer capture.
// On drag-end, clamp to viewport and save geometry.
function makeDraggable(panel, handle, storageKey) {
  let startPX, startPY, startLeft, startTop;

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    startPX   = e.clientX;
    startPY   = e.clientY;
    startLeft = parseInt(panel.style.left, 10) || 0;
    startTop  = parseInt(panel.style.top,  10) || 0;
    handle.style.cursor = "grabbing";
  });

  handle.addEventListener("pointermove", (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    const dx = e.clientX - startPX;
    const dy = e.clientY - startPY;
    const newX = Math.max(0, Math.min(startLeft + dx, window.innerWidth  - 80));
    const newY = Math.max(0, Math.min(startTop  + dy, window.innerHeight - 40));
    panel.style.left = newX + "px";
    panel.style.top  = newY + "px";
  });

  handle.addEventListener("pointerup", (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    handle.releasePointerCapture(e.pointerId);
    handle.style.cursor = "";
    saveFloatGeom(storageKey, panel);
  });

  handle.addEventListener("pointercancel", (e) => {
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    handle.style.cursor = "";
  });
}

// Wire resize-end saving via ResizeObserver.
// The observer fires on any dimension change; we debounce to avoid excessive writes.
function watchResize(panel, storageKey, onResize) {
  let t = null;
  const ro = new ResizeObserver(() => {
    clearTimeout(t);
    t = setTimeout(() => {
      saveFloatGeom(storageKey, panel);
      if (onResize) onResize();
    }, 80);
  });
  ro.observe(panel);
}

function showFloatPanel(panel, storageKey) {
  const geom = loadFloatGeom(storageKey, panel.id);
  applyFloatGeom(panel, geom);
  panel.hidden = false;
}

function hideFloatPanel(panel) {
  panel.hidden = true;
}

function initFloatingPanels() {
  const intraPanel  = $("#floatIntra");
  const attachPanel = $("#floatAttach");
  if (!intraPanel || !attachPanel) return;

  // --- Related (intra) panel ---
  const intraVis = loadPaneVis();
  if (intraVis.intra) showFloatPanel(intraPanel, FLOAT_INTRA_KEY);

  makeDraggable(intraPanel, $("#floatIntraDrag"), FLOAT_INTRA_KEY);

  // ResizeObserver on the panel drives intraCanvas resize.
  watchResize(intraPanel, FLOAT_INTRA_KEY, () => {
    if (_intraInstance) _intraInstance.resize();
  });

  // Close button unchecks the toggle and hides.
  $("#floatIntraClose").onclick = () => {
    const chk = $("#intraToggle");
    if (chk) chk.checked = false;
    const vis = loadPaneVis();
    vis.intra = false;
    savePaneVis(vis);
    hideFloatPanel(intraPanel);
    if (_intraInstance) { _intraInstance.destroy(); _intraInstance = null; }
  };

  // Toolbar toggle wires to show/hide floating panel (replaces old column logic).
  const intraChk = $("#intraToggle");
  if (intraChk) intraChk.onchange = () => {
    const vis = loadPaneVis();
    vis.intra = intraChk.checked;
    savePaneVis(vis);
    if (intraChk.checked) {
      showFloatPanel(intraPanel, FLOAT_INTRA_KEY);
      scheduleIntraRefresh();
    } else {
      hideFloatPanel(intraPanel);
      if (_intraInstance) { _intraInstance.destroy(); _intraInstance = null; }
    }
  };

  // --- Attachments panel ---
  const attachVis = loadPaneVis();
  if (attachVis.attach) showFloatPanel(attachPanel, FLOAT_ATTACH_KEY);

  makeDraggable(attachPanel, $("#floatAttachDrag"), FLOAT_ATTACH_KEY);
  watchResize(attachPanel, FLOAT_ATTACH_KEY, null);

  $("#floatAttachClose").onclick = () => {
    const chk = $("#attachToggle");
    if (chk) chk.checked = false;
    const vis = loadPaneVis();
    vis.attach = false;
    savePaneVis(vis);
    hideFloatPanel(attachPanel);
  };

  const attChk = $("#attachToggle");
  if (attChk) attChk.onchange = () => {
    const vis = loadPaneVis();
    vis.attach = attChk.checked;
    savePaneVis(vis);
    if (attChk.checked) {
      showFloatPanel(attachPanel, FLOAT_ATTACH_KEY);
    } else {
      hideFloatPanel(attachPanel);
    }
  };

  // Sync checkbox states to persisted visibility.
  if (intraChk)  intraChk.checked  = !!intraVis.intra;
  if (attChk)    attChk.checked    = !!attachVis.attach;
}

// Desktop only: toggle between Local and Cloud-account mode (persist + reload).
function initModeToggle() {
  const btn = $("#modeToggle");
  if (!btn) return;
  if (CONFIG.platform !== "desktop" || !cloudCreds) { btn.classList.add("hidden"); return; }
  const cloud = document.body.dataset.mode === "cloud";
  btn.textContent = cloud ? "Use local notes" : "☁ Sign in to cloud";
  btn.onclick = () => {
    localStorage.setItem(MODE_KEY, cloud ? "local" : "cloud");
    location.reload();
  };
}

// Open a graph node in the editor. On the web multi-vault graph a node may live
// in another vault — switch to it first, then open the note.
async function openGraphNode(node) {
  const id = typeof node === "object" ? node.id : node;
  const vid = typeof node === "object" ? node.vault : null;
  if (vid && api.currentVault?.() && vid !== api.currentVault()) {
    await switchVault(vid);
  }
  switchView("editor");
  selectNote(id);
}

// Draw similarity lines + % between the currently-open (non-minimized) graph
// minis, using the global graph's edges as the connection source.
function refreshMiniConnections() {
  if (!miniMgr) return;
  const open = miniMgr.serialize().filter((w) => w.state !== "minimized");
  const conns = [];
  for (let i = 0; i < open.length; i++) {
    for (let j = i + 1; j < open.length; j++) {
      const e = edgeBetween(open[i].noteId, open[j].noteId);
      if (e) conns.push({ a: open[i].noteId, b: open[j].noteId, sim: e.type === "user" ? 1 : e.weight });
    }
  }
  miniMgr.setConnections(conns);
}

// Open a graph node click as a floating mini-editor (Q1 — default behaviour).
function openMiniFromNode(node) {
  if (!miniMgr) { openGraphNode(node); return; }
  Promise.resolve(miniMgr.openMini({
    id: node.id,
    vault: node.vault ?? "",
    title: node.title ?? "",
    matchStart: node.matchStart ?? null,
    matchEnd: node.matchEnd ?? null,
  })).then(refreshMiniConnections);
}

// Called by the mini's Expand button: open the full editor, optionally scroll
// to the match range (mirrors the intra-graph node-click pattern).
async function openMiniExpand(id, vault, matchStart, matchEnd) {
  await openGraphNode({ id, vault });
  if (matchStart != null) {
    scrollEditorToRange(matchStart, matchEnd ?? matchStart);
  }
}

// Scroll the textarea so the range [start, end] is centred in view.
// Uses a hidden mirror element to measure the pixel Y of the offset.
function scrollEditorToRange(start, end) {
  bodyEl.focus();
  bodyEl.setSelectionRange(start, end ?? start);
  // Build a mirror of the textarea to measure the caret Y position.
  const cs = getComputedStyle(bodyEl);
  const mirror = document.createElement("div");
  mirror.style.cssText = [
    "position:fixed", "top:0", "left:-9999px", "visibility:hidden",
    "overflow-wrap:break-word", "white-space:pre-wrap",
    `width:${bodyEl.clientWidth}px`,
    `font:${cs.font}`,
    `font-size:${cs.fontSize}`,
    `font-family:${cs.fontFamily}`,
    `font-weight:${cs.fontWeight}`,
    `line-height:${cs.lineHeight}`,
    `letter-spacing:${cs.letterSpacing}`,
    `padding:${cs.padding}`,
    `border:${cs.border}`,
    `box-sizing:${cs.boxSizing}`,
    `tab-size:${cs.tabSize}`,
  ].join(";");
  // Text before caret + a tiny marker span.
  const before = document.createTextNode(bodyEl.value.slice(0, start));
  const marker = document.createElement("span");
  marker.textContent = "​"; // zero-width space
  mirror.appendChild(before);
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const markerTop = marker.offsetTop;
  document.body.removeChild(mirror);
  bodyEl.scrollTop = Math.max(0, markerTop - bodyEl.clientHeight / 2);
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
    const alt = (f.name || "image").replace(/\.[a-z0-9]+$/i, "").replace(/[\[\]]/g, "");
    // Insert a temporary uploading placeholder so the user sees progress.
    const placeholder = `\n![${alt}](uploading…)\n`;
    insertAtCursor(placeholder);
    try {
      setStatus(`uploading ${f.name}…`, true);
      const url = await api.upload(f);
      // Replace the placeholder with the real URL in-place.
      bodyEl.value = bodyEl.value.replace(placeholder, `\n![${alt}](${url})\n`);
      renderPreview();
      scheduleSave();
      setStatus("image added");
      setTimeout(() => setStatus(""), 1200);
    } catch (e) {
      // Remove the placeholder and surface the error; continue with remaining files.
      bodyEl.value = bodyEl.value.replace(placeholder, "");
      renderPreview();
      scheduleSave();
      console.error("[crossbean] image upload failed:", e);
      setStatus("image upload failed: " + e.message);
    }
  }
}

// Scan one or more photos of handwriting/print → text, inserted at the cursor.
// Files are processed sequentially; an in-flight guard prevents overlapping runs.
let _ocrInFlight = false;
async function runOcr(filesOrFile) {
  if (state.currentId == null) return;
  if (_ocrInFlight) { setStatus("scan already in progress…"); return; }
  const files = [...(filesOrFile instanceof FileList ? filesOrFile : [filesOrFile])]
    .filter((f) => f && f.type.startsWith("image/"));
  if (!files.length) return;
  _ocrInFlight = true;
  try {
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const prefix = files.length > 1 ? `[${i + 1}/${files.length}] ` : "";
      setStatus(`${prefix}scanning ${f.name}…`, true);
      // (1) Upload the scanned image so it also lands in Attachments.
      try {
        const url = await api.upload(f);
        await api.addAttachment(state.currentId, { url, name: f.name, mime: f.type });
      } catch (uploadErr) {
        console.error("[crossbean] OCR attachment upload failed:", uploadErr);
        // Non-fatal: continue to OCR anyway.
      }
      // (2) Extract text and insert at cursor.
      try {
        const text = (await api.ocr(f)).trim();
        if (!text) { setStatus(`${prefix}no text found`); setTimeout(() => setStatus(""), 1500); continue; }
        const lead = i === 0 && bodyEl.value && !bodyEl.value.endsWith("\n") ? "\n\n" : (i > 0 ? "\n\n" : "");
        insertAtCursor(lead + text + "\n");
        setStatus(`${prefix}text extracted`);
        if (i === files.length - 1) setTimeout(() => setStatus(""), 1500);
      } catch (e) {
        setStatus(`${prefix}scan failed: ` + e.message);
      }
    }
  } finally {
    _ocrInFlight = false;
    renderAttachments(state.currentId);
  }
}

// ----------------------------------------------------------------- attachments
async function renderAttachments(noteId) {
  const listEl = $("#attachList");
  const btn = $("#attachBtn");
  if (!listEl || noteId == null) { if (listEl) listEl.innerHTML = ""; return; }
  let items = [];
  try { items = await api.listAttachments(noteId); } catch (_) { /* non-fatal */ }
  listEl.innerHTML = "";
  for (const att of items) {
    const el = document.createElement("div");
    el.className = "attach-item";
    const isImg = att.mime && att.mime.startsWith("image/");
    el.innerHTML = (isImg ? `<img src="${escapeHtml(att.url)}" alt="${escapeHtml(att.name)}" />` : "") +
      `<a href="${escapeHtml(att.url)}" target="_blank" rel="noopener" title="${escapeHtml(att.name)}">${escapeHtml(att.name)}</a>` +
      `<button class="attach-remove" title="Remove attachment">✕</button>`;
    el.querySelector(".attach-remove").onclick = async () => {
      try { await api.removeAttachment(att.id); } catch (e) { setStatus("remove failed: " + e.message); }
      renderAttachments(noteId);
    };
    listEl.appendChild(el);
  }
  if (btn) btn.disabled = false;
}

// --------------------------------------------------------------- intra-graph
// Per-note sentence → vector cache (avoids re-embedding on slider changes).
const _intraVecCache = new Map(); // note-text-key -> Map(sentenceText -> vector)
let _intraInstance = null;        // current createIntraGraph() handle
let _intraRefreshTimer = null;


async function refreshIntraGraph() {
  const toggle = $("#intraToggle");
  const intraPane = $("#intraPane");
  if (!toggle || !toggle.checked || state.currentId == null) {
    if (_intraInstance) { _intraInstance.destroy(); _intraInstance = null; }
    return;
  }

  const text = bodyEl.value || "";
  if (!text.trim()) {
    if (_intraInstance) { _intraInstance.destroy(); _intraInstance = null; }
    return;
  }

  const sents = splitSentences(text);
  if (!sents.length) {
    return;
  }

  // Show busy state while embedding runs.
  if (intraPane) intraPane.classList.add("intra-busy");

  // Use per-note cache keyed by (noteId, sentenceText).
  const cacheKey = String(state.currentId);
  if (!_intraVecCache.has(cacheKey)) _intraVecCache.set(cacheKey, new Map());
  const sentCache = _intraVecCache.get(cacheKey);

  const vectors = [];
  for (const s of sents) {
    if (!sentCache.has(s.text)) {
      try {
        const vec = await embed(s.text);
        sentCache.set(s.text, vec);
      } catch (_) {
        sentCache.set(s.text, new Array(384).fill(0));
      }
    }
    vectors.push(sentCache.get(s.text));
  }

  if (intraPane) intraPane.classList.remove("intra-busy");

  const gran = Number($("#intraGran")?.value ?? 1);
  const thresh = Number($("#intraThreshold")?.value ?? 0.55);
  const { nodes, edges } = buildIntraGraph(sents, vectors, { granularity: gran, threshold: thresh, topK: 3 });

  // Lazily create (or reuse) the renderer.
  const canvas = $("#intraCanvas");
  if (!_intraInstance && canvas) {
    _intraInstance = createIntraGraph(canvas, {
      onNodeClick: (n) => {
        scrollEditorToRange(n.start, n.end);
      },
    });
  }
  if (_intraInstance) {
    _intraInstance.setData(nodes, edges);
    _intraInstance.resize();
  }
}

function scheduleIntraRefresh() {
  clearTimeout(_intraRefreshTimer);
  _intraRefreshTimer = setTimeout(refreshIntraGraph, 400);
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
  const close = () => { hideModal(modal); };
  $("#updateClose").onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };
  $("#updateDownload").onclick = () => window.open(info.downloadUrl || info.releaseUrl, "_blank", "noopener");
  $("#updateView").onclick = () => window.open(info.releaseUrl || info.downloadUrl, "_blank", "noopener");
  showModal(modal);
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
  // desktop users can bail back to local notes from the sign-in screen
  const escape = $("#authUseLocal");
  if (escape) {
    if (CONFIG.platform === "desktop") escape.onclick = () => { localStorage.setItem(MODE_KEY, "local"); location.reload(); };
    else escape.classList.add("hidden");
  }
  showModal(screen);
  await api.mountAuth($("#clerkAuth"));
  hideModal(screen);
}

// -------------------------------------------------------- vaults (web only)
const NEW_VAULT = "__newv__";

// The active vault is shown in two places — the sidebar and the editor bar.
const vaultSelectors = () => [$("#vaultSelect"), $("#editorVaultSelect")].filter(Boolean);

function fillVaultSelect(sel, list, current) {
  sel.innerHTML = "";
  for (const v of list) sel.appendChild(new Option(v.name + (v.mine ? "" : " (shared)"), v.id));
  sel.appendChild(new Option("＋ New vault…", NEW_VAULT));
  sel.value = current;
}

async function loadVaults() {
  const list = await api.vaults();
  state.vaults = list;
  const current = api.currentVault() ?? list[0]?.id ?? "";
  for (const sel of vaultSelectors()) fillVaultSelect(sel, list, current);
}

async function switchVault(id) {
  const current = api.currentVault() || "";
  if (id === current) return;
  await flushSave(); // persist pending edits while vaultId still points at the old vault

  if (id === NEW_VAULT) {
    const name = (prompt("New vault name:") || "").trim();
    if (!name) { for (const s of vaultSelectors()) s.value = current; return; }
    await api.createVault(name);
    await loadVaults();
  } else {
    await api.setVault(id);
    for (const s of vaultSelectors()) s.value = id;
  }

  state.currentId = null; state.currentGroup = ""; state.dirty = false;
  titleEl.value = ""; bodyEl.value = ""; renderPreview(); suggestionsEl.innerHTML = "";
  await refreshNotes();
  // if the graph is open, rebuild it for the new vault
  if ($("#graphView").classList.contains("active")) {
    loadGraph(Number($("#threshold").value), openMiniFromNode);
  }
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
  $("#shareClose").onclick = () => { hideModal(modal); };
  modal.onclick = (e) => { if (e.target === modal) hideModal(modal); };
  await render();
  showModal(modal);
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
  const done = (why) => { hideModal(modal); localStorage.setItem(STAR_KEY, why); };
  $("#starClose").onclick = () => done("dismissed");
  $("#starLater").onclick = () => done("dismissed");
  $("#starGo").onclick = () => { window.open(REPO_URL, "_blank", "noopener"); done("starred"); };
  modal.onclick = (e) => { if (e.target === modal) done("dismissed"); };
  showModal(modal);
}

// ------------------------------------------------------------------- utils
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Hide the mini layer while a modal/auth overlay is visible (Q4).
// Counts open modals so nested open/close pairs don't prematurely restore.
let _modalDepth = 0;
function showModal(el) {
  _modalDepth++;
  el.hidden = false;
  const miniLayer = document.getElementById("miniLayer");
  if (miniLayer) miniLayer.style.display = "none";
}
function hideModal(el) {
  el.hidden = true;
  _modalDepth = Math.max(0, _modalDepth - 1);
  if (_modalDepth === 0) {
    const miniLayer = document.getElementById("miniLayer");
    if (miniLayer) miniLayer.style.display = "";
  }
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
  bodyEl.oninput = () => { schedulePreview(); scheduleSave(); scheduleIntraRefresh(); };

  // grouping
  groupSelect.onchange = changeGroup;

  // image attach: toolbar button, file picker, paste, drag & drop
  $("#attachImgBtn").onclick = () => $("#imgFileInput").click();
  $("#imgFileInput").onchange = (e) => { handleImageFiles(e.target.files); e.target.value = ""; };

  initWorkspaceSplits();
  initPaneToggles();
  initFloatingPanels();
  initSidebarSplit();

  // OCR ("Scan text"): only shown when the adapter supports it (web)
  $("#ocrBtn").classList.toggle("hidden", !api.ocrAvailable);
  $("#ocrBtn").onclick = () => $("#ocrFileInput").click();
  $("#ocrFileInput").onchange = (e) => { runOcr(e.target.files); e.target.value = ""; };

  // Import file as new note (txt / md / docx)
  $("#importBtn").onclick = () => $("#importFileInput").click();
  $("#importFileInput").onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const ext = file.name.replace(/^.*\./, "").toLowerCase();
    const title = file.name.replace(/\.[^.]+$/, "").trim() || "Imported note";
    setStatus(`importing ${file.name}…`, true);
    try {
      let body = "";
      if (ext === "docx") {
        const mammoth = await import("https://cdn.jsdelivr.net/npm/mammoth@1.6.0/+esm");
        const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
        body = result.value || "";
      } else {
        body = await file.text();
      }
      const { id } = await api.create(title, body, state.currentGroup || "");
      setStatus("imported");
      setTimeout(() => setStatus(""), 1500);
      await refreshNotes(id);
    } catch (err) {
      console.error("[crossbean] import failed:", err);
      setStatus("import failed: " + err.message);
    }
  };

  // Attachments
  $("#attachBtn").onclick = () => $("#attachFileInput").click();
  $("#attachFileInput").onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    const btn = $("#attachBtn");
    if (!files.length || state.currentId == null) return;
    btn.disabled = true;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      setStatus(`uploading ${f.name} (${i + 1}/${files.length})…`, true);
      try {
        const url = await api.upload(f);
        await api.addAttachment(state.currentId, { url, name: f.name, mime: f.type });
      } catch (err) {
        setStatus("attach failed: " + err.message);
      }
    }
    setStatus("attached");
    setTimeout(() => setStatus(""), 1200);
    renderAttachments(state.currentId);
  };

  // Intra-note graph controls (toggle is handled by initPaneToggles)
  $("#intraGran").oninput = scheduleIntraRefresh;
  $("#intraThreshold").oninput = (e) => {
    const val = Number(e.target.value).toFixed(2);
    const label = $("#intraThVal");
    if (label) label.textContent = val;
    scheduleIntraRefresh();
  };
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

  // cloud-mode chrome
  $("#vaultSelect").onchange = (e) => switchVault(e.target.value);
  $("#editorVaultSelect").onchange = (e) => switchVault(e.target.value);
  $("#shareVaultBtn").onclick = openShareDialog;
  $("#signOutBtn").onclick = async () => { await api.signOut(); localStorage.setItem(MODE_KEY, "local"); location.reload(); };
  initModeToggle();
  $("#searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch();
    if (e.key === "Escape") { e.target.value = ""; renderNoteList(); }
  });
  document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => switchView(t.dataset.view)));
  $("#themeBtn").onclick = toggleTheme;
  let thresholdTimer = null;
  $("#threshold").addEventListener("input", (e) => {
    $("#thVal").textContent = Number(e.target.value).toFixed(2); // label updates live
    clearTimeout(thresholdTimer); // but only refetch the graph once the slider settles
    thresholdTimer = setTimeout(() => loadGraph(Number(e.target.value), openMiniFromNode), 250);
  });
  $("#refreshGraph").onclick = () => loadGraph(Number($("#threshold").value), openMiniFromNode);

  // delete current note with Ctrl+Shift+Backspace (now with a confirmation)
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === "Backspace" && state.currentId != null) {
      e.preventDefault();
      const n = state.notes.find((x) => x.id === state.currentId);
      deleteNoteFlow(state.currentId, n?.title);
    }
  });
  window.addEventListener("resize", () => { resizeGraph(); if (_intraInstance) _intraInstance.resize(); });
  window.addEventListener("beforeunload", () => { flushSave(); persistMinis(); });
}

// ------------------------------------------------------------------- boot
async function boot() {
  applyTheme(localStorage.getItem(THEME_KEY) || "paper");
  const mode = currentMode();
  document.body.dataset.platform = CONFIG.platform;
  document.body.dataset.mode = mode; // drives cloud-only / local-only chrome
  api = await loadApi(mode);
  // cloud shows every vault (userGraph); local is single-vault (graph)
  setGraphSource((threshold) => (api.userGraph ? api.userGraph(threshold) : api.graph(threshold)));

  if (mode === "cloud") {
    const session = await api.init();
    if (!session.authed) await requireAuth();
  }

  wire();
  initGraph($("#graphCanvas"), $("#graphEmpty"));
  initEmbedder();

  // Mini-editor manager — must be created after DOM is ready and api is set.
  miniMgr = initMiniEditors(document.body, {
    noteLoader: (id) => api.noteAny ? api.noteAny(id) : api.note(id),
    renderMarkdown: (el, md) => renderMarkdownInto(el, md),
    onExpand: ({ id, vault, matchStart, matchEnd }) => openMiniExpand(id, vault, matchStart, matchEnd),
  });

  if (mode === "cloud") {
    await loadVaults();
    // first-ever login: mint exactly one personal vault (done here, once, so
    // it can't race into duplicates from repeated vaults() calls)
    if (!state.vaults.length) {
      await api.createVault("Personal");
      await loadVaults();
    }
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

  // Restore persisted mini-windows for the current vault (Q5).
  // Runs quietly after notes are ready; never crashes boot on load failure.
  restorePersistedMinis().catch(() => {});

  indexMissing(); // embed anything not yet in the vector db (background)
  if (CONFIG.platform === "desktop" && mode === "local") {
    initVersion();
    checkForUpdates(false); // silent update check on launch
  }
  maybeShowStarPrompt();
}

// ----------------------------------------------------- mini persistence (Q5)
const MINI_PERSIST_KEY = "cb-mini-windows";

// Save the current set of open mini-windows to localStorage.
function persistMinis() {
  if (!miniMgr) return;
  try {
    const specs = miniMgr.serialize();
    localStorage.setItem(MINI_PERSIST_KEY, JSON.stringify(specs));
  } catch (_) { /* non-fatal */ }
}

// On boot, re-open windows that were open in the current vault last session.
// Any window whose note fails to load is silently dropped.
async function restorePersistedMinis() {
  if (!miniMgr) return;
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(MINI_PERSIST_KEY) || "[]");
  } catch (_) { return; }
  if (!Array.isArray(saved) || !saved.length) return;

  // Current vault id (null for desktop single-vault).
  const currentVid = api.currentVault ? api.currentVault() : null;

  for (const spec of saved) {
    // Only restore windows for the current vault (Q5).
    if (spec.vault && currentVid && spec.vault !== currentVid) continue;
    try {
      await miniMgr.openFromSaved(spec);
    } catch (_) { /* note gone — skip silently */ }
  }
}

const WELCOME = `# Welcome to crossbean

This is a local-first notebook where your notes form a **knowledge graph**.

Two kinds of connections show up in the **Graph** tab:

- **Your links** — type \[[Note Title]] to link notes yourself.
- **AI connections** — every note is embedded into a vector database, and notes with similar *meaning* are linked automatically (cosine similarity).

Try it: make a couple of notes on related topics and watch them connect — even without linking them by hand.

Everything lives on your machine. Notes are mirrored to the \`vault/\` folder as plain markdown.`;

boot().catch(fatalError);
