// Wormhole section: read "Grubu's Maintained Nolak's Updated Karr's Modified Rykki's Guide 1.5" (a community
// Google Sheet of Sleeper site data, maintained with a dated changelog) into the same format as eveuni-sites.json.
// Run by hand (not in the Action).
//
//   node scripts/wh/parse-rykki.mjs          downloads the tabs (if older than a day) and parses them
//   OFFLINE=1 node scripts/wh/parse-rykki.mjs uses the saved copies in wormholes/.cache/rykki/
// Out: scripts/wh/data/rykki-sites.json
// No licence is stated on the sheet: the site uses it for computed figures and credits and links it.

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";

const SHEET = "https://docs.google.com/spreadsheets/d/e/2PACX-1vSaCHnBRDw8Ki6nuamMzQv3InN978Zh7F6RcwlYdJHnlQkDrrdz5zrG3Of_8eoyxeqJimMHt9-7GjLn";
const TABS = { 1: "0", 2: "152271063", 3: "1157002677", 4: "2012494173", 5: "124062662", 6: "1314849064", updates: "349639088", gas: "141191379", ore: "1259304327", avenger: "1160985461", drifter: "1813193533" };
const DIR = "wormholes/.cache/rykki";
const OFFLINE = process.env.OFFLINE === "1";
await mkdir(DIR, { recursive: true });

for (const gid of Object.values(TABS)) {
  const f = `${DIR}/tab-${gid}.csv`;
  const fresh = existsSync(f) && Date.now() - (await stat(f)).mtimeMs < 86400e3;
  if (OFFLINE || fresh) continue;
  const res = await fetch(`${SHEET}/pub?output=csv&gid=${gid}`, { headers: { "User-Agent": "QuietSpace/1.0 (wormhole reference build)" } });
  if (!res.ok) { console.warn(`tab ${gid}: ${res.status}, keeping the saved copy`); continue; }
  await writeFile(f, await res.text());
  await new Promise(r => setTimeout(r, 1000));
}

import { csv as parseCsv } from "./lib-csv.mjs";
const csv = t => parseCsv(t).map(r => r.map(x => x.trim()));
const money = s => +String(s).replace(/[$,\s]/g, "");
const NPC = /^(Emergent|Awakened|Sleepless) \w+$|Sentry Tower$/;

const sites = {}, notes = [];
for (const cls of [1, 2, 3, 4, 5, 6]) {
  const R = csv(await readFile(`${DIR}/tab-${TABS[cls]}.csv`, "utf8"));
  let site = null, wave = null;
  for (let i = 0; i < R.length; i++) {
    const r = R[i], cells = r.filter(Boolean);
    const next = (R[i + 1] || []).filter(Boolean);
    if (cells.length === 1 && next.includes("Blue Loot")) {
      site = { cls, kind: next[0], isk: money(next[next.indexOf("Blue Loot") + 1]), waves: {}, order: [] };
      sites[cells[0]] = site; wave = null; continue;
    }
    if (!site) continue;
    const w = cells[0]?.match(/^Wave (\d+)$/);
    if (w) { wave = +w[1]; if (!site.waves[wave]) { site.waves[wave] = []; site.order.push(wave); } continue; }
    const qi = r.findIndex(x => /^\d+$/.test(x));
    if (qi < 0 || wave == null || !NPC.test(r[qi + 1] || "")) {
      if (cells.some(c => /^Note/i.test(c))) notes.push({ site: Object.keys(sites).at(-1), note: cells.join(" ") });
      continue;
    }
    const mark = r.slice(0, qi).filter(Boolean).join(" ");
    // " ?" optional spawn, " *" triggers the next wave, " ^" DTA: its death brings the Decloaked Transmission Relay
    // (the C5/C6 end-of-site Drifter trigger)
    const flag = /^Opt/.test(mark) ? " ?" : /Trigger/.test(mark) ? " *" : /^DTA$/.test(mark) ? " ^" : "";
    site.waves[wave].push(`${r[qi]} ${r[qi + 1]}${flag}`);
    if (mark && !/^(Trigger|Opt\??|DTA)$/.test(mark)) notes.push({ site: Object.keys(sites).at(-1), note: `wave ${wave}: ${mark} (${r[qi + 1]})` });
  }
}
const out = {};
for (const [name, s] of Object.entries(sites))
  // Waves in the order the sheet lists them (it once lists "Wave 3" above "Wave 2", for The Ruins of Enclave
  // Cohort 27; top-to-bottom order matches EVE University there). Object.keys of integer-like keys would sort them.
  out[name] = { cls: s.cls, kind: s.kind, isk: [s.isk], waves: s.order.map(k => s.waves[k]) };
const updated = (await readFile(`${DIR}/tab-${TABS.updates}.csv`, "utf8")).match(/Last Automatic Update,+([^,\r\n]+)/)?.[1] || null;
await writeFile("scripts/wh/data/rykki-sites.json", JSON.stringify({
  source: `Grubu's Maintained Nolak's Updated Karr's Modified Rykki's Guide 1.5 (${SHEET}/pubhtml), read ${new Date().toISOString().slice(0, 10)}; sheet last automatic update ${updated}.`,
  format: "Same as eveuni-sites.json: 'N Name' with ' *' = trigger, ' ?' = optional spawn.", notes, sites: out
}, null, 1));
// ---- gas sites: defenders, blue loot, gas units per cloud ----
const gas = {};
{
  const R = csv(await readFile(`${DIR}/tab-${TABS.gas}.csv`, "utf8"));
  let site = null, inGas = false;
  for (let i = 0; i < R.length; i++) {
    const cells = R[i].filter(Boolean), next = (R[i + 1] || []).filter(Boolean);
    if (cells.length === 1 && next.includes("Blue Loot")) { site = gas[cells[0]] = { isk: money(next[next.indexOf("Blue Loot") + 1]), defenders: [], gas: [] }; inGas = false; continue; }
    if (!site) continue;
    if (cells[0] === "Gas") { inGas = true; continue; }
    const fm = cells[0]?.match(/^Fullerite-(C\d+)$/);
    if (fm && inGas) { site.gas.push({ type: fm[1], units: money(cells[1]), m3: money(cells[2]) }); continue; }
    const r = R[i], qi = r.findIndex(x => /^\d+$/.test(x));
    if (qi >= 0 && NPC.test(r[qi + 1] || "")) site.defenders.push(`${r[qi]} ${r[qi + 1]}`);
  }
}
await writeFile("scripts/wh/data/rykki-gas.json", JSON.stringify({ source: `Rykki's Guide gas tab, read ${new Date().toISOString().slice(0, 10)}`, sites: gas }, null, 1));
console.log(`gas: ${Object.keys(gas).length} sites (${Object.entries(gas).map(([n, g]) => `${n.split(" ")[0]} ${g.gas.map(x => x.units).join("+")}`).join(", ")})`);

// ---- ore sites: defenders, blue loot, ore units (ice field lists ice types without amounts) ----
const ore = {};
{
  const R = csv(await readFile(`${DIR}/tab-${TABS.ore}.csv`, "utf8"));
  let site = null, inOre = false;
  for (let i = 0; i < R.length; i++) {
    const cells = R[i].filter(Boolean), next = (R[i + 1] || []).filter(Boolean);
    if (cells.length === 1 && next.includes("Blue Loot")) { site = ore[cells[0]] = { isk: money(next[next.indexOf("Blue Loot") + 1]), defenders: [], ore: [], listed: [] }; inOre = false; continue; }
    if (!site) continue;
    if (cells[0] === "Ore") { inOre = true; continue; }
    if (inOre && cells[0] && !/^Total/.test(cells[0])) {
      const units = money(cells[1] || 0), m3 = money(cells[2] || 0);
      site.listed.push(cells[0]);
      if (units > 0) site.ore.push({ name: cells[0], units, m3 });
      continue;
    }
    const r = R[i], qi = r.findIndex(x => /^\d+$/.test(x));
    if (qi >= 0 && NPC.test(r[qi + 1] || "")) site.defenders.push(`${r[qi]} ${r[qi + 1]}`);
  }
}
await writeFile("scripts/wh/data/rykki-ore.json", JSON.stringify({ source: `Rykki's Guide ore tab, read ${new Date().toISOString().slice(0, 10)}`, sites: ore }, null, 1));
console.log(`ore: ${Object.keys(ore).length} sites`);

console.log(`parsed ${Object.keys(out).length} sites (${[1, 2, 3, 4, 5, 6].map(c => `C${c}: ${Object.values(out).filter(s => s.cls === c).length}`).join(", ")}); ${notes.length} notes`);
