// crossbean OCR edge function.
// Takes a data-URI image, asks a hosted vision model (HF Inference router) to
// transcribe it, returns the text. Handwriting or print. The HF token stays
// here (a Supabase secret) — never in the browser.
//
// Deploy WITHOUT gateway JWT verification (Clerk tokens aren't signed by the
// Supabase project secret, so the gateway would reject them); we verify the
// Clerk session ourselves below against Clerk's JWKS.
//
//   supabase functions deploy ocr --no-verify-jwt
//   supabase secrets set HF_TOKEN=hf_xxx
//
// Optional secret: OCR_MODEL (defaults to Qwen3-VL-30B).

import { createRemoteJWKSet, jwtVerify } from "https://deno.land/x/jose@v5.9.6/index.ts";

const HF_TOKEN = Deno.env.get("HF_TOKEN") ?? "";
const OCR_MODEL = Deno.env.get("OCR_MODEL") ?? "Qwen/Qwen3-VL-30B-A3B-Instruct";
const HF_URL = "https://router.huggingface.co/v1/chat/completions";
const OCR_PROMPT =
  "Transcribe all text in this image exactly as written, preserving line breaks " +
  "and layout. This may be handwriting. Output only the transcribed text — no " +
  "commentary, no markdown fences.";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

// Verify the caller's Clerk session token against its issuer's JWKS.
const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
async function isAuthed(req: Request): Promise<boolean> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    const iss: string | undefined = payload.iss;
    if (!iss || !/^https:\/\/[^/]+$/.test(iss)) return false;
    if (!jwksByIssuer.has(iss)) {
      jwksByIssuer.set(iss, createRemoteJWKSet(new URL(`${iss}/.well-known/jwks.json`)));
    }
    await jwtVerify(token, jwksByIssuer.get(iss)!, { issuer: iss });
    return true;
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!HF_TOKEN) return json({ error: "server missing HF_TOKEN" }, 500);
  if (!(await isAuthed(req))) return json({ error: "unauthorized" }, 401);

  try {
    const { image, prompt } = await req.json();
    if (typeof image !== "string" || !image.startsWith("data:image/")) {
      return json({ error: "expected a data:image/* URL in `image`" }, 400);
    }
    const res = await fetch(HF_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${HF_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: OCR_MODEL,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt || OCR_PROMPT },
              { type: "image_url", image_url: { url: image } },
            ],
          },
        ],
        max_tokens: 4096,
        temperature: 0,
      }),
    });
    const data = await res.json();
    if (!res.ok) return json({ error: data?.error?.message ?? `HF error ${res.status}` }, 502);
    const text = data?.choices?.[0]?.message?.content ?? "";
    return json({ text: String(text).trim(), model: OCR_MODEL });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
