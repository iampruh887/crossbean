// crossbean — desktop entry point.
// The loopback engine runs on a Worker thread; this thread owns the native
// WebView2/WebKitGTK/WKWebView window. No browser is involved.

import { bundledLib } from "./src/paths";

// In installed mode the webview native lib ships next to the executable.
// webview-bun reads WEBVIEW_PATH at import time, so set it BEFORE the
// dynamic import below (a static import would hoist above this line).
const webviewLibName =
  process.platform === "win32"
    ? "libwebview.dll"
    : process.platform === "darwin"
      ? "libwebview.dylib"
      : `libwebview-${process.arch}.so`;
const webviewLib = bundledLib(webviewLibName);
if (webviewLib) process.env.WEBVIEW_PATH = webviewLib;

const { Webview } = await import("webview-bun");

// Start the engine on a worker thread — webview.run() blocks the main event
// loop, so a same-thread server would never answer the window's requests.
// The worker specifier differs between dev (repo layout) and a compiled
// binary (flattened bunfs), so try both.
function startEngine(): Promise<{ worker: Worker; port: number }> {
  // Plain relative specifiers resolve in both dev and compiled bunfs.
  // (Never use `new URL(...).href` here — it percent-encodes the compiled
  // binary's virtual `~BUN` root and breaks worker resolution.)
  const candidates = ["./src/server-worker.ts", "./server-worker.ts"];
  return new Promise((resolve, reject) => {
    const tryNext = (i: number) => {
      if (i >= candidates.length) return reject(new Error("engine worker failed to start"));
      const worker = new Worker(candidates[i]);
      const timer = setTimeout(() => {
        worker.terminate();
        tryNext(i + 1);
      }, 10000);
      worker.onmessage = (e: any) => {
        if (e.data?.type === "ready") {
          clearTimeout(timer);
          resolve({ worker, port: e.data.port });
        }
      };
      worker.onerror = () => {
        clearTimeout(timer);
        worker.terminate();
        tryNext(i + 1);
      };
    };
    tryNext(0);
  });
}

const { worker, port } = await startEngine();
const url = `http://127.0.0.1:${port}/`;
console.log(`[crossbean] engine on ${url}`);

// The embedding model is cached by the OS webview in its per-host profile
// (e.g. %APPDATA%\crossbean.exe\EBWebView on Windows) — downloads once,
// relaunches are offline and instant.
const webview = new Webview(false, { width: 1280, height: 820, hint: 0 /* NONE */ });
webview.title = "crossbean";
webview.navigate(url);
webview.run(); // blocks until the window is closed

worker.terminate();
console.log("[crossbean] closed");
process.exit(0);
