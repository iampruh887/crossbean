// Desktop adapter: talks to the loopback Bun engine over HTTP.
// Single implicit vault; auth and sharing are not applicable locally.

const json = () => ({ "content-type": "application/json" });

export function createApi() {
  return {
    platform: "desktop",

    // ---- auth / vaults (desktop is single-user, single-vault) ----
    async init() { return { authed: true }; },
    mountAuth() { throw new Error("not applicable on desktop"); },
    async signOut() {},
    async vaults() { return []; },
    async setVault() {},
    async createVault() { throw new Error("not applicable on desktop"); },
    async members() { return []; },
    async invite() { throw new Error("not applicable on desktop"); },
    async removeMember() { throw new Error("not applicable on desktop"); },

    // ---- notes ----
    async notes() { return (await fetch("/api/notes")).json(); },
    async note(id) { return (await fetch(`/api/notes/${id}`)).json(); },
    async create(title, body, grp = "") {
      return (await fetch("/api/notes", { method: "POST", headers: json(), body: JSON.stringify({ title, body, grp }) })).json();
    },
    async update(id, title, body, grp = "") {
      return (await fetch(`/api/notes/${id}`, { method: "PUT", headers: json(), body: JSON.stringify({ title, body, grp }) })).json();
    },
    async remove(id) { return (await fetch(`/api/notes/${id}`, { method: "DELETE" })).json(); },

    // ---- vectors / graph ----
    async storeEmbed(id, vector) {
      return (await fetch("/api/embed", { method: "POST", headers: json(), body: JSON.stringify({ id, vector }) })).json();
    },
    async search(vector, k = 20) {
      return (await fetch("/api/search", { method: "POST", headers: json(), body: JSON.stringify({ vector, k }) })).json();
    },
    async suggest(id) { return (await fetch(`/api/suggest/${id}`)).json(); },
    async graph(threshold) {
      return (await fetch(`/api/graph?threshold=${threshold}`)).json();
    },

    // ---- attachments ----
    async listAttachments(noteId) {
      return (await fetch(`/api/notes/${noteId}/attachments`)).json();
    },
    async addAttachment(noteId, { url, name, mime }) {
      return (await fetch(`/api/notes/${noteId}/attachments`, {
        method: "POST",
        headers: json(),
        body: JSON.stringify({ url, name, mime }),
      })).json();
    },
    async removeAttachment(id) {
      return (await fetch(`/api/attachments/${id}`, { method: "DELETE" })).json();
    },

    // ---- misc ----
    async upload(file) {
      const res = await fetch("/api/upload", { method: "POST", headers: { "content-type": file.type }, body: file });
      if (!res.ok) {
        let msg;
        try { const d = await res.json(); msg = d.error || JSON.stringify(d); } catch { msg = await res.text().catch(() => ""); }
        throw new Error(msg || `upload failed (${res.status})`);
      }
      const data = await res.json().catch(() => ({}));
      if (data.error) throw new Error(data.error);
      return data.url;
    },
    ocrAvailable: false, // OCR runs in a cloud edge function (web only)
    async ocr() { throw new Error("OCR is available in the web version"); },
    async health() { return (await fetch("/api/health")).json(); },
    async version() { return (await fetch("/api/version")).json(); },
    async updateCheck() { return (await fetch("/api/update-check")).json(); },
  };
}
