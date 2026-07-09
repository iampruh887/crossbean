// Force-directed knowledge graph on a canvas.
// Nodes = notes; edges colored by type (your links vs AI similarity).
// Custom lightweight physics (repulsion + springs + centering) so there are no
// external graph deps and it runs entirely in the WebView2 renderer.

let canvas, ctx, emptyEl, onOpen;
let nodes = [], edges = [], nodeById = new Map();
let raf = null, alpha = 0;
const view = { x: 0, y: 0, k: 1 }; // pan + zoom
let drag = null, hover = null, dragMoved = false;

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

export async function loadGraph(threshold, openHandler) {
  onOpen = openHandler;
  const data = await (await fetch(`/api/graph?threshold=${threshold}`)).json();
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
  alpha = 1;
  if (!raf) tick();
}

// --------------------------------------------------------------- simulation
function step() {
  const rect = canvas.getBoundingClientRect();
  const cx = rect.width / 2, cy = rect.height / 2;
  const REP = 5200, SPRING = 0.02, CENTER = 0.012, DAMP = 0.86;
  const rest = 90;

  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      let d2 = dx * dx + dy * dy || 0.01;
      const d = Math.sqrt(d2);
      const f = REP / d2;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
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
  alpha *= 0.985;
  if (alpha < 0.02) alpha = 0.02; // keep a gentle simmer
}

function draw() {
  const C = themeColors();
  const rect = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.save();
  ctx.translate(view.x, view.y);
  ctx.scale(view.k, view.k);

  // edges
  for (const e of edges) {
    const a = nodeById.get(e.source), b = nodeById.get(e.target);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = e.type === "user" ? C.user : C.ai;
    ctx.globalAlpha = e.type === "user" ? 0.6 : 0.3 + Math.min(0.5, (e.weight - 0.25));
    ctx.lineWidth = (e.type === "user" ? 1.6 : 1.0) / view.k;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // nodes
  for (const n of nodes) {
    const r = 4 + Math.sqrt(n.degree) * 2.4;
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fillStyle = n.hasVec ? C.node : C.nodeNoVec;
    if (hover === n) ctx.fillStyle = C.hover;
    ctx.fill();
    ctx.lineWidth = 1.5 / view.k;
    ctx.strokeStyle = C.bg;
    ctx.stroke();

    if (view.k > 0.55 || hover === n || n.degree > 2) {
      ctx.fillStyle = C.label;
      ctx.font = `${12 / view.k}px ${C.font}`;
      ctx.textAlign = "center";
      const label = n.title.length > 24 ? n.title.slice(0, 22) + "…" : n.title;
      ctx.fillText(label, n.x, n.y + r + 12 / view.k);
    }
  }
  ctx.restore();
}

function tick() {
  step();
  draw();
  raf = requestAnimationFrame(tick);
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
    if (n) drag = { node: n, ox: sx, oy: sy };
    else drag = { pan: true, ox: sx, oy: sy, vx: view.x, vy: view.y };
  });
  window.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    if (!drag) { hover = nodeAt(sx, sy); canvas.style.cursor = hover ? "pointer" : "grab"; return; }
    dragMoved = true;
    if (drag.pan) { view.x = drag.vx + (sx - drag.ox); view.y = drag.vy + (sy - drag.oy); }
    else { const p = screenToWorld(sx, sy); drag.node.x = p.x; drag.node.y = p.y; drag.node.vx = 0; drag.node.vy = 0; alpha = Math.max(alpha, 0.4); }
  });
  window.addEventListener("mouseup", (e) => {
    if (drag && drag.node && !dragMoved && onOpen) onOpen(drag.node.id);
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
  }, { passive: false });
}
