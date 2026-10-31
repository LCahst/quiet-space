// Daily job: builds the list of public player-owned (Upwell) structures per system from EVE Ref's
// structure dataset (https://docs.everef.net/datasets/structures), which scrapes ESI's structure endpoints.
// Writes data/public/structures-count.json (small, loaded with the page) and structures.json (details,
// loaded on first hover). If the download fails, the previous files are kept.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { names } from "./lib/esi.mjs";

const DATA = process.env.DATA_DIR || "data";
const PUB = `${DATA}/public`;
const URL = process.env.STRUCTURES_URL || "https://data.everef.net/structures/structures-latest.v2.json";
const UA = `QuietSpace/1.0 (+https://github.com/${process.env.GITHUB_REPOSITORY || "local"})`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

try {
  const res = await fetch(URL, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (!res.ok) throw new Error(`EVE Ref answered ${res.status}`);
  const all = await res.json();
  if (!all || typeof all !== "object" || Array.isArray(all)) throw new Error("unexpected file format");

  const systems = {}, typeIds = new Set();
  let total = 0;
  for (const s of Object.values(all)) {
    if (!s || s.is_public_structure !== true || typeof s.solar_system_id !== "number") continue;
    const type = typeof s.type_id === "number" ? s.type_id : null;
    if (type) typeIds.add(type);
    // [name, type id, has market]
    (systems[s.solar_system_id] ||= []).push([typeof s.name === "string" ? s.name : null, type, s.is_market_structure === true ? 1 : 0]);
    total++;
  }

  let types = {};
  try { types = await names([...typeIds]); } catch (e) { log(`Couldn't resolve structure type names (${e.message}); the site will show type numbers.`); }

  for (const list of Object.values(systems)) {
    list.sort((a, b) => (types[a[1]] || "").localeCompare(types[b[1]] || "") || (a[0] || "").localeCompare(b[0] || ""));
  }
  const counts = Object.fromEntries(Object.entries(systems).map(([id, list]) => [id, list.length]));
  const updated = new Date().toISOString();
  await mkdir(PUB, { recursive: true });
  await writeFile(`${PUB}/structures.json`, JSON.stringify({ updated, types, systems }));
  await writeFile(`${PUB}/structures-count.json`, JSON.stringify({ updated, systems: counts }));
  log(`Public structures: ${total} in ${Object.keys(systems).length} systems (${typeIds.size} structure types)`);
} catch (e) {
  let kept = "no previous file";
  try { kept = `keeping file from ${JSON.parse(await readFile(`${PUB}/structures-count.json`, "utf8")).updated}`; } catch {}
  log(`Structure data unavailable (${e.message}); ${kept}.`);
}
