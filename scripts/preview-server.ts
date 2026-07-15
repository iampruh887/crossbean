// bun auto-loads .env → SUPABASE_URL/CLERK_* present → config.js carries cloud creds
process.env.CROSSBEAN_DATA_DIR ??= "/tmp/cb-visual-check";
const { startServer } = await import("../src/server");
const s = startServer("ui");
console.log("listening on " + s.port);
await new Promise(() => {});
