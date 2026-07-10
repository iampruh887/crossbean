# crossbean web

Multi-user crossbean in the browser: **Clerk** handles identity (sign-in/up UI,
verification emails, sessions — and social login/MFA if you enable them), and
**Supabase** holds the data (Postgres + pgvector + storage) secured by
Row-Level Security keyed on the Clerk user id. This directory only contains a
thin static host for the shared `ui/`; there is no application server.

Shared vaults: every user gets a personal vault on first login, and any vault
owner can invite other registered users by email as **editor** or **viewer**.

## One-time setup (~10 minutes)

### 1. Supabase — database

1. Create a project at [database.new](https://database.new) (free tier is fine).
2. *SQL Editor* → paste each file from
   [`supabase/migrations/`](../supabase/migrations) **in order** (0001 → 0006),
   running each one. 0006 switches identity to Clerk — don't skip it.
3. *Settings → API*: copy the **Project URL** and **publishable** key
   (`sb_publishable_...`).

### 2. Clerk — identity

1. Create an application at [dashboard.clerk.com](https://dashboard.clerk.com)
   (free tier is fine). Enable **Email** (and anything else you want — Google,
   GitHub…).
2. Open the **Supabase integration**:
   [dashboard.clerk.com/setup/supabase](https://dashboard.clerk.com/setup/supabase)
   → select your instance → **Activate Supabase integration** → copy the
   **Clerk domain** it shows.
3. Back in **Supabase**: *Authentication → Sign In / Providers* →
   **Add provider → Clerk** → paste that Clerk domain.
4. *Clerk → API Keys*: copy the **Publishable key** (`pk_test_...`).

### 3. Environment

Put all three values in `.env` at the repo root (bun auto-loads it; the file
is gitignored):

```sh
SUPABASE_URL=https://<your-ref>.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
CLERK_PUBLISHABLE_KEY=pk_test_...
```

All three are publishable/public by design — RLS is the security boundary.

## Run it

```sh
bun run web
```

Open http://localhost:3000 — Clerk's sign-in screen gates the app. Sign up,
and a "Personal" vault is created for you automatically. Deploy the same
command on any host (a $5 VPS, Fly, Railway…) behind HTTPS.

## OCR ("Scan text") — optional

The editor's **✍️ Scan text** button turns a photo of handwriting or print into
note text. It runs in the `ocr` Supabase edge function, which calls a hosted
vision model on the Hugging Face Inference router (the HF token stays
server-side). To enable it:

1. Get a free token at [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens)
   (a **read** / fine-grained token with Inference access is enough).
2. Set the function secret and deploy (needs the [Supabase CLI](https://supabase.com/docs/guides/local-development)):
   ```sh
   supabase link --project-ref <your-ref>
   supabase secrets set HF_TOKEN=hf_xxx
   supabase functions deploy ocr --no-verify-jwt
   ```
   `--no-verify-jwt` is required: Clerk tokens aren't signed by the Supabase
   project secret, so the function verifies the Clerk session itself (against
   Clerk's JWKS) rather than at the gateway.
3. (Optional) pick a different model:
   `supabase secrets set OCR_MODEL=Qwen/Qwen2.5-VL-72B-Instruct`
   (default is `Qwen/Qwen3-VL-30B-A3B-Instruct`).

If the token/function aren't set up, the button just reports the error — the
rest of the app is unaffected. OCR is web-only (the desktop app has no token).

## Notes & trade-offs

- **Embeddings still run in the browser** (Transformers.js worker) — the model
  (~30 MB) downloads once per browser and is cached. No GPU or AI keys needed.
- **Invites need a known email**: you can only invite people who have signed
  in at least once (their email registers in `profiles` on first login).
- **Attachments are public-read**: image URLs are unguessable (UUIDs) but not
  access-controlled — anyone with an exact URL can view that image. Don't paste
  secrets as screenshots into shared vaults.
- **The desktop app is unchanged** and fully local. There is no sync between
  desktop and web (yet) — they are separate stores.
