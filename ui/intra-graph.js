// intra-graph.js — lightweight canvas renderer for intra-document chunk graphs.
//
// NO module-level mutable singletons — all state lives on the instance returned
// by createIntraGraph(), so multiple instances can coexist without conflicting
// with ui/graph.js or with each other.
//
// Factory export:
//   createIntraGraph(canvas, { onNodeClick }) ->
//     { setData(nodes, edges), highlight(nodeId|null), resize(), destroy() }
//
// Node shape expected from buildIntraGraph():  { id, text, start, end }
// Edge shape:                                  { source, target, weight }
//
// Colors are read from CSS variables per frame (same var names as graph.js)
// so the canvas updates instantly when the theme toggles.

export function createIntraGraph(canvas, { onNodeClick } = {}) {
  // ---- all mutable state is local to this closure ---------------------------
  let ctx = canvas.getContext("2d");

  let nodes = [];      // layout nodes: { id, text, start, end, x, y, vx, vy }
  let edges = [];      // { source, target, weight }
  let nodeById = new Map();

  let highlightId = null;
  let hoverNode = null;
  let raf = null;
  let alpha = 0;       // physics energy, decays to idle
  let drag = null;     // { node, ox, oy } | null
  let dragMoved = false;

  // ---- CSS variable reader (same pattern as graph.js themeColors) -----------
  function themeColors() {
    const s = getComputedStyle(document.documentElement);
    const v = (n) => s.getPropertyValue(n).trim();
    return {
      node:    v("--g-node"),
      nodeDim: v("--g-node-dim"),
      label:   v("--g-label"),
      bg:      v("--g-bg"),
      accent:  v("--accent-2"),
      aiLink:  v("--ai-link"),
      border:  v("--border"),
      font:    v("--g-font") || "sans-serif",
    };
  }

  // ---- DPR-aware resize (mirrors resizeGraph in graph.js) ------------------
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    canvas.width  = rect.width  * dpr;
    canvas.height = rect.height * dpr;
    ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Preserve node positions across a resize — re-scattering makes the graph
    // jump on every pane-drag (initPreviewSplit calls resize() per mousemove).
    // A gentle kick lets gravity re-centre the nodes in the new viewport.
    if (nodes.length > 0) kick(0.2);
    else redraw();
  }

  // ---- data -----------------------------------------------------------------
  function setData(newNodes, newEdges) {
    const rect = canvas.getBoundingClientRect();
    const cx = (rect.width  || 300) / 2;
    const cy = (rect.height || 200) / 2;

    const prev = nodeById;
    nodeById = new Map();

    nodes = newNodes.map((n, i) => {
      const old = prev.get(n.id);
      const angle = (i / Math.max(1, newNodes.length)) * Math.PI * 2;
      const node = {
        ...n,
        x:  old ? old.x : cx + Math.cos(angle) * 100 + (Math.random() - 0.5) * 30,
        y:  old ? old.y : cy + Math.sin(angle) * 100 + (Math.random() - 0.5) * 30,
        vx: 0,
        vy: 0,
      };
      nodeById.set(n.id, node);
      return node;
    });

    edges = (newEdges || []).filter(
      (e) => nodeById.has(e.source) && nodeById.has(e.target)
    );

    alpha = 1;
    ensureRunning();
  }

  // ---- highlight ------------------------------------------------------------
  function highlight(nodeId) {
    highlightId = nodeId ?? null;
    redraw();
  }

  // ---- physics --------------------------------------------------------------
  // Simple force layout tuned for small N (tens of nodes).
  // Mirrors the repulsion + spring + centering pattern in graph.js step().
  function step() {
    const rect = canvas.getBoundingClientRect();
    const cx = rect.width  / 2;
    const cy = rect.height / 2;

    const REP    = 2800;   // node-node repulsion constant
    const SPRING = 0.025;  // edge spring factor
    const CENTER = 0.018;  // gravity toward canvas centre
    const DAMP   = 0.82;   // velocity damping

    // Pairwise repulsion (O(n²) — fine for small N).
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d2 = dx * dx + dy * dy || 0.01;
        const d  = Math.sqrt(d2);
        const f  = REP / d2;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
    }

    // Edge springs.
    const REST = 80; // resting edge length (pixels)
    for (const e of edges) {
      const a = nodeById.get(e.source);
      const b = nodeById.get(e.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d  = Math.sqrt(dx * dx + dy * dy) || 0.01;
      // Stronger weight → tighter spring.
      const str = SPRING * (0.6 + e.weight * 0.8);
      const f   = (d - REST) * str;
      const fx  = (dx / d) * f;
      const fy  = (dy / d) * f;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }

    // Gravity + dampen + integrate.
    for (const n of nodes) {
      n.vx += (cx - n.x) * CENTER;
      n.vy += (cy - n.y) * CENTER;
      if (drag && drag.node === n) continue;
      n.vx *= DAMP; n.vy *= DAMP;
      n.x  += n.vx * alpha;
      n.y  += n.vy * alpha;
    }

    alpha *= 0.985; // decay energy — same rate as graph.js
  }

  // ---- drawing --------------------------------------------------------------
  const NODE_R   = 18;  // base node radius (rounded rect half-height)
  const NODE_W   = 80;  // base node width (rounded rect half-width)
  const LABEL_MAX = 24; // max chars in truncated label

  function draw() {
    const C    = themeColors();
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    ctx.clearRect(0, 0, rect.width, rect.height);

    // Edges (drawn under nodes).
    for (const e of edges) {
      const a = nodeById.get(e.source);
      const b = nodeById.get(e.target);
      if (!a || !b) continue;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      // Opacity is proportional to edge weight (same convention as graph.js AI edges).
      ctx.globalAlpha = 0.15 + Math.min(0.7, e.weight * 0.9);
      ctx.strokeStyle = C.aiLink;
      ctx.lineWidth   = 1.2;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Nodes (rounded rects with truncated labels).
    for (const n of nodes) {
      const isHighlight = n.id === highlightId;
      const isHover     = n === hoverNode;

      const fillColor = isHighlight ? C.accent : (isHover ? C.accent : C.node);
      const textColor = isHighlight ? C.bg      : (isHover ? C.bg     : C.bg);

      const label = n.text.trim().slice(0, LABEL_MAX).replace(/\s+/g, " ");
      const display = label.length < n.text.trim().length ? label.slice(0, LABEL_MAX - 1) + "…" : label;

      ctx.font = `12px ${C.font}`;
      const textW = ctx.measureText(display).width;
      const hw = Math.max(NODE_W, textW / 2 + 12); // half-width
      const hh = NODE_R;                             // half-height

      // Rounded rect.
      const x = n.x - hw, y = n.y - hh, w = hw * 2, h = hh * 2;
      const r = 5;
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(x, y, w, h, r);
      } else {
        // Fallback for environments without roundRect.
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.arcTo(x + w, y,     x + w, y + r,     r);
        ctx.lineTo(x + w, y + h - r);
        ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
        ctx.lineTo(x + r, y + h);
        ctx.arcTo(x,     y + h, x, y + h - r,     r);
        ctx.lineTo(x,     y + r);
        ctx.arcTo(x,     y,     x + r, y,          r);
        ctx.closePath();
      }
      ctx.fillStyle = fillColor;
      ctx.fill();
      // Subtle stroke to help dark themes.
      ctx.lineWidth   = isHighlight || isHover ? 2 : 1;
      ctx.strokeStyle = isHighlight || isHover ? C.accent : C.border;
      ctx.stroke();

      // Label.
      ctx.fillStyle    = textColor;
      ctx.textAlign    = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(display, n.x, n.y);
      ctx.textBaseline = "alphabetic";
    }
  }

  function tick() {
    step();
    draw();
    // Stop once settled and nothing is being dragged — no idle CPU burn.
    if (alpha <= 0.03 && !drag) { raf = null; return; }
    raf = requestAnimationFrame(tick);
  }

  function ensureRunning() {
    if (!raf) raf = requestAnimationFrame(tick);
  }

  function kick(a = 0.5) {
    alpha = Math.max(alpha, a);
    ensureRunning();
  }

  // One static redraw without re-energising physics.
  function redraw() {
    if (!raf) draw();
  }

  // ---- hit-test -------------------------------------------------------------
  function nodeAt(sx, sy) {
    // Test in reverse draw order so topmost node wins.
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n  = nodes[i];
      const hw = NODE_W + 12; // generous hit area
      const hh = NODE_R + 4;
      if (Math.abs(sx - n.x) <= hw && Math.abs(sy - n.y) <= hh) return n;
    }
    return null;
  }

  // ---- interaction ----------------------------------------------------------
  function onMouseDown(e) {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const n  = nodeAt(sx, sy);
    dragMoved = false;
    if (n) {
      drag = { node: n, ox: sx, oy: sy };
      kick(0.4);
    }
  }

  function onMouseMove(e) {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    if (!drag) {
      const prev = hoverNode;
      hoverNode = nodeAt(sx, sy);
      canvas.style.cursor = hoverNode ? "pointer" : "default";
      if (hoverNode !== prev) redraw();
      return;
    }
    dragMoved = true;
    drag.node.x  = sx;
    drag.node.y  = sy;
    drag.node.vx = 0;
    drag.node.vy = 0;
    kick(0.4);
  }

  function onMouseUp() {
    if (drag && drag.node && !dragMoved && onNodeClick) {
      const { id, text, start, end } = drag.node;
      onNodeClick({ id, text, start, end });
    }
    drag = null;
  }

  // Attach listeners to the canvas (not window, to stay scoped to this instance).
  canvas.addEventListener("mousedown", onMouseDown);
  canvas.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("mouseup",   onMouseUp);

  // ---- public API -----------------------------------------------------------
  function destroy() {
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    canvas.removeEventListener("mousedown", onMouseDown);
    canvas.removeEventListener("mousemove", onMouseMove);
    canvas.removeEventListener("mouseup",   onMouseUp);
    nodes = []; edges = []; nodeById = new Map();
  }

  // Initial size pass.
  resize();

  return { setData, highlight, resize, destroy };
}
