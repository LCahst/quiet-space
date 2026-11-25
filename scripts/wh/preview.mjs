// Wormhole section: local preview server. Run by hand (not in the Action).
//
// Run from anywhere:  node scripts/wh/preview.mjs        then open http://127.0.0.1:8765/wormholes/
//   PORT=9000 node scripts/wh/preview.mjs                 use another port
//
// Serves the repository folder (so ../index.html links back to the main site work too),
// only to this computer (127.0.0.1). Stop it with Ctrl+C.
//
// To refresh the data the pages show first:
//   node scripts/wh/build-wormholes.mjs
//   git fetch origin data && git archive origin/data kills | tar -x -C wormholes/.cache/data
//   node scripts/wh/collect-wh-kills.mjs

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const PORT = +(process.env.PORT || 8765);
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8"
};
const isFile = async f => { try { return (await stat(f)).isFile(); } catch { return false; } };
const isDir = async f => { try { return (await stat(f)).isDirectory(); } catch { return false; } };

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end("bad address"); }
  const target = resolve(ROOT, "." + path);
  // never serve anything outside the repository
  if (target !== ROOT && !target.startsWith(ROOT + sep)) { res.writeHead(403); return res.end("forbidden"); }

  let file = target;
  if (await isDir(target)) {
    // a folder without its trailing slash: redirect, so the pages' relative links resolve
    if (!path.endsWith("/")) { res.writeHead(301, { Location: `${url.pathname}/${url.search}` }); return res.end(); }
    file = join(target, "index.html");
  }
  if (!(await isFile(file))) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end(`not found: ${path}`); }
  res.writeHead(200, { "Content-Type": TYPES[extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
  res.end(await readFile(file));
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Wormhole preview: http://127.0.0.1:${PORT}/wormholes/`);
  console.log(`Serving ${ROOT} to this computer only. Ctrl+C to stop.`);
}).on("error", e => {
  console.error(e.code === "EADDRINUSE" ? `Port ${PORT} is already in use (is a preview already running?). Try PORT=8766.` : e.message);
  process.exit(1);
});
