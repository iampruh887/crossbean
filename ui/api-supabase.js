// Web adapter: Supabase (auth + Postgres/pgvector + storage). Multi-user with
// shared vaults. Authorization is enforced by RLS in the database — this file
// only shapes requests. Embeddings are still computed in the browser worker.

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

export function createApi(config) {
  const sb = createClient(config.supabaseUrl, config.supabaseKey);
  let vaultId = localStorage.getItem(VAULT_KEY) || null;

  const NOTE_COLS = "id,title,body,grp,updated_at,note_embeddings(note_id)";

  function need(res) {
    if (res.error) throw new Error(res.error.message);
    return res.data;
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

    // ---- auth ----
    async init() {
      const { data } = await sb.auth.getSession();
      return { authed: !!data.session, email: data.session?.user?.email ?? null };
    },
    async signIn(email, password) {
      need(await sb.auth.signInWithPassword({ email, password }));
    },
    async signUp(email, password) {
      const data = need(await sb.auth.signUp({ email, password }));
      // Depending on project settings, signup may require email confirmation.
      return { needsConfirm: !data.session };
    },
    async signOut() { await sb.auth.signOut(); },

    // ---- vaults ----
    async vaults() {
      const rows = need(await sb.from("vaults").select("id,name,owner_id").order("created_at"));
      const { data } = await sb.auth.getUser();
      const me = data.user?.id;
      const list = rows.map((v) => ({ ...v, mine: v.owner_id === me }));
      // ensure the remembered vault still exists; else default to the first
      if (!list.some((v) => v.id === vaultId)) vaultId = list[0]?.id ?? null;
      if (vaultId) localStorage.setItem(VAULT_KEY, vaultId);
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
      const r = need(await sb.from("notes").select(NOTE_COLS).eq("id", id).single());
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
          .eq("id", id).select("id")
      );
      await syncLinks(id, body);
      return { ok: true };
    },
    async remove(id) {
      need(await sb.from("notes").delete().eq("id", id).select("id"));
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
    async graph(threshold) {
      return need(await sb.rpc("vault_graph", { p_vault: vaultId, p_threshold: threshold, p_neighbors: 6 }));
    },

    // ---- misc ----
    async upload(file) {
      const ext = (file.name?.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
      const path = `${vaultId}/${crypto.randomUUID()}.${ext}`;
      need(await sb.storage.from("attachments").upload(path, file, { contentType: file.type }));
      return sb.storage.from("attachments").getPublicUrl(path).data.publicUrl;
    },
    async health() { return { ok: true, vec: true }; },
    async version() { return { version: "web", repo: "" }; },
    async updateCheck() { return { updateAvailable: false }; },
  };
}
