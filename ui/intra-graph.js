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

  // ---- tooltip div (created as a sibling of the canvas) --------------------
  const tooltip = document.createElement("div");
  Object.assign(tooltip.style, {
    position:      "absolute",
    pointerEvents: "none",
    zIndex:        "10",
    maxWidth:      "220px",
    padding:       "5px 9px",
    borderRadius:  "4px",
    fontSize:      "11.5px",
    lineHeight:    "1.45",
    whiteSpace:    "pre-wrap",
    wordBreak:     "break-word",
    display:       "none",
    // Colors will be set per-frame to follow the theme.
  });
  // Insert relative to the canvas's parent so absolute coords align.
  const canvasParent = canvas.parentElement;
  if (canvasParent) {
    // Parent must be position:relative/absolute for our absolute positioning.
    const parentPos = getComputedStyle(canvasParent).position;
    if (parentPos === "static") canvasParent.style.position = "relative";
    canvasParent.appendChild(tooltip);
  }

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
      text:    v("--text"),
      panel:   v("--panel"),
      font:    v("--g-font") || "sans-serif",
    };
  }

  // ---- per-node color derived from id (golden-angle hue distribution) ------
  // Uses hsl() so it looks good on both themes.
  // Lightness is fixed at 52% — vivid enough on paper (light bg) and terminal
  // (dark bg). Saturation at 62% avoids both washed-out and garish.
  function nodeColor(id, alpha = 1) {
    const hue = (id * 137.508) % 360;
    return `hsla(${hue.toFixed(1)}, 62%, 52%, ${alpha})`;
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
  // Nodes are small circles — no text inside.
  // NODE_R: base radius in CSS pixels (device-independent).
  const NODE_R = 10; // circle radius
  // HIT_SLOP: extra px around the circle for easier clicking/hovering.
  const HIT_SLOP = 5;

  function draw() {
    const C    = themeColors();
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    ctx.clearRect(0, 0, rect.width, rect.height);

    // ---- Edges (drawn under nodes) -----------------------------------------
    // Edge color: --ai-link; opacity: at least 0.40, scaled by weight.
    // lineWidth: 2.0 CSS px (clear and readable on any background).
    for (const e of edges) {
      const a = nodeById.get(e.source);
      const b = nodeById.get(e.target);
      if (!a || !b) continue;

      const opacity = Math.min(0.90, 0.45 + e.weight * 0.5);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.globalAlpha = opacity;
      ctx.strokeStyle = C.aiLink;
      ctx.lineWidth   = 2.0;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // ---- Nodes (circles with per-node hue) ----------------------------------
    for (const n of nodes) {
      const isHighlight = n.id === highlightId;
      const isHover     = n === hoverNode;

      const fillColor   = nodeColor(n.id, 1.0);
      const borderColor = C.border;
      const accentColor = C.accent;

      // Main circle fill.
      ctx.beginPath();
      ctx.arc(n.x, n.y, NODE_R, 0, Math.PI * 2);
      ctx.fillStyle = fillColor;
      ctx.fill();

      // Subtle border ring (1px, theme border color).
      ctx.lineWidth   = 1;
      ctx.strokeStyle = borderColor;
      ctx.stroke();

      // Accent ring for highlighted or hovered node.
      if (isHighlight || isHover) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, NODE_R + 3, 0, Math.PI * 2);
        ctx.lineWidth   = isHighlight ? 2.5 : 1.5;
        ctx.strokeStyle = accentColor;
        ctx.stroke();
      }
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

  // ---- tooltip management --------------------------------------------------
  function showTooltip(n, mouseX, mouseY) {
    const C = themeColors();
    // Truncate text to ~80 chars for readability.
    const raw  = (n.text || "").trim().replace(/\s+/g, " ");
    const text = raw.length > 80 ? raw.slice(0, 79) + "…" : raw;
    tooltip.textContent = text;

    // Style to match current theme.
    Object.assign(tooltip.style, {
      background:  C.panel  || "#efebe0",
      color:       C.text   || "#1a1812",
      border:      `1px solid ${C.border || "#e3ded0"}`,
      fontFamily:  C.font,
      display:     "block",
    });

    // Position near the cursor, offset so it doesn't obscure the node.
    // Use the canvas's bounding rect relative to the parent to convert
    // mouse coords (already canvas-local) to parent-local coords.
    const canvasRect  = canvas.getBoundingClientRect();
    const parentRect  = canvasParent ? canvasParent.getBoundingClientRect() : canvasRect;
    const localX = (canvasRect.left - parentRect.left) + mouseX + 14;
    const localY = (canvasRect.top  - parentRect.top)  + mouseY - 8;

    tooltip.style.left = localX + "px";
    tooltip.style.top  = localY + "px";
  }

  function hideTooltip() {
    tooltip.style.display = "none";
  }

  // ---- hit-test -------------------------------------------------------------
  function nodeAt(sx, sy) {
    // Test in reverse draw order so topmost node wins.
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n  = nodes[i];
      const dx = sx - n.x;
      const dy = sy - n.y;
      if (dx * dx + dy * dy <= (NODE_R + HIT_SLOP) * (NODE_R + HIT_SLOP)) return n;
    }
    return null;
  }

  // ---- interaction ----------------------------------------------------------
  // Track last known mouse position for tooltip repositioning.
  let lastMouseX = 0;
  let lastMouseY = 0;

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
    lastMouseX = sx;
    lastMouseY = sy;

    if (!drag) {
      const prev = hoverNode;
      hoverNode = nodeAt(sx, sy);
      canvas.style.cursor = hoverNode ? "pointer" : "default";
      if (hoverNode !== prev) redraw();

      // Update tooltip.
      if (hoverNode) {
        showTooltip(hoverNode, sx, sy);
      } else {
        hideTooltip();
      }
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

  function onMouseLeave() {
    hoverNode = null;
    hideTooltip();
    redraw();
  }

  // Attach listeners to the canvas (not window, to stay scoped to this instance).
  canvas.addEventListener("mousedown",  onMouseDown);
  canvas.addEventListener("mousemove",  onMouseMove);
  canvas.addEventListener("mouseup",    onMouseUp);
  canvas.addEventListener("mouseleave", onMouseLeave);

  // ---- public API -----------------------------------------------------------
  function destroy() {
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    canvas.removeEventListener("mousedown",  onMouseDown);
    canvas.removeEventListener("mousemove",  onMouseMove);
    canvas.removeEventListener("mouseup",    onMouseUp);
    canvas.removeEventListener("mouseleave", onMouseLeave);
    // Remove the tooltip div from the DOM.
    if (tooltip.parentElement) tooltip.parentElement.removeChild(tooltip);
    nodes = []; edges = []; nodeById = new Map();
  }

  // Initial size pass.
  resize();

  return { setData, highlight, resize, destroy };
}
