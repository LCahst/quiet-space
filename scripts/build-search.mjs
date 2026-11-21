// Daily, after build-map.mjs: the data behind Advanced search (data/public/search.json).
// From CCP's Static Data Export: asteroid belts, moons and planet types per system, how far the farthest
// stargate is from the best asteroid belt (for "d-scan from a belt"), and every agent (station, level,
// division, kind, corporation, locator). The SDE is only downloaded again when CCP publishes a new build;
// the parsed result is kept in data/cache/search-sde.json. Station services come from ESI via build-map's
// cache (data/cache/static.json), so they match the rest of the site.
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

const DATA = process.env.DATA_DIR || "data";
const CACHE = `${DATA}/cache/search-sde.json`;
const STATIC = `${DATA}/cache/static.json`;
const PUB = `${DATA}/public`;
const SDE_URL = process.env.SDE_URL || "https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip";
const UA = `QuietSpace/1.0 (+https://github.com/${process.env.GITHUB_REPOSITORY || "local"})`;
const AU = 149597870700;
const PARSE_VERSION = 1; // bump when what's taken from the SDE changes, to parse the same build again

// Station services the search offers, in bit order. ESI's names; "labratory" is CCP's spelling.
// Left out after checking (2026-11): services with no use in today's game (bounty, assassination and
// courier missions, stock exchange, black market, gambling, refinery, surgery, DNA therapy, paintshop,
// storage, news, InterBus) and ones at nearly every station (docking, navy offices).
const SERVICES = ["factory", "labratory", "reprocessing-plant", "cloning", "repair-facilities", "insurance", "fitting", "market", "loyalty-point-store", "office-rental", "security-offices"];
// A jump clone facility counts as a clone bay (the site's existing rule).
const SERVICE_ALIASES = { "jump-clone-facility": "cloning" };
// Planet types used for planetary industry, in this order (shattered planets can't be used and are left out)
const PLANETS = [[2016, "barren"], [13, "gas"], [12, "ice"], [2015, "lava"], [2014, "oceanic"], [2063, "plasma"], [2017, "storm"], [11, "temperate"]];
// Agent kinds by CCP's agentTypeID
const KINDS = ["mission", "research", "fw", "storyline", "career", "epic", "event", "other"];
const KIND_OF = { 2: 0, 4: 1, 9: 2, 6: 3, 7: 3, 12: 4, 10: 5, 8: 6 };
// Divisions of mission and research agents
const DIVISIONS = { 22: "distribution", 23: "mining", 24: "security", 18: "research" };

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const readJSON = async (file, fallback) => { try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; } };
const writeJSON = async (file, obj) => { await mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true }); await writeFile(file, JSON.stringify(obj)); };

// The latest SDE link redirects to a file named after its build number, so a HEAD request tells us
// whether anything changed without downloading 100 MB.
async function latestBuild() {
  try {
    const res = await fetch(SDE_URL, { method: "HEAD", redirect: "manual", headers: { "User-Agent": UA } });
    const m = (res.headers.get("location") || "").match(/-(\d+)-jsonl\.zip/);
    return m ? m[1] : null;
  } catch { return null; }
}

async function parseSde() {
  const zip = `${tmpdir()}/quiet-space-sde-search.zip`;
  try {
    const res = await fetch(SDE_URL, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`SDE download answered ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(zip));
    const entries = execFileSync("unzip", ["-Z1", zip], { maxBuffer: 64 * 1024 * 1024 }).toString().split("\n").filter(Boolean);
    const read = name => {
      const entry = entries.find(n => n === name || n.endsWith("/" + name));
      if (!entry) throw new Error(`${name} not found in the SDE archive`);
      return execFileSync("unzip", ["-p", zip, entry], { maxBuffer: 512 * 1024 * 1024 }).toString().split("\n").filter(Boolean).map(l => JSON.parse(l));
    };
    const sys = {}; // id -> { belts: [[x,y,z]], moons, planets: [8 counts], gates: [[x,y,z]] }
    const S = id => (sys[id] ??= { belts: [], moons: 0, planets: PLANETS.map(() => 0), gates: [] });
    const planetIndex = new Map(PLANETS.map(([t], i) => [t, i]));
    for (const p of read("mapPlanets.jsonl")) {
      const s = S(p.solarSystemID);
      s.moons += (p.moonIDs || []).length;
      if (planetIndex.has(p.typeID)) s.planets[planetIndex.get(p.typeID)]++;
    }
    for (const b of read("mapAsteroidBelts.jsonl")) if (b.position) S(b.solarSystemID).belts.push([b.position.x, b.position.y, b.position.z]);
    for (const g of read("mapStargates.jsonl")) if (g.position) S(g.solarSystemID).gates.push([g.position.x, g.position.y, g.position.z]);
    // per system: belts, moons, planet counts, and the best belt's farthest gate in AU (null without belts or gates)
    const out = {};
    for (const [id, s] of Object.entries(sys)) {
      let best = null;
      if (s.belts.length && s.gates.length) {
        for (const b of s.belts) {
          let far = 0;
          for (const g of s.gates) far = Math.max(far, Math.hypot(b[0] - g[0], b[1] - g[1], b[2] - g[2]));
          if (best === null || far < best) best = far;
        }
        best = Math.round(best / AU * 100) / 100;
      }
      out[id] = [s.belts.length, s.moons, s.planets, best];
    }
    const stationSystem = {};
    for (const st of read("npcStations.jsonl")) stationSystem[st._key] = st.solarSystemID;
    const agents = [];
    const usedCorps = new Set();
    for (const c of read("npcCharacters.jsonl")) {
      if (!c.agent || !stationSystem[c.locationID]) continue;
      const a = c.agent;
      agents.push([c.locationID, a.level, DIVISIONS[a.divisionID] ? Object.keys(DIVISIONS).indexOf(String(a.divisionID)) : -1, KIND_OF[a.agentTypeID] ?? KINDS.length - 1, c.corporationID, a.isLocator ? 1 : 0, c.name?.en || ""]);
      usedCorps.add(c.corporationID);
    }
    const corps = {}, factionIds = new Set();
    for (const c of read("npcCorporations.jsonl")) if (usedCorps.has(c._key)) { corps[c._key] = [c.name?.en || String(c._key), c.factionID || 0]; if (c.factionID) factionIds.add(c.factionID); }
    const factions = {};
    for (const f of read("factions.jsonl")) if (factionIds.has(f._key)) factions[f._key] = f.name?.en || String(f._key);
    return { systems: out, stationSystem, agents, corps, factions };
  } finally {
    try { await unlink(zip); } catch {}
  }
}

const cache = await readJSON(CACHE, null);
const build = await latestBuild();
let sde = cache;
if (!cache || cache.parseVersion !== PARSE_VERSION || (build && cache.build !== build)) {
  log(`Reading CCP's static data for Advanced search (build ${build || "unknown"}${cache ? `, had ${cache.build}` : ""})...`);
  try {
    sde = { build, parseVersion: PARSE_VERSION, at: new Date().toISOString(), ...(await parseSde()) };
    await writeJSON(CACHE, sde);
    log(`Parsed ${Object.keys(sde.systems).length} systems and ${sde.agents.length} agents.`);
  } catch (e) {
    log(`Could not read the SDE: ${e.message}. ${cache ? "Keeping the saved data." : "No search data yet."}`);
    sde = cache;
  }
} else {
  log(`SDE build ${cache.build} already parsed; not downloading again.`);
}
if (!sde) process.exit(0);

// Station services from ESI (build-map's cache), as a bit mask per station
const st = await readJSON(STATIC, null);
const stations = {};
if (st) {
  for (const [sid, s] of Object.entries(st.systems || {})) for (const x of s.st || []) {
    const info = st.stations?.[x];
    let mask = 0;
    for (const name of info?.sv || []) { const i = SERVICES.indexOf(SERVICE_ALIASES[name] || name); if (i >= 0) mask |= 1 << i; }
    stations[x] = [+sid, mask];
  }
}
// agents' stations that ESI's list doesn't have still need their system
for (const a of sde.agents) if (!stations[a[0]] && sde.stationSystem[a[0]]) stations[a[0]] = [sde.stationSystem[a[0]], 0];

const out = {
  v: 1, updated: new Date().toISOString(), sdeBuild: sde.build,
  services: SERVICES, planets: PLANETS.map(p => p[1]), kinds: KINDS, divisions: Object.values(DIVISIONS),
  dscanAU: Math.round(2147483647e3 / AU * 1000) / 1000,
  // id: [belts, moons, [planets by type], best belt's farthest gate in AU or null]; the site's systems only (no wormholes)
  systems: st ? Object.fromEntries(Object.entries(sde.systems).filter(([id]) => st.systems?.[id])) : sde.systems,
  // station id: [system id, services bit mask]
  stations,
  // [station id, level, division index or -1, kind index, corporation id, locator 0/1, name]
  agents: sde.agents,
  corps: sde.corps, factions: sde.factions
};
await writeJSON(`${PUB}/search.json`, out);
log(`Wrote search.json: ${Object.keys(out.systems).length} systems, ${Object.keys(stations).length} stations, ${out.agents.length} agents.`);
