// Runs the loopback engine on its own thread. The main thread's webview.run()
// is a blocking native call, so the HTTP server must live off-thread or it can
// never answer the window's requests (the two would deadlock in one event loop).

import { startServer } from "./server";

const server = startServer();
// @ts-ignore - worker global
postMessage({ type: "ready", port: server.port });
// The server keeps this worker's event loop alive; nothing else to do.
