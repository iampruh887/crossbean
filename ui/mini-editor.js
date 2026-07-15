// mini-editor.js — floating mini-window manager.
//
// NO module-level mutable singletons: all state lives in the closure returned
// by initMiniEditors(), so re-init is always safe and multiple independent
// instances can coexist without fighting each other.
//
// Factory export:
//   initMiniEditors(hostEl, { noteLoader, renderMarkdown, onExpand } = {}) ->
//     {
//       openMini(spec),   // spec: { id, vault, title, matchStart, matchEnd }
//       focus(uid),
//       minimize(uid),
//       restore(uid),
//       close(uid),
//       destroyAll(),
//     }
//
// Drag uses pointer-capture on the titlebar element so it NEVER fights
// window-level mousemove handlers (e.g. the graph-pan listener in graph.js).
//
// CSS vars are read from :root[data-theme] — no hardcoded colors.
// Per-window z-index lives in the 150–199 band.
// The #miniLayer and #miniTabBar are appended to document.body so the
// :root[data-theme] cascade applies even when #editorView is hidden.

export function initMiniEditors(hostEl, { noteLoader, renderMarkdown, onExpand } = {}) {
  // ---- closure-scoped state --------------------------------------------------
  /** @type {Array<{uid:string,noteId:string,vault:string,title:string,el:HTMLElement,tabEl:HTMLElement|null,state:"floating"|"minimized",x:number,y:number,w:number,h:number,z:number,matchStart:number|null,matchEnd:number|null}>} */
  const windows = [];
  let zTop = 150;  // monotonically increasing; each focus raises to ++zTop (cap at 199 then wrap)
  let uidSeq = 0;

  // ---- lazy layer creation ---------------------------------------------------
  // Both layers are appended to document.body (NOT inside #editorView) so the
  // :root[data-theme] vars cascade regardless of which tab is active.
  let layer = null;    // #miniLayer  — floating cards live here
  let tabBar = null;   // #miniTabBar — minimized chip strip

  function ensureLayers() {
    if (layer) return;

    layer = document.createElement("div");
    layer.id = "miniLayer";
    document.body.appendChild(layer);

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
  }

  // ---- close -----------------------------------------------------------------
  function close(uid) {
    const idx = windows.findIndex((w) => w.uid === uid);
    if (idx === -1) return;
    const [win] = windows.splice(idx, 1);
    win.el.remove();
    if (win.tabEl) win.tabEl.remove();
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

    const uid = `mini-${++uidSeq}`;

    // Default position: cascade from the top-left, offset by window index.
    const offset = (windows.length % 8) * 24;
    const x = 80 + offset;
    const y = 60 + offset;
    const w = 360;
    const h = 280;
    const z = nextZ();

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

  // ---- scroll to character offset in rendered content ------------------------
  // Walks text nodes to find the one containing the matchStart offset, then
  // scrolls that node into view inside the mini-body scroll container.
  function scrollToMatch(containerEl, rawText, charOffset) {
    if (!rawText || charOffset == null) return;
    let walked = 0;
    const walker = document.createTreeWalker(containerEl, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (walked + node.length >= charOffset) {
        // This text node contains the target offset.
        const range = document.createRange();
        const localOffset = Math.min(charOffset - walked, node.length);
        range.setStart(node, localOffset);
        range.collapse(true);
        const rect = range.getBoundingClientRect();
        const contRect = containerEl.getBoundingClientRect();
        if (rect.top < contRect.top || rect.bottom > contRect.bottom) {
          // Scroll the element (not window) so the match is near the top.
          const relTop = rect.top - contRect.top + containerEl.scrollTop - 8;
          containerEl.scrollTo({ top: relTop, behavior: "smooth" });
        }
        return;
      }
      walked += node.length;
    }
  }

  // ---- destroyAll ------------------------------------------------------------
  function destroyAll() {
    // Splice out and remove each window.
    while (windows.length) {
      const win = windows.pop();
      win.el.remove();
      if (win.tabEl) win.tabEl.remove();
    }
    // Remove the layer elements themselves so a future re-init starts clean.
    if (layer)  { layer.remove();  layer  = null; }
    if (tabBar) { tabBar.remove(); tabBar = null; }
    zTop   = 150;
    uidSeq = 0;
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
  };
}
