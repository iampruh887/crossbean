// Builds a distributable folder for the CURRENT platform:
//   dist/crossbean-<os>-<arch>/
//     crossbean(.exe)      compiled binary (bun build --compile)
//     ui/                  frontend assets
//     libwebview.*         native webview library
//     vec0.*               sqlite-vec extension
//
// Native libs are per-platform npm packages, so each OS builds its own
// release (see .github/workflows/release.yml for the CI matrix).

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const plat = process.platform; // win32 | linux | darwin
const arch = process.arch; // x64 | arm64
const osName = plat === "win32" ? "windows" : plat === "darwin" ? "macos" : "linux";
const binName = plat === "win32" ? "crossbean.exe" : "crossbean";
const outDir = join("dist", `crossbean-${osName}-${arch}`);

console.log(`building ${outDir} ...`);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// 1. compile — the server worker must be a second entrypoint so it's bundled
await $`bun build --compile ./main.ts ./src/server-worker.ts --outfile ${join(outDir, binName)}`;

// 2. frontend assets
cpSync("ui", join(outDir, "ui"), { recursive: true });

// 3. webview native lib
const webviewLib =
  plat === "win32"
    ? "libwebview.dll"
    : plat === "darwin"
      ? "libwebview.dylib"
      : `libwebview-${arch}.so`;
cpSync(join("node_modules", "webview-bun", "build", webviewLib), join(outDir, webviewLib));

// 4. sqlite-vec extension
const vecPkg = `sqlite-vec-${plat === "win32" ? "windows" : plat}-${arch}`;
const vecLib = plat === "win32" ? "vec0.dll" : plat === "darwin" ? "vec0.dylib" : "vec0.so";
const vecSrc = join("node_modules", vecPkg, vecLib);
if (!existsSync(vecSrc)) {
  console.error(`missing ${vecSrc} — is ${vecPkg} installed for this platform?`);
  process.exit(1);
}
cpSync(vecSrc, join(outDir, vecLib));

console.log(`done: ${outDir}`);
