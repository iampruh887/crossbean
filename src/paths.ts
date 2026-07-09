// Resolves where crossbean reads resources and writes data, in both dev mode
// (bun run, everything in the repo) and installed mode (compiled binary with
// ui/ and native libs shipped alongside, user data in the OS-conventional dir).

import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";

// True when running inside a `bun build --compile` binary — Bun mounts the
// bundled sources on a virtual filesystem ($bunfs / ~BUN on Windows).
export const isCompiled = (() => {
  const m = (Bun.main || "").replace(/\\/g, "/");
  return m.includes("/$bunfs/") || m.includes("~BUN");
})();

// Directory holding runtime resources (ui/, native libs):
// next to the executable when compiled, the repo root in dev.
export const resourceDir = isCompiled
  ? dirname(process.execPath)
  : resolve(import.meta.dir, "..");

export const uiDir = join(resourceDir, "ui");

// Per-user writable data (db + vault). OS-conventional when installed,
// the repo root in dev so a checkout keeps its local db.
function defaultDataDir(): string {
  if (!isCompiled) return resourceDir;
  const home = homedir();
  if (process.platform === "win32")
    return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "crossbean");
  if (process.platform === "darwin")
    return join(home, "Library", "Application Support", "crossbean");
  return join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), "crossbean");
}

export const dataDir = process.env.CROSSBEAN_DATA_DIR ?? defaultDataDir();
mkdirSync(dataDir, { recursive: true });

export const dbPath = join(dataDir, "crossbean.db");
export const vaultDir = join(dataDir, "vault");
// User-attached images (pasted / dropped / uploaded in the editor), served on
// the /files/ route. Kept out of the vault/ markdown mirror on purpose.
export const attachmentsDir = join(dataDir, "attachments");

// A native library shipped next to the executable, or null if absent
// (dev mode falls back to the npm package's copy).
export function bundledLib(name: string): string | null {
  const p = join(resourceDir, name);
  return existsSync(p) ? p : null;
}

export const libSuffix =
  process.platform === "win32" ? "dll" : process.platform === "darwin" ? "dylib" : "so";
