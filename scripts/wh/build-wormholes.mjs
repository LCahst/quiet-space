// Wormhole section, phase 1: build the static reference data from CCP's own data
// plus community statics, and write a report of every disagreement found.
// Run by hand when the reference data needs rebuilding; the result is committed in wormholes/data.
//
// Run from the repo root:  node scripts/wh/build-wormholes.mjs
//   SDE_DIR=<folder>   use an already-extracted SDE (skips the ~100 MB download)
//   REFRESH=1          download the SDE and community files again even if cached
//   OFFLINE=1          skip the ESI cross-check and use cached community files only
//
// Sources:
//   CCP SDE (JSONL)       classes, shattered, effects + strengths, planets, moons, stars, hole types, ship masses
//   ESI /universe/types   cross-check of every wormhole type's dogma against the live server
//   Tripwire statics.json (MIT, bitbucket.org/daimian/tripwire)        statics per system (primary)
//   Wanderer wormholeSystems.json (MIT, github.com/wanderer-industries)  statics + effect names (cross-check)
//   Tripwire wormholes.json                                             community hole table (cross-check only)

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";
import { esi, pool } from "../lib/esi.mjs";
import { buildExtras } from "./extras.mjs";

const OUT = "wormholes/data";
const CACHE = "wormholes/.cache";
const SDE_URL = process.env.SDE_URL || "https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip";
const TRIPWIRE = "https://bitbucket.org/daimian/tripwire/raw/production/tools";
const TRIPWIRE_COMMITS = "https://api.bitbucket.org/2.0/repositories/daimian/tripwire/commits/production?pagelen=1&path=tools/";
const WANDERER = "https://raw.githubusercontent.com/wanderer-industries/wanderer/main/priv/repo/data/wormholeSystems.json";
const WANDERER_COMMITS = "https://api.github.com/repos/wanderer-industries/wanderer/commits?per_page=1&path=priv/repo/data/wormholeSystems.json";
const UA = "QuietSpace/1.0 (wormhole reference build)";
const REFRESH = process.env.REFRESH === "1";
const OFFLINE = process.env.OFFLINE === "1";
const WEEK = 7 * 86400e3;

// Figures from the research report (SDE build 3720952). A mismatch is reported, not fatal:
// CCP may legitimately change them, and then the report and pages need a look.
const EXPECT = {
  total: 2604, shattered: 100, effectSystems: 1038, holeTypes: 132,
  perClass: { 1: 358, 2: 537, 3: 506, 4: 523, 5: 531, 6: 118, 12: 1, 13: 25, 14: 1, 15: 1, 16: 1, 17: 1, 18: 1 }
};

export const CLASS_LABEL = {
  1: "C1", 2: "C2", 3: "C3", 4: "C4", 5: "C5", 6: "C6", 7: "High-sec", 8: "Low-sec", 9: "Null-sec",
  "-1": "Special (Pochven links)", 12: "Thera", 13: "C13", 14: "Drifter (Sentinel)", 15: "Drifter (Barbican)", 16: "Drifter (Vidette)",
  17: "Drifter (Conflux)", 18: "Drifter (Redoubt)", 25: "Pochven"
};

// Effect-beacon attributes, in player terms. "better" says whether a higher value helps the
// pilot in the system (null when it cuts both ways), which the SDE's highIsGood flag gets wrong for signature radius etc.
const MOD = {
  146: ["Shield hit points", true], 148: ["Armor hit points", true], 169: ["Inertia (agility penalty)", false],
  237: ["Targeting range", true], 244: ["Turret tracking", true], 652: ["Signature radius", false],
  1465: ["Armor EM resistance", true], 1466: ["Armor kinetic resistance", true], 1467: ["Armor thermal resistance", true],
  1468: ["Armor explosive resistance", true], 1469: ["Missile velocity", true], 1470: ["Ship velocity", true],
  1482: ["Weapon and drone damage", true], 1483: ["Missile explosion velocity", true], 1485: ["Overheat damage", false],
  1486: ["Overheat bonus", true], 1487: ["Smartbomb range", true], 1488: ["Smartbomb damage", true],
  1489: ["Shield EM resistance", true], 1490: ["Shield explosive resistance", true], 1491: ["Shield kinetic resistance", true],
  1492: ["Shield thermal resistance", true], 1493: ["Small weapon damage", true], 1495: ["Local armor repair amount", true],
  1496: ["Local shield boost amount", true], 1497: ["Remote shield repair amount", true], 1498: ["Remote armor repair amount", true],
  1499: ["Capacitor capacity", true], 1500: ["Capacitor recharge time", false], 1840: ["Remote capacitor transfer amount", true],
  1966: ["Energy neutralizer/nosferatu strength", null], 1967: ["Missile explosion radius", false],
  1968: ["Target painter strength", null], 1969: ["Stasis webifier strength", null]
};
// Resistance attributes are stored as "+15" (a percent, not a x1.15 multiplier) and they add to the damage a ship
// TAKES, i.e. they LOWER resistances: Pulsar lowers armour resists, Wolf-Rayet lowers shield resists (EVE University,
// eveapex, CCP's 2014 Hyperion dev blog). So they're shown negated: "Armor EM resistance -15%".
const PERCENT_ATTRS = new Set([1465, 1466, 1467, 1468, 1489, 1490, 1491, 1492]);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const writeJSON = async (name, obj) => { await writeFile(`${OUT}/${name}`, JSON.stringify(obj, null, 1)); log(`wrote ${OUT}/${name}`); };
const fresh = async f => !REFRESH && existsSync(f) && Date.now() - (await stat(f)).mtimeMs < WEEK;

async function download(url, file) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
}
async function cachedText(url, file) {
  const path = `${CACHE}/${file}`;
  if (!OFFLINE && !(await fresh(path))) { log(`fetching ${url}`); await download(url, path); }
  return readFile(path, "utf8");
}
async function lastCommit(url, file, pick) {
  try { return pick(JSON.parse(await cachedText(url, file))); } catch (e) { return `unknown (${e.message})`; }
}

// ---------- SDE ----------
async function sdeReader() {
  if (process.env.SDE_DIR) {
    log(`using extracted SDE in ${process.env.SDE_DIR}`);
    return async name => readFile(`${process.env.SDE_DIR}/${name}.jsonl`, "utf8");
  }
  const zip = `${CACHE}/sde.zip`;
  if (!(await fresh(zip))) { log("downloading the SDE (about 100 MB)"); await download(SDE_URL, zip); }
  const entries = execFileSync("unzip", ["-Z1", zip], { maxBuffer: 64 << 20 }).toString().split("\n").filter(Boolean);
  return async name => {
    const entry = entries.find(n => n === `${name}.jsonl` || n.endsWith(`/${name}.jsonl`));
    if (!entry) throw new Error(`${name}.jsonl not found in the SDE archive`);
    return execFileSync("unzip", ["-p", zip, entry], { maxBuffer: 1 << 30 }).toString();
  };
}
const parse = text => text.split("\n").filter(Boolean).map(l => JSON.parse(l));

// ---------- main ----------
await mkdir(OUT, { recursive: true });
await mkdir(CACHE, { recursive: true });
const sde = await sdeReader();
const rd = async name => parse(await sde(name));

const build = (await rd("_sde"))[0];
log(`SDE build ${build.buildNumber}, released ${build.releaseDate}`);
const stamp = { sdeBuild: build.buildNumber, sdeReleased: build.releaseDate, builtAt: new Date().toISOString() };

const types = new Map((await rd("types")).map(t => [t._key, t]));
const dogma = new Map((await rd("typeDogma")).map(t => [t._key, t]));
const groups = new Map((await rd("groups")).map(g => [g._key, g]));
const regions = new Map((await rd("mapRegions")).map(r => [r._key, r]));
const consts = new Map((await rd("mapConstellations")).map(c => [c._key, c]));
const isJ = id => id >= 31000000 && id < 32000000;
const systemsRaw = (await rd("mapSolarSystems")).filter(s => isJ(s._key));
const stars = new Map((await rd("mapStars")).filter(s => isJ(s.solarSystemID)).map(s => [s._key, s]));
const planets = (await rd("mapPlanets")).filter(p => isJ(p.solarSystemID));
const suns = new Map((await rd("mapSecondarySuns")).filter(s => isJ(s.solarSystemID)).map(s => [s.solarSystemID, s]));
const dogAttr = id => Object.fromEntries((dogma.get(id)?.dogmaAttributes || []).map(a => [a.attributeID, a.value]));
const en = t => t?.name?.en ?? null;
const report = { ...stamp, checks: [], disagreements: {} };
const check = (name, ok, detail) => { report.checks.push({ name, ok, detail }); log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`); };


// ---- effects (beacons) ----
const beaconInfo = new Map();
for (const s of suns.values()) {
  const id = s.effectBeaconTypeID;
  if (beaconInfo.has(id)) continue;
  const name = en(types.get(id)) || "";
  const m = name.match(/^Class (\d+) (.+) Effects$/);
  const a = dogAttr(id);
  const mods = Object.entries(a).map(([k, v]) => {
    const [label, better] = MOD[k] || [`attribute ${k}`, true];
    const pct = PERCENT_ATTRS.has(+k) ? -v : Math.round((v - 1) * 1000) / 10;
    // better = null: electronic warfare that works on you and on the enemy alike, so neither good nor bad
    return { attr: +k, label, value: v, pct, good: pct === 0 || better === null ? null : (pct > 0) === better };
  }).sort((x, y) => x.label.localeCompare(y.label));
  const unknown = mods.filter(x => !MOD[x.attr]).map(x => x.attr);
  beaconInfo.set(id, { beacon: id, name, beaconClass: m ? +m[1] : null, kind: m ? m[2].replace("Wolf Rayet", "Wolf-Rayet") : null, mods, unknown });
}
// Direction check against EVE University / eveapex: Pulsar lowers armour resists, Wolf-Rayet lowers shield resists.
{
  const at = (kind, cls, attr) => [...beaconInfo.values()].find(b => b.kind === kind && b.beaconClass === cls)?.mods.find(m => m.attr === attr);
  const p = at("Pulsar", 1, 1465), w = at("Wolf-Rayet", 1, 1489);
  check("effect directions: Pulsar lowers armour resists, Wolf-Rayet lowers shield resists", p?.pct < 0 && p.good === false && w?.pct < 0 && w.good === false, `Pulsar armour EM ${p?.pct}%, Wolf-Rayet shield EM ${w?.pct}%`);
}
const unknownAttrs = [...new Set([...beaconInfo.values()].flatMap(b => b.unknown))];
check("every effect modifier has a label", unknownAttrs.length === 0, unknownAttrs.length ? `unlabelled attributes ${unknownAttrs.join(", ")}` : "");

// ---- hole types ----
const holeTypes = [...types.values()].filter(t => t.groupID === 988 && !/^QA /.test(en(t)));
const holesAll = holeTypes.map(t => {
  const a = dogAttr(t._key);
  const code = en(t).replace(/^Wormhole\s+/, "");
  return {
    id: t._key, code, published: !!t.published,
    target: a[1381] ?? null, targetLabel: CLASS_LABEL[a[1381]] ?? (a[1381] != null ? `class ${a[1381]}` : null),
    lifetimeMin: a[1382] ?? null, totalMass: a[1383] ?? null, regenPerDay: a[1384] ?? null,
    maxJumpMass: a[1385] ?? null, distribution: a[1457] ?? null
  };
}).sort((x, y) => x.code.localeCompare(y.code) || x.id - y.id);
check(`hole types = ${EXPECT.holeTypes}`, holesAll.length + 2 === EXPECT.holeTypes, `${holesAll.length} in group 988 plus 2 QA types`);
// Several codes have more than one type ID (C729 has 27, one per target distribution). Merge them
// when everything but the distribution matches; report it if anything else differs.
const holeVariantDiff = [];
const holeByCode = new Map();
for (const h of holesAll) {
  const prev = holeByCode.get(h.code);
  if (!prev) { holeByCode.set(h.code, { ...h, ids: [h.id], distributions: [h.distribution] }); continue; }
  for (const k of ["target", "lifetimeMin", "totalMass", "regenPerDay", "maxJumpMass"])
    if (prev[k] !== h[k]) holeVariantDiff.push({ code: h.code, attr: k, ids: [prev.id, h.id], values: [prev[k], h[k]] });
  prev.ids.push(h.id); prev.distributions.push(h.distribution);
}
const holes = [...holeByCode.values()].map(({ id, distribution, ...h }) => ({ ...h, special: h.target === -1 || h.target === 25 }));
check("type IDs sharing a code have the same stats", holeVariantDiff.length === 0, `${holeByCode.size} codes from ${holesAll.length} type IDs`);
report.disagreements.holeVariants = holeVariantDiff;

// ESI cross-check: every hole type's dogma on the live server against the SDE.
const esiDiff = [];
if (!OFFLINE) {
  log(`checking ${holesAll.length} hole types against ESI`);
  const ATTRS = [1381, 1382, 1383, 1384, 1385, 1457];
  const failed = await pool(holesAll, 8, async h => {
    const { data } = await esi(`/universe/types/${h.id}/`);
    const live = Object.fromEntries((data.dogma_attributes || []).map(a => [a.attribute_id, a.value]));
    const mine = dogAttr(h.id);
    for (const k of ATTRS) if ((live[k] ?? null) !== (mine[k] ?? null)) esiDiff.push({ code: h.code, attr: k, sde: mine[k] ?? null, esi: live[k] ?? null });
  });
  check("hole dogma: SDE matches live ESI", esiDiff.length === 0 && failed === 0, `${esiDiff.length} differences, ${failed} lookups failed`);
}
report.disagreements.sdeVsEsiHoles = esiDiff;

// ---- community statics ----
const twStatics = JSON.parse(await cachedText(`${TRIPWIRE}/statics.json`, "tripwire-statics.json"));
const twHoles = JSON.parse(await cachedText(`${TRIPWIRE}/wormholes.json`, "tripwire-wormholes.json"));
const wd = JSON.parse(await cachedText(WANDERER, "wanderer-systems.json"));
const wdById = new Map(wd.map(s => [s.solarSystemID, s]));
const sources = {
  tripwire: { file: "tools/statics.json", lastCommit: await lastCommit(`${TRIPWIRE_COMMITS}statics.json`, "tripwire-commit.json", j => j.values?.[0]?.date), license: "MIT" },
  wanderer: { file: "priv/repo/data/wormholeSystems.json", lastCommit: await lastCommit(WANDERER_COMMITS, "wanderer-commit.json", j => j[0]?.commit?.committer?.date), license: "MIT" }
};
log(`Tripwire statics last changed ${sources.tripwire.lastCommit}; Wanderer ${sources.wanderer.lastCommit}`);

// ---- systems ----
// Effects where CCP's beacon data disagrees with ellatha.com, eveapex.com, Wanderer and the EVE Geological Survey,
// which all agree with each other and with the system's star type. Shown the community way, with CCP's version as a
// note (site owner's decision, 2026-11-21; checklist item 4 signed off).
const COMMUNITY = "ellatha.com, eveapex.com and Wanderer";
const EFFECT_OVERRIDE = {
  31002508: { kind: "Pulsar", strength: 1, source: COMMUNITY, checked: "2026-11-21" },               // J005926: CCP beacon Class 1 Red Giant
  31002509: { kind: "Red Giant", strength: 1, source: COMMUNITY, checked: "2026-11-21" },            // J010569: CCP beacon Class 1 Wolf-Rayet
  31002540: { kind: "Cataclysmic Variable", strength: 4, source: COMMUNITY, checked: "2026-11-21" }, // J011824: CCP beacon Class 6
  31002541: { kind: "Cataclysmic Variable", strength: 4, source: COMMUNITY, checked: "2026-11-21" }  // J010247: CCP beacon Class 6
};
// Statics confirmed by hand from a third source where Tripwire and Wanderer disagree.
// EVE University "Drifters" (edited 2026-10-09, checked 2026-11-21): all five Drifter systems have six statics.
const DRIFTER_SIX = ["Z647", "D382", "O477", "Y683", "N062", "R474"];
const MANUAL_CONFIRM = Object.fromEntries([31000001, 31000002, 31000003, 31000004, 31000006].map(id => [id, { statics: DRIFTER_SIX, source: "EVE University" }]));
const classOf = s => s.wormholeClassID ?? consts.get(s.constellationID)?.wormholeClassID ?? regions.get(s.regionID)?.wormholeClassID ?? null;
const planetsBySystem = new Map();
for (const p of planets) { if (!planetsBySystem.has(p.solarSystemID)) planetsBySystem.set(p.solarSystemID, []); planetsBySystem.get(p.solarSystemID).push(p); }

const staticDiff = [], effectNameDiff = [], beaconMismatch = [], unknownStatics = [];
const systems = systemsRaw.map(s => {
  const name = en(s), cls = classOf(s);
  const sun = suns.get(s._key);
  let effect = null;
  if (sun) {
    const b = beaconInfo.get(sun.effectBeaconTypeID);
    const sunKind = en(types.get(sun.typeID)).replace("Wolf-Rayet Star", "Wolf-Rayet");
    effect = { kind: b.kind, sunType: sunKind, beacon: b.beacon, beaconClass: b.beaconClass };
    // Known by design: C13 systems carry Class 6 beacons, Drifter systems (C14-C18) Class 2 ones.
    const expected = b.kind === sunKind && ((cls === 13 && b.beaconClass === 6) || (cls >= 14 && cls <= 18 && b.beaconClass === 2));
    effect.strengthClass = b.beaconClass;
    if ((b.kind !== sunKind || b.beaconClass !== cls) && !expected) beaconMismatch.push({ id: s._key, name, class: cls, sun: sunKind, beacon: b.name });
    // Where CCP's effect beacon disagrees with the community mappers, show the community version and keep CCP's as a note.
    const o = EFFECT_OVERRIDE[s._key];
    if (o) {
      const cb = [...beaconInfo.values()].find(x => x.kind === o.kind && x.beaconClass === o.strength);
      if (!cb) throw new Error(`no ${o.kind} beacon at Class ${o.strength} for ${name}`);
      effect = { kind: o.kind, sunType: sunKind, beacon: cb.beacon, beaconClass: cb.beaconClass, strengthClass: cb.beaconClass,
        override: { source: o.source, ccpKind: b.kind, ccpClass: b.beaconClass, checked: o.checked } };
    }
  }
  // statics: Tripwire primary, Wanderer cross-check
  const tw = twStatics[name] || [];
  // A third source, checked by hand, can confirm statics the two files disagree on.
  const w = [...(wdById.get(s._key)?.statics || []), ...(MANUAL_CONFIRM[s._key]?.statics || [])];
  const all = [...new Set([...tw, ...w])];
  const statics = all.map(code => {
    const h = holeByCode.get(code);
    if (!h) unknownStatics.push({ system: name, code });
    const wd = (wdById.get(s._key)?.statics || []).includes(code), man = (MANUAL_CONFIRM[s._key]?.statics || []).includes(code);
    return { code, target: h?.target ?? null, targetLabel: h?.targetLabel ?? null, confirmed: tw.includes(code) && (wd || man),
      sources: [tw.includes(code) && "tripwire", wd && "wanderer", man && MANUAL_CONFIRM[s._key].source].filter(Boolean) };
  });
  const wOnly = wdById.get(s._key)?.statics || [];
  if ([...tw].sort().join() !== [...wOnly].sort().join()) staticDiff.push({ id: s._key, name, tripwire: tw, wanderer: wOnly, resolvedBy: MANUAL_CONFIRM[s._key]?.source || null });
  const wdEffect = (wdById.get(s._key)?.effectName ?? null)?.replace("Wolf-Rayet Star", "Wolf-Rayet") ?? null;
  if ((wdEffect || null) !== (effect?.kind || null) && !EFFECT_OVERRIDE[s._key]) effectNameDiff.push({ id: s._key, name, sde: effect?.kind || null, wanderer: wdEffect });

  const pl = planetsBySystem.get(s._key) || [];
  const planetTypes = {};
  let moons = 0;
  for (const p of pl) { const n = en(types.get(p.typeID)).replace(/^Planet \((.+)\)$/, "$1"); planetTypes[n] = (planetTypes[n] || 0) + 1; moons += (p.moonIDs || []).length; }
  const star = stars.get(s.starID);
  return {
    id: s._key, name, class: cls, region: en(regions.get(s.regionID)), regionId: s.regionID,
    constellation: en(consts.get(s.constellationID)), shattered: s.visualEffect === "SHATTEREDWORMHOLE_OVERLAY",
    thera: s.visualEffect === "THERA", security: s.securityStatus, factionId: s.factionID ?? null,
    noAnchor: s.disallowedAnchorCategories || [], effect, statics,
    star: star ? { type: en(types.get(star.typeID)), spectral: star.statistics?.spectralClass ?? null } : null,
    planets: pl.length, planetTypes, moons
  };
}).sort((a, b) => a.name.localeCompare(b.name));

// ---- checks ----
const perClass = {};
for (const s of systems) perClass[s.class] = (perClass[s.class] || 0) + 1;
check(`J-space systems = ${EXPECT.total}`, systems.length === EXPECT.total, `${systems.length}`);
const classBad = Object.keys({ ...EXPECT.perClass, ...perClass }).filter(k => (perClass[k] || 0) !== (EXPECT.perClass[k] || 0));
check("systems per class match the research figures", classBad.length === 0, classBad.map(k => `class ${k}: got ${perClass[k] || 0}, expected ${EXPECT.perClass[k] || 0}`).join("; "));
check("no system without a class", !systems.some(s => s.class == null));
const shattered = systems.filter(s => s.shattered).length;
check(`shattered systems = ${EXPECT.shattered}`, shattered === EXPECT.shattered, `${shattered}`);
const withEffect = systems.filter(s => s.effect).length;
check(`systems with an effect = ${EXPECT.effectSystems}`, withEffect === EXPECT.effectSystems, `${withEffect}`);
check("Thera present (31000005)", systems.some(s => s.id === 31000005 && s.thera));
check("no Pochven or Turnur in output", !systems.some(s => s.class === 25 || s.name === "Turnur"));
const drifter = systems.filter(s => s.class >= 14 && s.class <= 18);
check("five Drifter systems", drifter.length === 5, drifter.map(s => s.name).join(", "));
check("every static code is a known hole type", unknownStatics.length === 0, unknownStatics.map(x => `${x.system} ${x.code}`).join("; "));
const noStatics = systems.filter(s => !s.statics.length).map(s => s.name);
check("every system has at least one static", noStatics.length === 0, noStatics.slice(0, 20).join(", "));
const j015092 = systems.find(s => s.name === "J015092");
check("J015092 static is N110 (anoik.is still shows J244)", j015092?.statics.some(x => x.code === "N110"), j015092?.statics.map(x => x.code).join(","));
const unresolved = staticDiff.filter(d => !d.resolvedBy);
check("Tripwire and Wanderer statics agree (or a third source settles it)", unresolved.length === 0, `${staticDiff.length} systems differ, ${staticDiff.length - unresolved.length} settled by hand; unresolved: ${unresolved.map(d => d.name).join(", ") || "none"}`);
check("Wanderer effect names match the SDE", effectNameDiff.length === 0, `${effectNameDiff.length} differ`);
const unhandled = beaconMismatch.filter(m => !EFFECT_OVERRIDE[m.id]);
check("every effect beacon matches its system class and sun (or has a community override)", unhandled.length === 0, `${beaconMismatch.length} differ from CCP's beacon data, ${beaconMismatch.length - unhandled.length} shown the community way pending an in-game check${unhandled.length ? `; not handled: ${unhandled.map(m => m.name).join(", ")}` : ""}`);
report.disagreements.statics = staticDiff;
report.disagreements.effectNames = effectNameDiff;
report.disagreements.beaconMismatch = beaconMismatch;
report.disagreements.unknownStatics = unknownStatics;

// Tripwire's hole table against CCP's, for the record (the site uses CCP's).
const twHoleDiff = [];
const lifeMin = s => { const m = String(s).match(/([\d.]+)\s*Hour/i); return m ? Math.round(+m[1] * 60) : null; };
for (const [code, t] of Object.entries(twHoles)) {
  const h = holeByCode.get(code);
  if (!h) { twHoleDiff.push({ code, issue: "not in the SDE" }); continue; }
  const diffs = [];
  if (t.mass != null && t.mass !== h.totalMass) diffs.push(`total mass ${t.mass} vs SDE ${h.totalMass}`);
  if (t.jump != null && t.jump !== h.maxJumpMass) diffs.push(`jump mass ${t.jump} vs SDE ${h.maxJumpMass}`);
  if (t.life && lifeMin(t.life) !== h.lifetimeMin) diffs.push(`lifetime ${t.life} vs SDE ${h.lifetimeMin} min`);
  if (diffs.length) twHoleDiff.push({ code, issue: diffs.join("; ") });
}
report.disagreements.tripwireHoleTable = twHoleDiff;
log(`Tripwire hole table: ${twHoleDiff.length} entries differ from CCP data (informational)`);

// ---- ships that fit ----
// Titans and supercarriers can't use wormholes at all (a game rule, not mass: the lighter supers are
// under the 2,000M limit). Source to confirm before launch: EVE University "Wormhole space".
const BARRED = new Set(["Titan", "Supercarrier"]);
const shipGroups = [...groups.values()].filter(g => g.categoryID === 6 && g.published);
const ships = [...types.values()]
  .filter(t => t.published && shipGroups.some(g => g._key === t.groupID) && t.mass > 0)
  .map(t => { const group = en(groups.get(t.groupID)); return { id: t._key, name: en(t), group, mass: t.mass, ...(BARRED.has(group) && { barred: true }) }; })
  .sort((a, b) => a.mass - b.mass);
const tiers = [...new Set(holes.filter(h => h.maxJumpMass).map(h => h.maxJumpMass))].sort((a, b) => a - b);
const byName = n => ships.find(s => s.name === n);
const fits = (n, jump) => (byName(n)?.mass ?? Infinity) <= jump;
const t = m => tiers.includes(m);
check("jump-mass tiers include 5M, 62M, 375M, 1,000M, 2,000M", [5e6, 62e6, 375e6, 1e9, 2e9].every(t), tiers.map(x => `${x / 1e6}M`).join(", "));
check("Nestor fits a 62M hole (the C1 exception); Megathron does not", fits("Nestor", 62e6) && !fits("Megathron", 62e6) && fits("Megathron", 375e6), `Nestor ${byName("Nestor")?.mass / 1e6}M, Megathron ${byName("Megathron")?.mass / 1e6}M`);
check("Orca fits a 375M hole", fits("Orca", 375e6), `Orca ${byName("Orca")?.mass / 1e6}M`);
check("Kronos mass is 118.4M (24.01 change)", byName("Kronos")?.mass === 118.4e6, `${byName("Kronos")?.mass / 1e6}M`);
const supers = ships.filter(s => /Titan|Supercarrier/.test(s.group));
check("titans and supercarriers are marked barred", supers.length > 0 && supers.every(s => s.barred), `${supers.length} hulls; lightest ${Math.min(...supers.map(s => s.mass)) / 1e6}M is under the 2,000M mass limit, so the rule must be stated, not computed`);

// ---- write ----
const effects = [...beaconInfo.values()].map(({ unknown, ...b }) => b).sort((a, b) => a.kind.localeCompare(b.kind) || a.beaconClass - b.beaconClass);
await writeJSON("systems.json", { ...stamp, sources, systems });
await writeJSON("holes.json", { ...stamp, note: "CCP dogma. lifetimeMin = attribute 1382 read as minutes (inferred from 960/1440/2880 values).", holes });
await writeJSON("effects.json", { ...stamp, note: "Beacon dogma from the SDE. Percent change from base; 'good' = helps the pilot.", effects });
await writeJSON("ships-fit.json", { ...stamp, note: "Base hull mass from the SDE; propulsion modules, plates and cargo add mass. barred = titans and supercarriers, which can't use wormholes whatever their mass.", tiers, ships });
// Victim kinds for the kill statistics (phase 2): the kill log keeps only the victim's type ID.
const CAPITAL_GROUPS = new Set(["Dreadnought", "Lancer Dreadnought", "Carrier", "Force Auxiliary", "Command Carrier", "Capital Industrial Ship", "Supercarrier", "Titan"]);
const victims = { structure: [], pos: [], deployable: [], capital: [], pod: [], starter: [] };
for (const t of types.values()) {
  const g = groups.get(t.groupID);
  if (!g) continue;
  if (g.categoryID === 65) victims.structure.push(t._key);
  else if (g.categoryID === 23) victims.pos.push(t._key);
  else if (g.categoryID === 22) victims.deployable.push(t._key);
  else if (g.categoryID === 6 && CAPITAL_GROUPS.has(en(g))) victims.capital.push(t._key);
  else if (en(g) === "Capsule") victims.pod.push(t._key);
  else if (g.categoryID === 6 && (en(g) === "Shuttle" || en(g) === "Corvette")) victims.starter.push(t._key); // shuttles and rookie ships
}
check("victim kinds found", Object.values(victims).every(v => v.length) && victims.pod.includes(670), Object.entries(victims).map(([k, v]) => `${k} ${v.length}`).join(", "));
await buildExtras({ rd, types, groups, dogma, en, stamp, check, report, writeJSON, holeByCode, systemsRaw, classOf, twStatics, twHoles, wd });
await writeJSON("victim-kinds.json", { ...stamp, note: "Type IDs by kind: Upwell structures (category 65), starbases (23), deployables (22), capital hulls, capsules, starter = shuttles and rookie ships.", ...victims });
await writeJSON("verify-report.json", report);

const failed = report.checks.filter(c => !c.ok);
log(`${report.checks.length - failed.length}/${report.checks.length} checks passed${failed.length ? `; review: ${failed.map(c => c.name).join(" | ")}` : ""}`);
