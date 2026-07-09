// Runs the sentence-embedding model (all-MiniLM-L6-v2) off the UI thread.
// Transformers.js uses WebAssembly ONNX in the browser/WebView2 — no native deps.
// The model (~30MB, quantized) downloads once and is cached by the webview.

import {
  pipeline,
  env,
} from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5/+esm";

env.allowLocalModels = false;
env.useBrowserCache = true;

let extractor = null;
let loading = null;

async function getExtractor() {
  if (extractor) return extractor;
  if (!loading) {
    loading = pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      progress_callback: (p) => {
        if (p.status === "progress" && p.file && p.file.endsWith(".onnx")) {
          self.postMessage({ type: "loading", progress: Math.round(p.progress || 0) });
        }
      },
    }).then((e) => {
      extractor = e;
      self.postMessage({ type: "ready" });
      return e;
    });
  }
  return loading;
}

self.onmessage = async (ev) => {
  const { type, id, text } = ev.data;
  if (type === "warmup") {
    try {
      await getExtractor();
    } catch (e) {
      self.postMessage({ type: "error", id, error: String(e?.message || e) });
    }
    return;
  }
  if (type === "embed") {
    try {
      const ex = await getExtractor();
      const out = await ex(text && text.trim() ? text : " ", { pooling: "mean", normalize: true });
      self.postMessage({ type: "vector", id, vector: Array.from(out.data) });
    } catch (e) {
      self.postMessage({ type: "error", id, error: String(e?.message || e) });
    }
  }
};

// Kick off model download immediately.
getExtractor();
