// Packs stargate positions into worker/src/gates.bin, which the kills Worker bundles and reads with no
// download or JSON parsing (parsing the 500 KB gates.json on every run cost the Worker CPU it can't spare).
//
// Usage: node scripts/build-worker-gates.mjs [path-or-url-of-gates.json]
// Defaults to the published gates.json. Rerun and redeploy the Worker (cd worker && npx wrangler deploy)
// only if stargates change, which in EVE is very rare.
//
// Layout, all little-endian 64-bit floats (exact for these whole-km values, which go past 32-bit range):
//   [n, systemIds x n (ascending), starts x (n + 1), x, y, z, x, y, z, ...]
// System ids[i]'s gates are the coordinates from starts[i] to starts[i + 1], in km.
import { readFile, writeFile } from "node:fs/promises";

const src = process.argv[2] || "https://quietspace.fun/data/gates.json";
const gates = /^https?:/.test(src) ? await (await fetch(src)).json() : JSON.parse(await readFile(src, "utf8"));

const ids = Object.keys(gates).map(Number).sort((a, b) => a - b);
const starts = [];
const coords = [];
for (const id of ids) {
  const g = gates[id];
  if (g.length % 3 || !g.every(Number.isSafeInteger)) throw new Error(`system ${id}: unexpected gate data`);
  starts.push(coords.length);
  coords.push(...g);
}
starts.push(coords.length);

const out = new Float64Array([ids.length, ...ids, ...starts, ...coords]);
const view = new DataView(out.buffer);
for (let i = 0; i < out.length; i++) view.setFloat64(i * 8, out[i], true); // force little-endian
const file = new URL("../worker/src/gates.bin", import.meta.url);
await writeFile(file, new Uint8Array(out.buffer));
console.log(`${ids.length} systems, ${coords.length / 3} gates, ${out.byteLength} bytes -> worker/src/gates.bin`);
