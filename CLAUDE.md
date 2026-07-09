# CLAUDE.md

@AGENTS.md

## Claude Code specifics

- Bun lives at `~/.bun/bin` and may not be on PATH in fresh shells:
  `export BUN_INSTALL="$HOME/.bun" && export PATH="$BUN_INSTALL/bin:$PATH"`
- The app opens a real window; launch it with `run_in_background` and find its
  port with:
  `powershell -Command "(Get-NetTCPConnection -State Listen -OwningProcess (Get-Process bun).Id | ? LocalAddress -eq '127.0.0.1').LocalPort"`
  then `curl http://127.0.0.1:<port>/api/health` — expect `{"ok":true,"vec":true}`.
  `vec:false` means sqlite-vec failed to load; check stdout for the reason.
- To stop app instances:
  `powershell -Command "Get-Process bun,crossbean,msedgewebview2 -EA SilentlyContinue | Stop-Process -Force"`
- The embedding model (~30 MB) downloads on first window launch and caches in
  the WebView2 profile (`%APPDATA%\bun.exe\EBWebView` in dev, `crossbean.exe`
  host dir when compiled). Headless tests never need it.
