# CLAUDE.md

@AGENTS.md

## Claude Code specifics

- Bun lives at `~/.bun/bin` and may not be on PATH in fresh shells:
  `export BUN_INSTALL="$HOME/.bun" && export PATH="$BUN_INSTALL/bin:$PATH"`
- Run the web host locally with `bun run start` (default port 3000; override
  with `PORT=<n>`). Requires `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and
  `CLERK_PUBLISHABLE_KEY` in `.env` at the repo root (bun auto-loads it).
- Health check: `curl http://localhost:3000/healthz` — expect `{"ok":true}`.
- The embedding model (~30 MB, `Xenova/all-MiniLM-L6-v2`) downloads on first
  browser visit and is cached by the browser thereafter. It is not needed for
  any server-side work.
