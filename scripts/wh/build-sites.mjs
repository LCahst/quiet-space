// Wormhole section: per-site figures from EVE University's wave lists and CCP's NPC stats.
// Run by hand (not in the Action). Run after build-wormholes.mjs:  node scripts/wh/build-sites.mjs
//
// In:  scripts/wh/data/rykki-sites.json  (main source: Rykki's Guide sheet, maintained with a dated changelog;
//                                         made by parse-rykki.mjs)
//      scripts/wh/data/eveuni-sites.json (cross-check: EVE University's site pages, read 2026-11-21)
//      wormholes/data/sleepers.json      (NPC stats computed from CCP's static data)
// Out: wormholes/data/sites.json         (per site: waves, NPC count, total EHP, strongest wave's DPS, EWAR, ISK)
// The wave lists themselves are not published; the pages link to EVE University for them.

import { readFile, writeFile } from "node:fs/promises";
import { csv } from "./lib-csv.mjs";

const eu = JSON.parse(await readFile("scripts/wh/data/eveuni-sites.json", "utf8"));
const rk = JSON.parse(await readFile("scripts/wh/data/rykki-sites.json", "utf8"));
// Per-ship blue loot from the sheet's Sleeper tab (only the C5/C6 ships and a few others are filled in).
const lootTab = csv(await readFile("wormholes/.cache/rykki/tab-360740101.csv", "utf8").catch(() => ""));
const shipLoot = new Map(lootTab.slice(2).filter(r => r[1]).map(r => [r[1].trim(), r[2] ? +r[2].replace(/[^0-9.]/g, "") : null]));
const src = rk;
const roster = JSON.parse(await readFile("wormholes/data/sleepers.json", "utf8"));
// Older and 2026 versions of each NPC share their stats (checked below); use the older one.
const byName = new Map();
for (const s of roster.sleepers) if (!byName.has(s.name) || !s.newModel) byName.set(s.name, s);
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`); };

const twins = roster.sleepers.filter(s => s.newModel && byName.get(s.name) !== s);
const statDiff = twins.filter(n => { const o = byName.get(n.name); return o.ehp !== n.ehp || o.turretDps !== n.turretDps || o.missileDps !== n.missileDps; });
check("2026 NPC versions have the same stats as the older ones", statDiff.length === 0, `${twins.length} pairs; differ: ${statDiff.map(s => s.name).join(", ") || "none"}`);

const unknown = new Set();
// "N Name" plus optional markers: " *" trigger for the next wave, " ?" optional spawn, " ^" DTA (its death brings the
// Decloaked Transmission Relay at the end of a C5/C6 site)
const parse = e => { const m = e.match(/^(\d+)\s+(.+?)((?:\s+[*?^])*)$/); if (!m) throw new Error(`bad entry "${e}"`); const f = m[3]; return { n: +m[1], name: m[2], trigger: f.includes("*"), optional: f.includes("?"), dta: f.includes("^") }; };
const sites = {};
for (const [site, d] of Object.entries(src.sites)) {
  let ehp = 0, ehpExtra = 0, npcs = 0, peakDps = 0, peakWave = 0, peakNeut = 0, webs = 0, scrams = 0, rr = 0, peakDpsExtra = 0;
  const triggers = [], dta = [];
  d.waves.forEach((wave, i) => {
    let dps = 0, neut = 0, dpsExtra = 0;
    for (const e of wave.map(parse)) {
      const s = byName.get(e.name);
      if (!s) { unknown.add(e.name); continue; }
      const k = e.n;
      if (e.trigger) triggers.push({ wave: i + 1, ship: e.name, count: k });
      if (e.dta) dta.push(e.name);
      dpsExtra += (s.turretDps + s.missileDps) * k;
      if (e.optional) { ehpExtra += s.ehp * k; continue; } // possible extra spawns: counted separately
      ehp += s.ehp * k; npcs += k;
      dps += (s.turretDps + s.missileDps) * k;
      if (typeof s.neutGJs === "number") neut += s.neutGJs * k;
      if (s.webPercent) webs += k;
      if (s.scramPoints) scrams += k;
      if (s.remoteRepair) rr += k;
    }
    if (dps > peakDps) { peakDps = dps; peakWave = i + 1; }
    peakDpsExtra = Math.max(peakDpsExtra, dpsExtra);
    peakNeut = Math.max(peakNeut, neut);
  });
  let isk = d.isk;
  // cross-checks: EVE University's record of the same site, and loot summed from per-ship values where known
  const e = eu.sites[site];
  const norm = w => w.map(x => x.map(y => y.replace(/ [*?]$/, "")).sort().join("; "));
  const waveDiffs = e ? norm(d.waves).map((w, i) => w === norm(e.waves)[i] ? null : i + 1).filter(Boolean) : [];
  if (e && e.waves.length > d.waves.length) for (let i = d.waves.length; i < e.waves.length; i++) waveDiffs.push(i + 1);
  // The sheet's site totals sometimes include the optional extra spawns and sometimes don't, so both sums are kept.
  let summed = 0, extra = 0, allKnown = true;
  for (const wave of d.waves) for (const x of wave.map(parse)) { const v = shipLoot.get(x.name); if (v == null) allKnown = false; else if (x.optional) extra += v * x.n; else summed += v * x.n; }
  const euIsk = e?.isk || null;
  const iskGap = euIsk && !euIsk.some(v => Math.abs(v - isk[0]) <= isk[0] * 0.1);
  sites[site] = {
    source: "rykki", eveUniIsk: euIsk, iskDisagrees: !!iskGap, wavesDifferFromEveUni: waveDiffs,
    iskFromShips: allKnown ? summed : null, extraSpawnIsk: allKnown && extra ? extra : null, sheetIsk: d.isk[0],
    waves: d.waves.length, npcs, ehp, ehpIfExtraSpawns: ehp + ehpExtra, peakWaveDps: Math.round(peakDps), peakWaveDpsIfExtraSpawns: Math.round(peakDpsExtra), peakWave, peakWaveNeutGJs: Math.round(peakNeut),
    triggers, dta: [...new Set(dta)], triggerNotes: (rk.notes || []).filter(n => n.site === site).map(n => n.note),
    websters: webs, scramblers: scrams, remoteRepairers: rr, blueLootIsk: isk,
    iskPerThousandEhp: Math.round(isk[0] / (ehp / 1000)),
    edited: e?.edited || null, note: e?.note || null, uncertain: null,
    url: `https://wiki.eveuniversity.org/${site.replace(/ /g, "_")}`
  };
}
check("every NPC in the wave lists is in CCP's roster", unknown.size === 0, [...unknown].join(", ") || "all found");
// Per-ship check: EVE University's row for each Sleeper (turret DPS, torpedo DPS) against the figure computed
// from CCP data. (Its stated per-wave totals are not used: some don't match the sum of its own rows, e.g.
// Integrated Terminus wave 3 is stated as 782 DPS while its rows add to 674.)
const EU_ROWS = { "Emergent Patroller": [8, 10], "Awakened Escort": [44, 10], "Sleepless Patroller": [112, 148], "Sleepless Watchman": [272, 42],
  "Wakeful Sentry Tower": [74, 0], "Sleepless Defender": [158, 206], "Sleepless Upholder": [382, 60], "Sleepless Safeguard": [248, 294],
  "Sleepless Sentinel": [202, 264], "Sleepless Keeper": [490, 76], "Sleepless Warden": [58, 340], "Sleepless Guardian": [318, 376], "Restless Sentry Tower": [94, 0] };
const off = Object.entries(EU_ROWS).filter(([n, [t, m]]) => { const s = byName.get(n); return !s || Math.abs(s.turretDps - t) > Math.max(3, t * 0.03) || Math.abs(s.missileDps - m) > Math.max(3, m * 0.03); });
check("per-ship DPS matches EVE University's rows (±3 DPS or 3%)", off.length === 0,
  `${Object.keys(EU_ROWS).length} ships checked${off.length ? "; off: " + off.map(([n, [t, m]]) => `${n} ours ${byName.get(n)?.turretDps}+${byName.get(n)?.missileDps} vs ${t}+${m}`).join("; ") : ""}`);
check("48 sites", Object.keys(sites).length === 48, `${Object.keys(sites).length}`);
const known = Object.entries(sites).filter(([, v]) => v.iskFromShips != null);
const offLoot = known.filter(([, v]) => Math.abs(v.iskFromShips - v.sheetIsk) > 1e6 && Math.abs(v.iskFromShips + (v.extraSpawnIsk || 0) - v.sheetIsk) > 1e6);
const offText = offLoot.map(([n, v]) => `${n}: ships sum to ${v.iskFromShips / 1e6}m${v.extraSpawnIsk ? ` (+${v.extraSpawnIsk / 1e6}m extra spawn)` : ""}, sheet says ${v.sheetIsk / 1e6}m`).join("; ");
// Where every ship's loot is known, use the computed total (it follows the sheet's own wave corrections).
for (const [, v] of known) { v.blueLootIsk = [v.iskFromShips]; v.iskPerThousandEhp = Math.round(v.iskFromShips / (v.ehp / 1000)); }
const EXPECTED_OFF = ["Forgotten Core Data Field"]; // sheet raised wave 1 from 5 to 6 Emergent Sentinels (Oct 2024) but kept the old total
check("site loot = sum of per-ship loot where every ship's loot is known (known exceptions listed)", offLoot.every(([n]) => EXPECTED_OFF.includes(n)), `${known.length} sites checked${offLoot.length ? "; off: " + offText : ""}`);
const gaps = Object.entries(sites).filter(([, v]) => v.iskDisagrees);
console.log(`ISK differs from EVE University by >10% at ${gaps.length} sites: ${gaps.map(([n, v]) => `${n} (${v.blueLootIsk[0] / 1e6}m vs ${v.eveUniIsk.map(x => x / 1e6).join("/")}m)`).join("; ")}`);
console.log(`waves differ from EVE University at ${Object.values(sites).filter(v => v.wavesDifferFromEveUni.length).length} sites`);

// ---- gas sites (Rykki's gas tab): defenders costed with CCP stats, gas amounts checked against CCP volumes ----
const rg = JSON.parse(await readFile("scripts/wh/data/rykki-gas.json", "utf8"));
const vol = JSON.parse(await readFile("wormholes/data/fullerites.json", "utf8")).volumes;
const gasOut = {}, volOff = [];
for (const [name, g] of Object.entries(rg.sites)) {
  let ehp = 0, dps = 0, n = 0;
  for (const e of g.defenders.map(parse)) { const sl = byName.get(e.name); if (!sl) { unknown.add(e.name); continue; } ehp += sl.ehp * e.n; dps += (sl.turretDps + sl.missileDps) * e.n; n += e.n; }
  for (const x of g.gas) if (vol[x.type] * x.units !== x.m3) volOff.push(`${name} ${x.type}`);
  gasOut[name] = { blueLootIsk: g.isk, defenders: g.defenders, defenderCount: n, defenderEhp: ehp, defenderDps: Math.round(dps),
    gas: g.gas.map(x => ({ type: x.type, units: x.units, m3: vol[x.type] * x.units })), totalM3: g.gas.reduce((a, x) => a + vol[x.type] * x.units, 0) };
}
check("gas: nine sites, volumes match CCP's m³ per unit", Object.keys(gasOut).length === 9 && volOff.length === 0, volOff.join(", ") || "all match");
const ord = gasOut["Ordinary Perimeter Reservoir"]?.defenders.join(), siz = gasOut["Sizeable Perimeter Reservoir"]?.defenders.join();
check("gas: Ordinary Perimeter defenders = Sizeable's (CCP 23.02)", ord && ord === siz, ord);
await writeFile("wormholes/data/gas.json", JSON.stringify({ builtAt: new Date().toISOString(), source: rg.source + "; NPC stats and fullerite volumes from CCP's static data.", sites: gasOut }, null, 1));

// ---- ore sites (Rykki's ore tab), defenders costed with CCP stats, volumes checked against CCP ----
const ro = JSON.parse(await readFile("scripts/wh/data/rykki-ore.json", "utf8"));
const oreVol = JSON.parse(await readFile("wormholes/data/ore-volumes.json", "utf8")).volumes;
// Where the site appears, from EVE University's Wormhole sites page.
const ORE_AREA = n => /Perimeter/.test(n) ? ["Perimeter", "every class"] : /Frontier/.test(n) ? ["Frontier", "every class"] : /Core/.test(n) ? ["Core", "C5 and C6 (rarely lower)"] : ["Shattered", "shattered systems only"];
// Danger from the defenders' combined damage, on the same scale the anomaly tiers roughly follow
// (C1–C2 strongest waves ≈ 200–500 DPS, C3 ≈ 600–800, C4 ≈ 1,200–1,600, C5 ≈ 2,000–2,700, C6 ≈ 3,000+).
const tierFor = dps => dps < 500 ? 1 : dps < 900 ? 2 : dps < 1700 ? 3 : dps < 3000 ? 4 : 5;
const oreOut = {}, oreVolOff = [];
// Corrections and doubts from cross-checking (2026-11-21). cerlestes.de's ore table marks which ores occur in wormholes:
// Arkonor, Bistot, Gneiss, Kernite, Omber and Pyroxeres yes; Plagioclase (high-sec) and Hedbergite (low-sec) no.
const EU_ORE = {
  "Exceptional Core Deposit": { rename: ["Plagioclase IV-Grade", "Pyroxeres IV-Grade"], note: "Rykki's Guide lists the 1,530,000-unit ore as Plagioclase; EVE University lists Pyroxeres, and Plagioclase isn't a wormhole ore (cerlestes.de), so it's shown as Pyroxeres." },
  "Ordinary Perimeter Deposit": { note: "Rykki's Guide lists 200,000 Hedbergite here, but cerlestes.de doesn't list Hedbergite as a wormhole ore. Unconfirmed." }
};
for (const [name, g] of Object.entries(ro.sites)) {
  const fix = EU_ORE[name]?.rename;
  if (fix) for (const x of g.ore) if (x.name === fix[0]) { x.name = fix[1]; x.m3 = Math.round(oreVol[fix[1]] * x.units); }
  let ehp = 0, dps = 0, n = 0, scram = false;
  for (const e of g.defenders.map(parse)) { const sl = byName.get(e.name); if (!sl) { unknown.add(e.name); continue; } ehp += sl.ehp * e.n; dps += (sl.turretDps + sl.missileDps) * e.n; n += e.n; if (sl.scramPoints) scram = true; }
  for (const x of g.ore) if (oreVol[x.name] == null || Math.abs(oreVol[x.name] * x.units - x.m3) > 1) oreVolOff.push(`${name} ${x.name}`);
  const [area, where] = ORE_AREA(name);
  oreOut[name] = { area, where, blueLootIsk: g.isk, defenders: g.defenders, defenderCount: n, defenderEhp: ehp, defenderDps: Math.round(dps), scrams: scram, tier: Math.min(5, tierFor(dps) + (scram ? 1 : 0)), // +1 when a defender scrams: a barge can't warp off
    ore: g.ore.map(x => ({ name: x.name.replace(/ IV-Grade$/, ""), units: x.units, m3: Math.round((oreVol[x.name] ?? 0) * x.units) })),
    totalM3: Math.round(g.ore.reduce((a, x) => a + (oreVol[x.name] ?? 0) * x.units, 0)),
    listedOnly: g.ore.length ? null : g.listed, note: EU_ORE[name]?.note || null };
}
check("ore: twelve sites, volumes match CCP's m³ per unit", Object.keys(oreOut).length === 12 && oreVolOff.length === 0, oreVolOff.join(", ") || "all match");
check("ore: Exceptional Core Deposit guarded by one Sleepless Sentinel (as EVE University says)", oreOut["Exceptional Core Deposit"]?.defenders.join() === "1 Sleepless Sentinel", oreOut["Exceptional Core Deposit"]?.defenders.join());
await writeFile("wormholes/data/ore.json", JSON.stringify({ builtAt: new Date().toISOString(), source: ro.source + "; ore volumes and NPC stats from CCP's static data; where each site appears from EVE University.", sites: oreOut }, null, 1));

await writeFile("wormholes/data/sites.json", JSON.stringify({
  builtAt: new Date().toISOString(), sdeBuild: roster.sdeBuild,
  source: "Wave lists and blue loot from Rykki's Guide (Grubu's maintained version, a community Google Sheet), cross-checked against EVE University's site pages (CC BY-SA 4.0); NPC stats from CCP's static data. EHP and DPS are computed here.",
  rykki: rk.source,
  note: "peakWaveDps = every NPC in the strongest wave shooting one target; real incoming damage is lower (range, tracking, target switching). Possible extra spawns are left out except in ehpIfExtraSpawns. Blue loot sells to NPC buy orders at fixed prices, so the ISK figures hold unless CCP changes the loot.",
  checks, sites
}, null, 1));
console.log(`wrote wormholes/data/sites.json; ${checks.filter(c => c.ok).length}/${checks.length} checks passed`);
