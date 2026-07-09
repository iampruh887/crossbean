// Update check against GitHub Releases. crossbean ships as per-platform
// installers (.exe / .dmg / .deb / .rpm), so "update" means: detect a newer
// published release and point the user at the right download. We never hot-swap
// the running binary — the user installs the update through their normal
// installer, which is the safe, signed path on every OS.

import pkg from "../package.json";

export const APP_VERSION: string = pkg.version;
export const REPO = "iampruh887/crossbean";

// "v1.2.3" / "1.2.3-beta" -> [1,2,3]. Non-numeric/pre-release tags degrade to
// their numeric prefix, which is fine for a "is a newer release out" check.
export function parseVer(v: string): number[] {
  return String(v)
    .replace(/^v/i, "")
    .split(/[.\-+]/)
    .map((n) => parseInt(n, 10))
    .filter((n) => !Number.isNaN(n));
}

export function isNewer(latest: string, current: string): boolean {
  const a = parseVer(latest);
  const b = parseVer(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

interface Asset {
  name: string;
  browser_download_url: string;
}

// Best download URL for the running OS/arch, or null if we can't pick one
// unambiguously (Linux deb-vs-rpm) — the caller falls back to the release page.
export function pickAsset(
  assets: Asset[],
  plat: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string | null {
  const find = (re: RegExp) => assets.find((a) => re.test(a.name))?.browser_download_url ?? null;
  if (plat === "win32") return find(/setup.*\.exe$/i) ?? find(/\.exe$/i);
  if (plat === "darwin") return find(new RegExp(`${arch}.*\\.dmg$`, "i")) ?? find(/\.dmg$/i);
  return null; // linux: .deb vs .rpm is the user's choice
}

export interface UpdateInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  downloadUrl: string | null;
  notes: string;
  error?: string;
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  const base: UpdateInfo = {
    current: APP_VERSION,
    latest: null,
    updateAvailable: false,
    releaseUrl: null,
    downloadUrl: null,
    notes: "",
  };
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { "user-agent": "crossbean", accept: "application/vnd.github+json" },
    });
    if (!r.ok) return { ...base, error: `github ${r.status}` };
    const rel = (await r.json()) as any;
    const latest: string | null = rel.tag_name ?? null;
    return {
      current: APP_VERSION,
      latest,
      updateAvailable: latest ? isNewer(latest, APP_VERSION) : false,
      releaseUrl: rel.html_url ?? null,
      downloadUrl: pickAsset(rel.assets ?? []) ?? rel.html_url ?? null,
      notes: typeof rel.body === "string" ? rel.body : "",
    };
  } catch (e) {
    return { ...base, error: (e as Error).message };
  }
}
