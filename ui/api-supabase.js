// Web adapter: Clerk (identity) + Supabase (data). Clerk's prebuilt UI handles
// sign-in/up and issues JWTs; supabase-js sends them on every request via the
// accessToken hook, and Postgres RLS authorizes rows against the Clerk user id
// (auth.jwt()->>'sub' — see supabase/migrations/0006_clerk_auth.sql).
// Embeddings are still computed in the browser worker.

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const VAULT_KEY = "cb-current-vault";

const snippetOf = (body) =>
  (body || "").replace(/[#*_`>\-\[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);

const toMeta = (r) => ({
  id: r.id,
  title: r.title,
  updated: Date.parse(r.updated_at),
  snippet: snippetOf(r.body),
  hasVec: Array.isArray(r.note_embeddings) ? r.note_embeddings.length > 0 : !!r.note_embeddings,
  grp: r.grp ?? null,
});

const WIKILINK_RE = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
const parseWikilinks = (body) =>
  [...(body || "").matchAll(WIKILINK_RE)].map((m) => m[1].trim()).filter(Boolean);

// Load Clerk's browser bundles from the app's own Clerk domain (encoded in the
// publishable key) and return the ready Clerk instance.
async function loadClerk(publishableKey) {
  const domain = atob(publishableKey.split("_")[2]).slice(0, -1);
  const script = (src, attrs = {}) =>
    new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.crossOrigin = "anonymous";
      for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
      s.onload = resolve;
      s.onerror = () => reject(new Error(`failed to load ${src}`));
      document.head.appendChild(s);
    });
  await script(`https://${domain}/npm/@clerk/ui@1/dist/ui.browser.js`);
  await script(`https://${domain}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, {
    "data-clerk-publishable-key": publishableKey,
  });
  const clerk = window.Clerk;
  await clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
  return clerk;
}

export async function createApi(config) {
  if (!config.clerkPublishableKey) {
    throw new Error("missing CLERK_PUBLISHABLE_KEY — see web/README.md");
  }
  const clerk = await loadClerk(config.clerkPublishableKey);
  const sb = createClient(config.supabaseUrl, config.supabaseKey, {
    async accessToken() {
      return (await clerk.session?.getToken()) ?? null;
    },
  });
  let vaultId = localStorage.getItem(VAULT_KEY) || null;

  const NOTE_COLS = "id,title,body,grp,updated_at,note_embeddings(note_id)";

  function need(res) {
    if (res.error) throw new Error(res.error.message);
    return res.data;
  }

  // Make the signed-in user discoverable for invite-by-email.
  async function upsertProfile() {
    const email = clerk.user?.primaryEmailAddress?.emailAddress;
    if (!email) return;
    await sb.from("profiles").upsert({ user_id: clerk.user.id, email });
  }

  // Re-derive the [[wikilink]] edge rows for one note within its vault.
  async function syncLinks(id, body) {
    const titles = parseWikilinks(body);
    await sb.from("links").delete().eq("src", id);
    if (!titles.length) return;
    const rows = need(await sb.from("notes").select("id,title").eq("vault_id", vaultId));
    const byTitle = new Map(rows.map((r) => [r.title.toLowerCase(), r.id]));
    const dsts = [...new Set(titles.map((t) => byTitle.get(t.toLowerCase())).filter((d) => d && d !== id))];
    if (dsts.length) {
      await sb.from("links").insert(dsts.map((dst) => ({ src: id, dst })));
    }
  }

  async function noteMetas() {
    const rows = need(
      await sb.from("notes").select(NOTE_COLS).eq("vault_id", vaultId).order("updated_at", { ascending: false })
    );
    return rows.map(toMeta);
  }

  return {
    platform: "web",

    // ---- auth (Clerk) ----
    async init() {
      if (clerk.user) await upsertProfile();
      return { authed: !!clerk.user, email: clerk.user?.primaryEmailAddress?.emailAddress ?? null };
    },
    // Mount Clerk's sign-in UI into el; resolves once the user is signed in.
    mountAuth(el) {
      clerk.mountSignIn(el);
      return new Promise((resolve) => {
        const off = clerk.addListener(({ user }) => {
          if (user) {
            off();
            clerk.unmountSignIn(el);
            upsertProfile().then(resolve, resolve);
          }
        });
      });
    },
    async signOut() { await clerk.signOut(); },

    // ---- vaults ----
    // NOTE: does NOT auto-create. Personal-vault creation is done once, in
    // boot(), so repeated vaults() calls (e.g. after switching) can never race
    // into duplicate "Personal" vaults.
    async vaults() {
      const rows = need(await sb.from("vaults").select("id,name,owner_id").order("created_at"));
      const me = clerk.user?.id;
      const list = rows.map((v) => ({ ...v, mine: v.owner_id === me }));
      // keep vaultId pointing at a vault the user actually belongs to
      if (!list.some((v) => v.id === vaultId)) vaultId = list[0]?.id ?? null;
      if (vaultId) localStorage.setItem(VAULT_KEY, vaultId);
      else localStorage.removeItem(VAULT_KEY);
      return list;
    },
    currentVault() { return vaultId; },
    async setVault(id) { vaultId = id; localStorage.setItem(VAULT_KEY, id); },
    async createVault(name) {
      const id = need(await sb.rpc("create_vault", { p_name: name }));
      await this.setVault(id);
      return id;
    },
    async members(vault = vaultId) {
      return need(await sb.rpc("list_vault_members", { p_vault: vault }));
    },
    async invite(email, role, vault = vaultId) {
      need(await sb.rpc("invite_to_vault", { p_vault: vault, p_email: email, p_role: role }));
    },
    async removeMember(userId, vault = vaultId) {
      need(await sb.from("vault_members").delete().match({ vault_id: vault, user_id: userId }));
    },

    // ---- notes ----
    async notes() { return vaultId ? noteMetas() : []; },
    async note(id) {
      // scope by vault_id too: never load a note from another of the user's vaults
      const r = need(await sb.from("notes").select(NOTE_COLS).eq("id", id).eq("vault_id", vaultId).single());
      return { ...toMeta(r), body: r.body };
    },
    async create(title, body, grp = "") {
      const r = need(
        await sb.from("notes")
          .insert({ vault_id: vaultId, title: title || "Untitled", body: body || "", grp: grp.trim() || null })
          .select("id").single()
      );
      await syncLinks(r.id, body);
      return { id: r.id };
    },
    async update(id, title, body, grp = "") {
      need(
        await sb.from("notes")
          .update({ title: title || "Untitled", body: body || "", grp: (grp || "").trim() || null })
          .eq("id", id).eq("vault_id", vaultId).select("id")
      );
      await syncLinks(id, body);
      return { ok: true };
    },
    async remove(id) {
      need(await sb.from("notes").delete().eq("id", id).eq("vault_id", vaultId).select("id"));
      return { ok: true };
    },

    // ---- vectors / graph ----
    async storeEmbed(id, vector) {
      need(await sb.from("note_embeddings").upsert({ note_id: id, embedding: JSON.stringify(vector) }).select("note_id"));
      return { ok: true };
    },
    async search(vector, k = 20) {
      const hits = need(await sb.rpc("match_notes", { p_vault: vaultId, p_query: JSON.stringify(vector), p_k: k }));
      const byId = new Map((await noteMetas()).map((n) => [n.id, n]));
      return hits.map((h) => ({ ...byId.get(h.id), sim: h.sim })).filter((r) => r.id != null);
    },
    async suggest(id) {
      const hits = need(await sb.rpc("suggest_notes", { p_note: id, p_k: 6 }));
      const byId = new Map((await noteMetas()).map((n) => [n.id, n]));
      return hits.map((h) => ({ ...byId.get(h.id), sim: h.sim })).filter((r) => r.id != null);
    },
    // Shared helper: normalize an RPC {nodes,edges[,vaults]} payload to the
    // shape graph.js wants (node.degree/hasVec[/vault] + edge.weight).
    _normalizeGraph(g) {
      const edges = (g.edges || []).map((e) => ({
        source: e.source, target: e.target, type: e.type,
        weight: e.type === "user" ? 1 : (e.sim ?? 0.3),
      }));
      const deg = new Map();
      for (const e of edges) {
        deg.set(e.source, (deg.get(e.source) || 0) + 1);
        deg.set(e.target, (deg.get(e.target) || 0) + 1);
      }
      const nodes = (g.nodes || []).map((n) => ({
        id: n.id, title: n.title, vault: n.vault, degree: deg.get(n.id) || 0, hasVec: true,
      }));
      return { nodes, edges, vaults: g.vaults || [] };
    },
    async graph(threshold) {
      return this._normalizeGraph(need(await sb.rpc("vault_graph", { p_vault: vaultId, p_threshold: threshold, p_neighbors: 6 })));
    },
    // Multi-vault: every vault the user belongs to, as colored clusters.
    async userGraph(threshold) {
      const res = await sb.rpc("user_graph", { p_threshold: threshold, p_neighbors: 6 });
      if (res.error) {
        // migration 0007 not applied yet → fall back to the active vault's graph
        if (/user_graph|schema cache|PGRST202|function/i.test(res.error.message || "")) return this.graph(threshold);
        throw new Error(res.error.message);
      }
      return this._normalizeGraph(res.data);
    },

    // ---- misc ----
    async upload(file) {
      const ext = (file.name?.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
      const path = `${vaultId}/${crypto.randomUUID()}.${ext}`;
      need(await sb.storage.from("attachments").upload(path, file, { contentType: file.type }));
      return sb.storage.from("attachments").getPublicUrl(path).data.publicUrl;
    },
    // Handwriting/print OCR via the `ocr` edge function (which calls a hosted
    // vision model). supabase-js attaches the Clerk session token for us.
    async ocr(file) {
      const image = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = () => rej(new Error("could not read image"));
        r.readAsDataURL(file);
      });
      // attach the Clerk session token explicitly so the function's JWKS check passes
      const token = await clerk.session?.getToken();
      if (!token) throw new Error("not signed in (no Clerk session token)");
      const { data, error } = await sb.functions.invoke("ocr", {
        body: { image },
        headers: { Authorization: `Bearer ${token}` },
      });
      if (error) {
        // functions.invoke hides the body behind a generic message — dig it out
        let msg = error.message || "OCR request failed";
        try {
          const body = await error.context?.json?.();
          if (body?.error) msg = body.error;
        } catch { /* body not JSON */ }
        throw new Error(msg);
      }
      if (data?.error) throw new Error(data.error);
      return data?.text ?? "";
    },
    ocrAvailable: true,

    async health() { return { ok: true, vec: true }; },
    async version() { return { version: "web", repo: "" }; },
    async updateCheck() { return { updateAvailable: false }; },
  };
}
