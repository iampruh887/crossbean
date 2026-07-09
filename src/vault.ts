// One-way mirror of notes to human-readable markdown files on disk, so the
// vault stays portable (openable in any editor / Obsidian). SQLite remains the
// source of truth; these files are an export kept in sync on every save.

import { readdirSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { vaultDir } from "./paths";

const VAULT_DIR = vaultDir;

export function initVault() {
  if (!existsSync(VAULT_DIR)) mkdirSync(VAULT_DIR, { recursive: true });
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "untitled";

function existingFileFor(id: number): string | null {
  for (const f of readdirSync(VAULT_DIR)) {
    if (f.endsWith(`--${id}.md`)) return join(VAULT_DIR, f);
  }
  return null;
}

export async function writeNoteFile(id: number, title: string, body: string) {
  const old = existingFileFor(id);
  if (old) rmSync(old, { force: true });
  const path = join(VAULT_DIR, `${slug(title)}--${id}.md`);
  await Bun.write(path, body.startsWith("#") ? body : `# ${title}\n\n${body}`);
}

export function deleteNoteFile(id: number) {
  const old = existingFileFor(id);
  if (old) rmSync(old, { force: true });
}

// Extract [[wikilink]] targets from markdown body.
export function parseWikilinks(body: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const t = m[1].trim();
    if (t) out.push(t);
  }
  return out;
}
