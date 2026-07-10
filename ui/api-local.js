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

    // ---- misc ----
    async upload(file) {
      const res = await fetch("/api/upload", { method: "POST", headers: { "content-type": file.type }, body: file });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error || `upload failed (${res.status})`);
      return data.url;
    },
    ocrAvailable: false, // OCR runs in a cloud edge function (web only)
    async ocr() { throw new Error("OCR is available in the web version"); },
    async health() { return (await fetch("/api/health")).json(); },
    async version() { return (await fetch("/api/version")).json(); },
    async updateCheck() { return (await fetch("/api/update-check")).json(); },
  };
}
