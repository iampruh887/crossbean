// Force-directed knowledge graph on a canvas.
// Nodes = notes; edges colored by type (your links vs AI similarity).
// Custom lightweight physics (repulsion + springs + centering) so there are no
// external graph deps and it runs entirely in the WebView2 renderer.

let canvas, ctx, emptyEl, onOpen;
let nodes = [], edges = [], nodeById = new Map();
let raf = null, alpha = 0;
const view = { x: 0, y: 0, k: 1 }; // pan + zoom
let drag = null, hover = null, dragMoved = false;

// Spotlight / focus state — zero permanent mutation of node/edge data.
// focusId:      the note id currently spotlighted (number|null)
// focusSet:     Set of node ids that stay fully visible
// spotEdges:    transient AI edges for matches that have no existing edge
// pendingFocus: [noteId, neighborIds, matches] queued before graph loaded
let focusId = null;
const focusSet = new Set();
let spotEdges = [];
let pendingFocus = null;

// Multi-vault (web): each vault is a colored cluster with a boundary hull.
let vaultById = new Map();   // vaultId -> { id, name, owner, hue }
let vaultHulls = new Map();  // vaultId -> world-space polygon (for hover hit-test)
let hoverVault = null;       // vaultId whose cluster the cursor is over
let mouse = { x: 0, y: 0 };  // last cursor position (screen), for the tooltip

// A vault's color, tuned per theme. Hue is stable per vault; sat/lightness
// adapt so clusters read well on both the paper and terminal backgrounds.
function vaultCss(hue, kind) {
  const dark = document.documentElement.dataset.theme === "terminal";
  const s = dark ? 70 : 55, l = dark ? 62 : 42;
  if (kind === "fill") return `hsla(${hue}, ${s}%, ${l}%, ${dark ? 0.12 : 0.09})`;
  if (kind === "stroke") return `hsla(${hue}, ${s}%, ${l}%, 0.5)`;
  return `hsl(${hue}, ${s}%, ${l}%)`; // node/label
}

// Convex hull (Andrew's monotone chain), then pushed outward from the centroid
// by `pad` so nodes sit inside the boundary. <3 points → null (caller draws a circle).
function hull(points, pad) {
  if (points.length < 3) return null;
  const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  const h = lower.slice(0, -1).concat(upper.slice(0, -1));
  const cx = h.reduce((s, p) => s + p.x, 0) / h.length;
  const cy = h.reduce((s, p) => s + p.y, 0) / h.length;
  return h.map((p) => { const dx = p.x - cx, dy = p.y - cy, d = Math.hypot(dx, dy) || 1; return { x: p.x + (dx / d) * pad, y: p.y + (dy / d) * pad }; });
}

function pointInPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

// Colors come from the active theme's CSS variables, read per frame so the
// canvas restyles instantly when the theme toggles.
function themeColors() {
  const s = getComputedStyle(document.documentElement);
  const v = (n) => s.getPropertyValue(n).trim();
  return {
    user: v("--user-link"),
    ai: v("--ai-link"),
    node: v("--g-node"),
    nodeNoVec: v("--g-node-dim"),
    label: v("--g-label"),
    bg: v("--g-bg"),
    hover: v("--accent-2"),
    font: v("--g-font") || "sans-serif",
  };
}

export function initGraph(canvasEl, emptyElement) {
  canvas = canvasEl;
  emptyEl = emptyElement;
  ctx = canvas.getContext("2d");
  bindInteraction();
}

export function resizeGraph() {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0) return;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// Where graph data comes from — injected by app.js so the same renderer works
// against the local engine (desktop) and Supabase RPCs (web).
let graphSource = async (threshold) => (await fetch(`/api/graph?threshold=${threshold}`)).json();
export function setGraphSource(fn) { graphSource = fn; }

export async function loadGraph(threshold, openHandler) {
  onOpen = openHandler;
  const data = await graphSource(threshold);

  // vault metadata + stable, well-separated hues (golden-angle spacing)
  vaultById = new Map();
  (data.vaults || []).forEach((v, i) =>
    vaultById.set(v.id, { id: v.id, name: v.name, owner: v.owner, hue: Math.round((i * 137.508) % 360) })
  );

  const prev = nodeById;
  nodeById = new Map();
  const rect = canvas.getBoundingClientRect();
  const cx = rect.width / 2, cy = rect.height / 2;

  nodes = data.nodes.map((n, i) => {
    const old = prev.get(n.id);
    const angle = (i / Math.max(1, data.nodes.length)) * Math.PI * 2;
    const node = {
      ...n,
      x: old ? old.x : cx + Math.cos(angle) * 180 + (Math.random() - 0.5) * 40,
      y: old ? old.y : cy + Math.sin(angle) * 180 + (Math.random() - 0.5) * 40,
      vx: 0, vy: 0,
    };
    nodeById.set(n.id, node);
    return node;
  });
  edges = data.edges.filter((e) => nodeById.has(e.source) && nodeById.has(e.target));

  emptyEl.style.display = nodes.length ? "none" : "grid";

  // If a focus was requested before the graph was ready, apply it now.
  if (pendingFocus) {
    const pf = pendingFocus;
    pendingFocus = null;
    focusNode(pf[0], pf[1], pf[2]);
  }

  alpha = 1;
  ensureRunning();
}

// --------------------------------------------------------------- simulation
function step() {
  const rect = canvas.getBoundingClientRect();
  const cx = rect.width / 2, cy = rect.height / 2;
  const REP = 5200, SPRING = 0.02, CENTER = 0.012, DAMP = 0.86;
  const rest = 90;

  const clustered = vaultById.size > 0;
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      let d2 = dx * dx + dy * dy || 0.01;
      const d = Math.sqrt(d2);
      // nodes in different vaults repel harder so clusters separate
      const scale = clustered ? (a.vault === b.vault ? 0.55 : 1.7) : 1;
      const f = (REP / d2) * scale;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }
  }

  // cluster gravity: pull each node toward its vault's centroid
  if (clustered) {
    const cen = new Map();
    for (const n of nodes) {
      const c = cen.get(n.vault) || { x: 0, y: 0, n: 0 };
      c.x += n.x; c.y += n.y; c.n++; cen.set(n.vault, c);
    }
    for (const c of cen.values()) { c.x /= c.n; c.y /= c.n; }
    const CLUSTER = 0.05;
    for (const n of nodes) {
      const c = cen.get(n.vault);
      if (c) { n.vx += (c.x - n.x) * CLUSTER; n.vy += (c.y - n.y) * CLUSTER; }
    }
  }

  for (const e of edges) {
    const a = nodeById.get(e.source), b = nodeById.get(e.target);
    let dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const strength = SPRING * (e.type === "user" ? 1.6 : 0.9);
    const f = (d - rest) * strength;
    const fx = (dx / d) * f, fy = (dy / d) * f;
    a.vx += fx; a.vy += fy;
    b.vx -= fx; b.vy -= fy;
  }

  for (const n of nodes) {
    n.vx += (cx - n.x) * CENTER;
    n.vy += (cy - n.y) * CENTER;
    if (drag && drag.node === n) continue;
    n.vx *= DAMP; n.vy *= DAMP;
    n.x += n.vx * alpha; n.y += n.vy * alpha;
  }
  alpha *= 0.985; // decays to ~0 so the loop can stop (see tick)
}

function draw() {
  const C = themeColors();
  const rect = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.save();
  ctx.translate(view.x, view.y);
  ctx.scale(view.k, view.k);

  // vault cluster boundaries (drawn under everything)
  vaultHulls = new Map();
  if (vaultById.size) {
    const byVault = new Map();
    for (const n of nodes) {
      if (!vaultById.has(n.vault)) continue;
      if (!byVault.has(n.vault)) byVault.set(n.vault, []);
      byVault.get(n.vault).push(n);
    }
    for (const [vid, vnodes] of byVault) {
      const meta = vaultById.get(vid);
      const pad = 26;
      let poly = hull(vnodes.map((n) => ({ x: n.x, y: n.y })), pad);
      if (!poly) {
        // 1–2 nodes: draw a circle around their midpoint
        const mx = vnodes.reduce((s, n) => s + n.x, 0) / vnodes.length;
        const my = vnodes.reduce((s, n) => s + n.y, 0) / vnodes.length;
        const rr = Math.max(...vnodes.map((n) => Math.hypot(n.x - mx, n.y - my))) + pad + 8;
        poly = Array.from({ length: 24 }, (_, i) => { const a = (i / 24) * Math.PI * 2; return { x: mx + Math.cos(a) * rr, y: my + Math.sin(a) * rr }; });
      }
      vaultHulls.set(vid, poly);
      ctx.beginPath();
      ctx.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
      ctx.closePath();
      ctx.fillStyle = vaultCss(meta.hue, "fill");
      ctx.fill();
      ctx.lineWidth = (hoverVault === vid ? 2.5 : 1.5) / view.k;
      ctx.strokeStyle = vaultCss(meta.hue, "stroke");
      ctx.stroke();
      // vault name label at the cluster's top
      const top = poly.reduce((a, b) => (b.y < a.y ? b : a));
      ctx.fillStyle = vaultCss(meta.hue, "label");
      ctx.font = `600 ${12 / view.k}px ${C.font}`;
      ctx.textAlign = "center";
      ctx.fillText(meta.name, top.x, top.y - 6 / view.k);
    }
  }

  const focused = focusId !== null;

  // edges (existing) — dim those not in focusSet when spotlight is active
  for (const e of edges) {
    const a = nodeById.get(e.source), b = nodeById.get(e.target);
    const inFocus = !focused || (focusSet.has(e.source) && focusSet.has(e.target));
    const baseAlpha = e.type === "user" ? 0.6 : 0.3 + Math.min(0.5, ((e.weight ?? 0.3) - 0.25));
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = e.type === "user" ? C.user : C.ai;
    ctx.globalAlpha = inFocus ? baseAlpha : baseAlpha * 0.12;
    ctx.lineWidth = (e.type === "user" ? 1.6 : 1.0) / view.k;
    ctx.stroke();
  }

  // spotEdges — transient AI edges shown only while focused
  if (focused) {
    for (const e of spotEdges) {
      const a = nodeById.get(e.source), b = nodeById.get(e.target);
      if (!a || !b) continue;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = C.ai;
      ctx.globalAlpha = 0.3 + Math.min(0.5, ((e.weight ?? 0.3) - 0.25));
      ctx.lineWidth = 1.0 / view.k;
      ctx.setLineDash([4 / view.k, 4 / view.k]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  ctx.globalAlpha = 1;

  // nodes — dim those outside focusSet; accent ring on focusId; hover wins last
  for (const n of nodes) {
    const r = 4 + Math.sqrt(n.degree || 0) * 2.4; // guard: missing degree must never yield NaN (invisible node)
    const inFocus = !focused || focusSet.has(n.id);
    const dimMul = inFocus ? 1 : 0.12;

    ctx.globalAlpha = dimMul;
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    const vc = vaultById.get(n.vault);
    ctx.fillStyle = vc ? vaultCss(vc.hue, "node") : (n.hasVec ? C.node : C.nodeNoVec);
    if (hover === n) ctx.fillStyle = C.hover;
    ctx.fill();
    ctx.lineWidth = 1.5 / view.k;
    ctx.strokeStyle = C.bg;
    ctx.stroke();

    // accent ring on the focused node
    if (focused && n.id === focusId && hover !== n) {
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + 4 / view.k, 0, Math.PI * 2);
      ctx.strokeStyle = C.hover;
      ctx.lineWidth = 2 / view.k;
      ctx.stroke();
    }

    if (view.k > 0.55 || hover === n || n.degree > 2) {
      ctx.globalAlpha = dimMul;
      ctx.fillStyle = C.label;
      ctx.font = `${12 / view.k}px ${C.font}`;
      ctx.textAlign = "center";
      const label = n.title.length > 24 ? n.title.slice(0, 22) + "…" : n.title;
      ctx.fillText(label, n.x, n.y + r + 12 / view.k);
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  // vault tooltip (screen space): name + owner when hovering a cluster
  if (hoverVault && vaultById.has(hoverVault) && !hover) {
    const meta = vaultById.get(hoverVault);
    const text = `${meta.name}${meta.owner ? "  ·  " + meta.owner : ""}`;
    ctx.font = `12px ${C.font}`;
    const w = ctx.measureText(text).width + 20, h = 24;
    let x = Math.min(mouse.x + 14, rect.width - w - 6);
    let y = Math.min(mouse.y + 14, rect.height - h - 6);
    ctx.fillStyle = vaultCss(meta.hue, "node");
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, 5); ctx.fill(); }
    else ctx.fillRect(x, y, w, h);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(text, x + 10, y + h / 2);
    ctx.textBaseline = "alphabetic";
  }
}

function tick() {
  step();
  draw();
  // Stop once the layout has settled and nothing is being dragged — no point
  // burning CPU on an O(n²) physics loop for a static graph.
  if (alpha <= 0.03 && !drag) { raf = null; return; }
  raf = requestAnimationFrame(tick);
}
function ensureRunning() { if (!raf) raf = requestAnimationFrame(tick); }
function kick(a = 0.5) { alpha = Math.max(alpha, a); ensureRunning(); }
// Fully stop the loop (e.g. when the Graph tab is hidden).
export function stopGraph() { if (raf) { cancelAnimationFrame(raf); raf = null; } }
// One static redraw without re-energizing physics (hover/zoom while settled).
function redraw() { if (!raf) draw(); }

// --------------------------------------------------------------- spotlight / focus

// focusNode(noteId, neighborIds?, matches?)
//   noteId      — the note to spotlight (number)
//   neighborIds — ids of explicit neighbors to keep fully visible ([])
//   matches     — array of {id, sim} from a similarity search ([])
//
// All dimming is a draw-time multiplier; no node/edge state is mutated.
export function focusNode(noteId, neighborIds = [], matches = []) {
  // Guard: graph not yet loaded — queue for after loadGraph builds nodeById.
  if (!nodeById.has(noteId)) {
    pendingFocus = [noteId, neighborIds, matches];
    return;
  }

  focusId = noteId;
  focusSet.clear();
  focusSet.add(noteId);
  for (const id of neighborIds) focusSet.add(id);
  for (const m of matches) focusSet.add(m.id);

  // Also keep any node that already has an edge incident to noteId.
  for (const e of edges) {
    if (e.source === noteId) focusSet.add(e.target);
    if (e.target === noteId) focusSet.add(e.source);
  }

  // Build spotEdges: matches that have no existing edge to/from noteId.
  const existingNeighbors = new Set();
  for (const e of edges) {
    if (e.source === noteId) existingNeighbors.add(e.target);
    if (e.target === noteId) existingNeighbors.add(e.source);
  }
  spotEdges = matches
    .filter((m) => !existingNeighbors.has(m.id) && nodeById.has(m.id))
    .map((m) => ({ source: noteId, target: m.id, type: "ai", weight: m.sim }));

  kick(0.15);
}

// clearFocus() — remove the spotlight and restore full opacity for all nodes/edges.
export function clearFocus() {
  focusId = null;
  focusSet.clear();
  spotEdges = [];
  redraw();
}

// --------------------------------------------------------------- interaction
function screenToWorld(sx, sy) {
  return { x: (sx - view.x) / view.k, y: (sy - view.y) / view.k };
}
function nodeAt(sx, sy) {
  const p = screenToWorld(sx, sy);
  let best = null, bestD = Infinity;
  for (const n of nodes) {
    const r = 4 + Math.sqrt(n.degree) * 2.4 + 4;
    const d = (n.x - p.x) ** 2 + (n.y - p.y) ** 2;
    if (d < r * r && d < bestD) { best = n; bestD = d; }
  }
  return best;
}

function bindInteraction() {
  canvas.addEventListener("mousedown", (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const n = nodeAt(sx, sy);
    dragMoved = false;
    if (n) { drag = { node: n, ox: sx, oy: sy }; kick(0.4); } // node drag → physics
    else drag = { pan: true, ox: sx, oy: sy, vx: view.x, vy: view.y };
  });
  window.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    mouse.x = sx; mouse.y = sy;
    if (!drag) {
      const prevH = hover, prevV = hoverVault;
      hover = nodeAt(sx, sy);
      // cluster hover (only when not over a node): test the world point vs hulls
      hoverVault = null;
      if (!hover && vaultHulls.size) {
        const p = screenToWorld(sx, sy);
        for (const [vid, poly] of vaultHulls) { if (pointInPoly(p.x, p.y, poly)) { hoverVault = vid; break; } }
      }
      canvas.style.cursor = hover ? "pointer" : "grab";
      if (hover !== prevH || hoverVault !== prevV) redraw(); // one frame, no physics
      return;
    }
    dragMoved = true;
    if (drag.pan) { view.x = drag.vx + (sx - drag.ox); view.y = drag.vy + (sy - drag.oy); redraw(); }
    else { const p = screenToWorld(sx, sy); drag.node.x = p.x; drag.node.y = p.y; drag.node.vx = 0; drag.node.vy = 0; kick(0.4); }
  });
  window.addEventListener("mouseup", (e) => {
    // pass the whole node so the handler can switch vaults for cross-vault nodes
    if (drag && drag.node && !dragMoved && onOpen) onOpen(drag.node);
    drag = null;
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const wx = (sx - view.x) / view.k, wy = (sy - view.y) / view.k;
    view.k = Math.max(0.15, Math.min(4, view.k * factor));
    view.x = sx - wx * view.k;
    view.y = sy - wy * view.k;
    redraw(); // zoom is a view change, not physics
  }, { passive: false });
}
