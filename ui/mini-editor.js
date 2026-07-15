// mini-editor.js — floating mini-window manager.
//
// NO module-level mutable singletons: all state lives in the closure returned
// by initMiniEditors(), so re-init is always safe and multiple independent
// instances can coexist without fighting each other.
//
// Factory export:
//   initMiniEditors(hostEl, { noteLoader, renderMarkdown, onExpand } = {}) ->
//     {
//       openMini(spec),       // spec: { id, vault, title, matchStart, matchEnd }
//       focus(uid),
//       minimize(uid),
//       restore(uid),
//       close(uid),
//       destroyAll(),
//       serialize(),
//       openFromSaved(spec),
//       setConnections(list), // list: [{ a: noteId, b: noteId, sim: 0..1 }]
//     }
//
// Drag uses pointer-capture on the titlebar element so it NEVER fights
// window-level mousemove handlers (e.g. the graph-pan listener in graph.js).
//
// CSS vars are read from :root[data-theme] — no hardcoded colors.
// Per-window z-index lives in the 150–199 band.
// The #miniLayer and #miniTabBar are appended to document.body so the
// :root[data-theme] cascade applies even when #editorView is hidden.
//
// Side-by-side auto-layout:
//   relayout() tiles all floating windows left-to-right, wrapping to a new
//   row when they would exceed the viewport width.  It is called after
//   openMini, close, and restore.  A user who drags a window can move it
//   freely; relayout() does NOT run during drag.
//
// Connection lines:
//   setConnections(list) stores pairs { a, b, sim }.  An SVG overlay
//   (#miniConnSvg, pointer-events:none) is inserted into #miniLayer *before*
//   the first window so it sits below all windows in paint order.  Lines are
//   redrawn on open/close/minimize/restore and during drag (onPointerMove).

export function initMiniEditors(hostEl, { noteLoader, renderMarkdown, onExpand } = {}) {
  // ---- closure-scoped state --------------------------------------------------
  /** @type {Array<{uid:string,noteId:string,vault:string,title:string,el:HTMLElement,tabEl:HTMLElement|null,state:"floating"|"minimized",x:number,y:number,w:number,h:number,z:number,matchStart:number|null,matchEnd:number|null}>} */
  const windows = [];
  let zTop = 150;  // monotonically increasing; each focus raises to ++zTop (cap at 199 then wrap)
  let uidSeq = 0;

  /** @type {Array<{a:string,b:string,sim:number}>} */
  let connections = [];

  // ---- lazy layer creation ---------------------------------------------------
  // Both layers are appended to document.body (NOT inside #editorView) so the
  // :root[data-theme] vars cascade regardless of which tab is active.
  let layer = null;    // #miniLayer  — floating cards live here
  let tabBar = null;   // #miniTabBar — minimized chip strip
  let connSvg = null;  // <svg id="miniConnSvg"> — connection-line overlay

  function ensureLayers() {
    if (layer) return;

    layer = document.createElement("div");
    layer.id = "miniLayer";
    document.body.appendChild(layer);

    // SVG overlay goes into #miniLayer FIRST — painted before .mini-window
    // elements so lines appear below windows.  pointer-events:none lets all
    // mouse/touch events pass straight through to the windows.
    connSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    connSvg.id = "miniConnSvg";
    connSvg.style.cssText =
      "position:fixed;inset:0;width:100%;height:100%;" +
      "pointer-events:none;overflow:visible;z-index:150;";
    layer.appendChild(connSvg);

    tabBar = document.createElement("div");
    tabBar.id = "miniTabBar";
    document.body.appendChild(tabBar);
  }

  // ---- z-index allocation ----------------------------------------------------
  function nextZ() {
    zTop++;
    // Stay inside the 150–199 band; wrap around when we hit the ceiling.
    if (zTop > 199) zTop = 151;
    return zTop;
  }

  // ---- find a window record --------------------------------------------------
  function findWin(uid) {
    return windows.find((w) => w.uid === uid) ?? null;
  }

  // ---- find a window by noteId (for connection line lookup) -----------------
  function findWinByNoteId(noteId) {
    // Return the most recently opened floating window for a given noteId.
    // Array.find returns the FIRST (oldest) match, so walk backwards to get the
    // LAST (most recent).  (Multiple windows for the same note are unusual but
    // legal.)
    for (let i = windows.length - 1; i >= 0; i--) {
      const w = windows[i];
      if (w.noteId === noteId && w.state === "floating") return w;
    }
    return null;
  }

  // ---- apply z to element ----------------------------------------------------
  function applyZ(win) {
    if (win.el) win.el.style.zIndex = String(win.z);
  }

  // ---- focus -----------------------------------------------------------------
  function focus(uid) {
    const win = findWin(uid);
    if (!win) return;
    win.z = nextZ();
    applyZ(win);
  }

  // ---- minimize --------------------------------------------------------------
  function minimize(uid) {
    const win = findWin(uid);
    if (!win || win.state === "minimized") return;
    win.state = "minimized";
    win.el.style.display = "none";

    // Create a tab chip in the bottom bar.
    const tab = document.createElement("button");
    tab.className = "mini-tab";
    tab.textContent = win.title.length > 22 ? win.title.slice(0, 21) + "…" : win.title;
    tab.title = win.title;
    tab.addEventListener("click", () => restore(uid));
    tabBar.appendChild(tab);
    win.tabEl = tab;

    drawConnections();
  }

  // ---- restore ---------------------------------------------------------------
  function restore(uid) {
    const win = findWin(uid);
    if (!win) return;
    win.state = "floating";
    win.el.style.display = "";

    if (win.tabEl) {
      win.tabEl.remove();
      win.tabEl = null;
    }

    focus(uid);
    relayout();
    drawConnections();
  }

  // ---- close -----------------------------------------------------------------
  function close(uid) {
    const idx = windows.findIndex((w) => w.uid === uid);
    if (idx === -1) return;
    const [win] = windows.splice(idx, 1);
    win.el.remove();
    if (win.tabEl) win.tabEl.remove();
    relayout();
    drawConnections();
  }

  // ---- side-by-side auto-layout ---------------------------------------------
  // Tiles all *floating* windows in left-to-right rows.  Windows that are
  // minimized are skipped.  Called after openMini, close, and restore.
  // Drag moves a window freely; relayout() is not called during drag.
  function relayout() {
    const floaters = windows.filter((w) => w.state === "floating");
    if (floaters.length === 0) return;

    const GAP    = 14;   // px gap between windows
    const TOP    = 60;   // px from viewport top
    const LEFT   = 60;   // px from viewport left
    const vw     = window.innerWidth;

    let rowX = LEFT;
    let rowY = TOP;
    let rowH = 0;  // tallest window in the current row

    for (const win of floaters) {
      // If this window would run past the right edge, wrap to a new row.
      if (rowX + win.w > vw - GAP && rowX > LEFT) {
        rowX  = LEFT;
        rowY += rowH + GAP;
        rowH  = 0;
      }

      win.x = rowX;
      win.y = rowY;
      win.el.style.left = win.x + "px";
      win.el.style.top  = win.y + "px";

      rowX += win.w + GAP;
      if (win.h > rowH) rowH = win.h;
    }
  }

  // ---- connection-line overlay -----------------------------------------------
  // Reads the live CSS var --ai-link from the root element so the color
  // follows the active theme without any extra JS.
  function getLineColor() {
    return getComputedStyle(document.documentElement)
      .getPropertyValue("--ai-link").trim() || "#a06b2e";
  }

  // Returns the center point of a window element's bounding rect.
  function winCenter(win) {
    const rect = win.el.getBoundingClientRect();
    return {
      x: rect.left + rect.width  / 2,
      y: rect.top  + rect.height / 2,
      rect,
    };
  }

  // Compute the point on the nearest edge of the bounding rect closest to
  // the other center — so lines connect at the window border, not the middle.
  function edgePoint(rect, toX, toY) {
    const cx = rect.left + rect.width  / 2;
    const cy = rect.top  + rect.height / 2;
    const dx = toX - cx;
    const dy = toY - cy;
    if (dx === 0 && dy === 0) return { x: cx, y: cy };

    // Clip the direction vector against the rectangle half-extents.
    const hw = rect.width  / 2;
    const hh = rect.height / 2;
    const scaleX = hw / Math.abs(dx);
    const scaleY = hh / Math.abs(dy);
    const scale  = Math.min(scaleX, scaleY);

    return {
      x: cx + dx * scale,
      y: cy + dy * scale,
    };
  }

  function drawConnections() {
    if (!connSvg) return;

    // Clear previous lines/labels.
    while (connSvg.firstChild) connSvg.removeChild(connSvg.firstChild);

    if (connections.length === 0) return;

    const lineColor = getLineColor();

    for (const conn of connections) {
      const winA = findWinByNoteId(conn.a);
      const winB = findWinByNoteId(conn.b);

      // Only draw when BOTH notes are floating (not minimized / closed).
      if (!winA || !winB) continue;

      const cA = winCenter(winA);
      const cB = winCenter(winB);

      const pA = edgePoint(cA.rect, cB.x, cB.y);
      const pB = edgePoint(cB.rect, cA.x, cA.y);

      // Mid-point for the label.
      const mx = (pA.x + pB.x) / 2;
      const my = (pA.y + pB.y) / 2;

      // Draw line.
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(pA.x));
      line.setAttribute("y1", String(pA.y));
      line.setAttribute("x2", String(pB.x));
      line.setAttribute("y2", String(pB.y));
      line.setAttribute("stroke", lineColor);
      line.setAttribute("stroke-width", "2.5");
      line.setAttribute("stroke-linecap", "round");
      // Small dash to distinguish from wikilink edges in the main graph.
      line.setAttribute("stroke-dasharray", "6 3");
      connSvg.appendChild(line);

      // Similarity label.
      const pct = Math.round(conn.sim * 100) + "%";

      // Background pill for readability.
      const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      const bgW = pct.length * 7.5 + 8;
      const bgH = 16;
      bg.setAttribute("x",      String(mx - bgW / 2));
      bg.setAttribute("y",      String(my - bgH / 2));
      bg.setAttribute("width",  String(bgW));
      bg.setAttribute("height", String(bgH));
      bg.setAttribute("rx",     "3");
      bg.setAttribute("fill",   lineColor);
      bg.setAttribute("opacity","0.85");
      connSvg.appendChild(bg);

      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("x",           String(mx));
      label.setAttribute("y",           String(my + 5));
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("font-size",   "11");
      label.setAttribute("font-weight", "700");
      label.setAttribute("font-family", "var(--font-mono, monospace)");
      label.setAttribute("fill",        "#ffffff");
      label.textContent = pct;
      connSvg.appendChild(label);
    }
  }

  // ---- public: setConnections -----------------------------------------------
  /**
   * Supply a list of similarity connections between note IDs.  The overlay
   * immediately redraws to show lines for any pairs that are currently open
   * as floating windows.
   *
   * @param {Array<{a:string, b:string, sim:number}>} list
   */
  function setConnections(list) {
    connections = Array.isArray(list) ? list : [];
    drawConnections();
  }

  // ---- drag: pointer-capture on titlebar ------------------------------------
  // Uses pointer events + setPointerCapture so drag is fully scoped to the
  // titlebar element and never interferes with window-level mousemove handlers.
  function bindDrag(win, titlebarEl) {
    let startX = 0, startY = 0, origX = 0, origY = 0;

    function onPointerDown(e) {
      // Ignore clicks on the action buttons inside the titlebar.
      if (e.target.closest(".mini-btn")) return;
      e.preventDefault();
      titlebarEl.setPointerCapture(e.pointerId);
      startX = e.clientX;
      startY = e.clientY;
      origX  = win.x;
      origY  = win.y;
      focus(win.uid);
    }

    function onPointerMove(e) {
      if (!titlebarEl.hasPointerCapture(e.pointerId)) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      win.x = origX + dx;
      win.y = origY + dy;
      // Clamp so the titlebar can't escape the viewport.
      const vw = window.innerWidth, vh = window.innerHeight;
      win.x = Math.max(-win.w + 80, Math.min(vw - 80, win.x));
      win.y = Math.max(0, Math.min(vh - 40, win.y));
      win.el.style.left = win.x + "px";
      win.el.style.top  = win.y + "px";
      // Redraw connection lines to follow the moved window.
      drawConnections();
    }

    function onPointerUp(e) {
      titlebarEl.releasePointerCapture(e.pointerId);
    }

    titlebarEl.addEventListener("pointerdown", onPointerDown);
    titlebarEl.addEventListener("pointermove", onPointerMove);
    titlebarEl.addEventListener("pointerup",   onPointerUp);
    titlebarEl.addEventListener("pointercancel", onPointerUp);
  }

  // ---- build a floating card -------------------------------------------------
  async function openMini(spec) {
    const { id, vault = "", title = "(untitled)", matchStart = null, matchEnd = null } = spec ?? {};

    ensureLayers();

    // Dedup: if a FLOATING window already exists for this note, don't open a
    // duplicate — raise the existing one to the front, re-tile, and redraw the
    // connection lines, then hand it straight back.
    const existing = findWinByNoteId(id);
    if (existing) {
      existing.z = nextZ();
      applyZ(existing);
      relayout();
      drawConnections();
      return existing;
    }

    const uid = `mini-${++uidSeq}`;

    // Default size — relayout() will position the window after insertion.
    const w = 360;
    const h = 280;
    const z = nextZ();

    // Temporary position; relayout() overrides this immediately below.
    const x = 80;
    const y = 60;

    // ---- DOM structure -------------------------------------------------------
    const el = document.createElement("div");
    el.className = "mini-window";
    el.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;z-index:${z};`;

    // Titlebar
    const titlebar = document.createElement("div");
    titlebar.className = "mini-titlebar";

    const titleSpan = document.createElement("span");
    titleSpan.className = "mini-title";
    titleSpan.textContent = title.length > 30 ? title.slice(0, 29) + "…" : title;
    titleSpan.title = title;

    const btnMin = document.createElement("button");
    btnMin.className = "mini-btn mini-btn-min";
    btnMin.textContent = "−";  // minus sign
    btnMin.title = "Minimize";
    btnMin.addEventListener("click", () => minimize(uid));

    const btnExp = document.createElement("button");
    btnExp.className = "mini-btn mini-btn-exp";
    btnExp.textContent = "↗";  // north-east arrow
    btnExp.title = "Open in editor";
    btnExp.addEventListener("click", () => {
      if (typeof onExpand === "function") {
        onExpand({ id: win.noteId, vault: win.vault, matchStart: win.matchStart, matchEnd: win.matchEnd });
      }
      close(uid);
    });

    const btnClose = document.createElement("button");
    btnClose.className = "mini-btn mini-btn-close";
    btnClose.textContent = "×";  // multiplication sign (×)
    btnClose.title = "Close";
    btnClose.addEventListener("click", () => close(uid));

    titlebar.appendChild(titleSpan);
    titlebar.appendChild(btnMin);
    titlebar.appendChild(btnExp);
    titlebar.appendChild(btnClose);

    // Body
    const bodyEl = document.createElement("div");
    bodyEl.className = "mini-body";

    // Placeholder while content loads (or when no noteLoader is supplied).
    const placeholder = document.createElement("p");
    placeholder.className = "mini-placeholder";
    placeholder.textContent = title;
    bodyEl.appendChild(placeholder);

    el.appendChild(titlebar);
    el.appendChild(bodyEl);
    layer.appendChild(el);

    // Raise on any click inside the window.
    el.addEventListener("pointerdown", () => focus(uid), { capture: true });

    // ---- record ---------------------------------------------------------------
    const win = { uid, noteId: id, vault, title, el, tabEl: null, state: "floating", x, y, w, h, z, matchStart, matchEnd };
    windows.push(win);

    bindDrag(win, titlebar);

    // Apply side-by-side layout to all floating windows now that this one is
    // in the list, then redraw connection lines.
    relayout();
    drawConnections();

    // ---- content load ---------------------------------------------------------
    if (typeof noteLoader === "function") {
      try {
        const note = await noteLoader(id);
        bodyEl.innerHTML = "";  // clear placeholder
        if (typeof renderMarkdown === "function") {
          renderMarkdown(bodyEl, note.body ?? "");
        } else {
          // Fallback: plain-text.
          const pre = document.createElement("pre");
          pre.style.cssText = "margin:0;white-space:pre-wrap;word-break:break-word;font-size:13px;";
          pre.textContent = note.body ?? "";
          bodyEl.appendChild(pre);
        }
        // Update title if the note carries one.
        if (note.title && note.title !== title) {
          win.title = note.title;
          titleSpan.textContent = note.title.length > 30 ? note.title.slice(0, 29) + "…" : note.title;
          titleSpan.title = note.title;
        }
        // If matchStart/matchEnd were supplied, scroll to the relevant chunk.
        if (matchStart != null) {
          // A best-effort scroll: find text near the match offset in the rendered HTML.
          // We schedule a rAF so the browser has laid out the content first.
          requestAnimationFrame(() => scrollToMatch(bodyEl, note.body ?? "", matchStart));
        }
      } catch (err) {
        bodyEl.innerHTML = "";
        const errEl = document.createElement("p");
        errEl.className = "mini-placeholder mini-error";
        errEl.textContent = "Could not load note: " + (err?.message ?? String(err));
        bodyEl.appendChild(errEl);
      }
    }
    // If no noteLoader: placeholder with title is already in bodyEl — good for mock data.

    return win;
  }

  // ---- scroll to a match in rendered content ---------------------------------
  // charOffset is an index into the RAW markdown source, but the rendered HTML
  // has markdown syntax (#, **, [](), [[ ]], …) stripped, so raw offsets don't
  // line up with rendered text-node offsets.  Instead we take a short phrase
  // from the raw text at the offset, strip its formatting, and search the
  // rendered text for that phrase — then scroll the match into view.
  function scrollToMatch(containerEl, rawText, charOffset) {
    if (!rawText || charOffset == null) return;

    // Scroll a DOM Range so its match sits near the top of the container.
    function scrollRangeIntoView(range) {
      const rect = range.getBoundingClientRect();
      const contRect = containerEl.getBoundingClientRect();
      if (rect.top < contRect.top || rect.bottom > contRect.bottom) {
        const relTop = rect.top - contRect.top + containerEl.scrollTop - 8;
        containerEl.scrollTo({ top: relTop, behavior: "smooth" });
      }
    }

    // Proportional fallback: scroll to roughly where the offset falls.
    function scrollByProportion() {
      const frac = Math.max(0, Math.min(1, charOffset / rawText.length));
      containerEl.scrollTo({ top: frac * containerEl.scrollHeight, behavior: "smooth" });
    }

    // Build a plain-word search phrase from the raw markdown at the offset.
    const snippet = rawText.slice(charOffset, charOffset + 80);
    const plain = snippet
      .replace(/!?\[\[([^\]|]*)(?:\|[^\]]*)?\]\]/g, "$1")  // [[wikilink]] / [[a|b]] -> a
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")           // [text](url) -> text
      .replace(/[#*_`>~]/g, "")                             // markdown punctuation
      .replace(/\s+/g, " ")
      .trim();
    const phrase = plain.split(" ").filter(Boolean).slice(0, 6).join(" ");

    if (phrase.length >= 3) {
      // Accumulate rendered text across nodes so a phrase spanning several text
      // nodes still matches; remember each node's start position to build a Range.
      const walker = document.createTreeWalker(containerEl, NodeFilter.SHOW_TEXT);
      const segments = [];  // { node, start } — start = index into `haystack`
      let haystack = "";
      let node;
      while ((node = walker.nextNode())) {
        segments.push({ node, start: haystack.length });
        haystack += node.textContent;
      }

      const hit = haystack.toLowerCase().indexOf(phrase.toLowerCase());
      if (hit !== -1) {
        // Find the text node (and local offset) containing `hit`.
        for (let i = 0; i < segments.length; i++) {
          const seg = segments[i];
          const end = seg.start + seg.node.length;
          if (hit < end) {
            const range = document.createRange();
            range.setStart(seg.node, hit - seg.start);
            range.collapse(true);
            scrollRangeIntoView(range);
            return;
          }
        }
      }
    }

    // Phrase not found (or too short) — approximate by proportion.
    scrollByProportion();
  }

  // ---- destroyAll ------------------------------------------------------------
  function destroyAll() {
    // Splice out and remove each window.
    while (windows.length) {
      const win = windows.pop();
      win.el.remove();
      if (win.tabEl) win.tabEl.remove();
    }
    connections = [];
    // Remove the layer elements themselves so a future re-init starts clean.
    if (layer)  { layer.remove();  layer  = null; }
    if (tabBar) { tabBar.remove(); tabBar = null; }
    connSvg = null;
    zTop   = 150;
    uidSeq = 0;
  }

  // ---- serialize -------------------------------------------------------------
  // Returns a plain-object array suitable for JSON serialisation, one entry per
  // currently open (or minimized) window.  The shape matches the `spec` accepted
  // by openFromSaved() so callers can round-trip without knowing internals.
  function serialize() {
    return windows.map((win) => ({
      noteId: win.noteId,
      vault:  win.vault,
      title:  win.title,
      x: win.x, y: win.y, w: win.w, h: win.h,
      state: win.state,
      matchStart: win.matchStart,
      matchEnd:   win.matchEnd,
    }));
  }

  // ---- openFromSaved ---------------------------------------------------------
  // Re-open a window from a serialised spec (e.g. from localStorage).
  // Returns the same Promise<win> as openMini so callers can await and catch.
  async function openFromSaved(spec) {
    const { noteId, vault, title, x, y, w, h, state: savedState, matchStart, matchEnd } = spec ?? {};
    const win = await openMini({ id: noteId, vault, title, matchStart, matchEnd });

    // Restore position + size from the saved spec if they look reasonable.
    // (relayout() already ran inside openMini; override its result if the
    // saved positions are valid so previously-saved layouts are honoured.)
    if (typeof x === "number" && typeof y === "number") {
      win.x = x; win.y = y;
      win.el.style.left = x + "px";
      win.el.style.top  = y + "px";
    }
    if (typeof w === "number" && typeof h === "number") {
      win.w = w; win.h = h;
      win.el.style.width  = w + "px";
      win.el.style.height = h + "px";
    }
    if (savedState === "minimized") minimize(win.uid);

    return win;
  }

  // ---- public API ------------------------------------------------------------
  return {
    /**
     * Open a new floating mini-window.
     * @param {{ id:string, vault?:string, title?:string, matchStart?:number, matchEnd?:number }} spec
     * @returns {Promise<object>} the window record
     */
    openMini,
    /**
     * Bring a window to the front.
     * @param {string} uid
     */
    focus,
    /**
     * Hide the window and add a chip to the bottom tab bar.
     * @param {string} uid
     */
    minimize,
    /**
     * Restore a minimized window and bring it to the front.
     * @param {string} uid
     */
    restore,
    /**
     * Remove the window from the DOM and the windows array.
     * @param {string} uid
     */
    close,
    /**
     * Remove all windows and both layer elements; safe to call before re-init.
     */
    destroyAll,
    /**
     * Return a serialisable snapshot of all open windows (for localStorage).
     * @returns {Array<{noteId, vault, title, x, y, w, h, state, matchStart, matchEnd}>}
     */
    serialize,
    /**
     * Re-open a window from a saved spec (round-trip with serialize()).
     * @param {object} spec
     * @returns {Promise<object>} the window record
     */
    openFromSaved,
    /**
     * Supply similarity connections to draw as overlay lines between open windows.
     * Only pairs where BOTH note IDs are currently open as floating (non-minimized)
     * windows are drawn.  Lines redraw automatically on open/close/minimize/restore
     * and during drag.
     *
     * Overlay: an <svg id="miniConnSvg"> is inserted into #miniLayer as its first
     * child (below all .mini-window elements in paint order) with
     * pointer-events:none so it never blocks window interaction.  The line color
     * is read from the CSS var --ai-link on :root, matching the active theme.
     *
     * @param {Array<{a:string, b:string, sim:number}>} list
     *   a, b  — note IDs (must match the `id` passed to openMini)
     *   sim   — cosine similarity 0..1; displayed as Math.round(sim*100)+"%"
     */
    setConnections,
  };
}
