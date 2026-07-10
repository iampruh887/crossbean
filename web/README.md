# crossbean web

Multi-user crossbean in the browser: Supabase handles auth, data (Postgres +
pgvector), and image storage — secured by Row-Level Security. This directory
only contains a thin static host for the shared `ui/`; there is no application
server to operate.

Shared vaults: every user gets a personal vault on signup, and any vault owner
can invite other registered users by email as **editor** or **viewer**.

## One-time Supabase setup (~5 minutes)

1. **Create a project** at [database.new](https://database.new) (free tier is fine).
   Any org/region. Pick a strong database password and store it somewhere safe.

2. **Run the migrations.** In the dashboard: *SQL Editor* → paste each file from
   [`supabase/migrations/`](../supabase/migrations) **in order** (0001 → 0005),
   running each one:
   - `0001_core_schema.sql` — tables + pgvector index
   - `0002_rls.sql` — row-level security (the security model)
   - `0003_rpcs.sql` — vault management, semantic search, graph
   - `0004_storage.sql` — image attachments bucket
   - `0005_signup_trigger.sql` — personal vault for every new user

   (Or, with the Supabase CLI: `supabase link --project-ref <ref> && supabase db push`.)

3. **Get your keys.** *Settings → API*: copy the **Project URL** and the
   **publishable** key (`sb_publishable_...`; the legacy `anon` key also works).
   Both are safe to expose to browsers — RLS is the security boundary, not the key.

4. **(Recommended) Auth settings.** *Authentication → Sign In / Up*: leave
   "Confirm email" ON so only real mailboxes can register.

## Run it

```sh
SUPABASE_URL=https://<your-ref>.supabase.co \
SUPABASE_PUBLISHABLE_KEY=sb_publishable_... \
bun run web
```

Open http://localhost:3000, sign up, and you're in. Deploy the same command on
any host (a $5 VPS, Fly, Railway…) behind HTTPS — or serve `ui/` from any
static host, hardcoding a `config.js` with the same two values.

## Notes & trade-offs

- **Embeddings still run in the browser** (Transformers.js worker) — the model
  (~30 MB) downloads once per browser and is cached. No GPU or AI keys needed.
- **Attachments are public-read**: image URLs are unguessable (UUIDs) but not
  access-controlled — anyone with an exact URL can view that image. Don't paste
  secrets as screenshots into shared vaults.
- **The desktop app is unchanged** and fully local. There is no sync between
  desktop and web (yet) — they are separate stores.
