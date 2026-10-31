// Daily job: builds the static map data the site would otherwise download from ESI in every visitor's browser.
// Writes data/public/catalog.json, mapdata.json and stations.json, and keeps a cache in data/cache/static.json
// so later runs only fetch what is missing. Planet positions (for system sizes) are filled in over several runs.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { esi, pool, names, stats } from "./lib/esi.mjs";

const DATA = process.env.DATA_DIR || "data";
const CACHE_FILE = `${DATA}/cache/static.json`;
const PUB = `${DATA}/public`;
const WEEK = 7 * 86400e3;
const PLANET_BUDGET = +(process.env.PLANET_BUDGET || 15000);
const AU = 149597870700;
const CLONE_RULE = 3; // must match the site

const readJSON = async (file, fallback) => { try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; } };
const writeJSON = async (file, obj) => {
  await mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  await writeFile(file, JSON.stringify(obj));
};
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const hasClone = sv => sv.some(x => x === "cloning" || x === "jump-clone-facility");
const dist = p => Math.hypot(p[0], p[1], p[2]);

const old = await readJSON(CACHE_FILE, null);
const full = process.env.FULL_REBUILD === "true" || !old || Date.now() - (old.builtAt || 0) > WEEK;
// Gate destinations and planet positions never change, so they survive a full refresh.
const c = full
  ? { builtAt: Date.now(), regions: {}, constellations: {}, systems: {}, gates: old?.gates || {}, stations: {}, planets: old?.planets || {} }
  : old;
log(full ? "Full refresh of systems and stations" : "Incremental update");

// 1. Regions (known space only) and constellation names
const regionIds = (await esi("/universe/regions/")).data.filter(id => id < 11000000);
await pool(regionIds.filter(id => !c.regions[id]), 10, async id => {
  const { data } = await esi(`/universe/regions/${id}/`);
  c.regions[id] = { name: data.name, cons: data.constellations || [] };
});
const consIds = Object.values(c.regions).flatMap(r => r.cons);
const missingCons = consIds.filter(id => !c.constellations[id]);
if (missingCons.length) Object.assign(c.constellations, await names(missingCons));
log(`Regions: ${Object.keys(c.regions).length}, constellations: ${consIds.length}`);

// 2. Systems
const systemIds = (await esi("/universe/systems/")).data.filter(id => id < 31000000);
let n = 0;
const needSys = systemIds.filter(id => !c.systems[id]);
await pool(needSys, 16, async id => {
  const { data } = await esi(`/universe/systems/${id}/`);
  c.systems[id] = {
    n: data.name, s: data.security_status, c: data.constellation_id,
    st: data.stations || [], g: data.stargates || [],
    pl: (data.planets || []).map(p => p.planet_id),
    p: data.position ? [data.position.x, data.position.z] : null
  };
  if (++n % 500 === 0) log(`  systems ${n} of ${needSys.length}`);
});
log(`Systems: ${Object.keys(c.systems).length} (fetched ${needSys.length})`);

// 3. Stargates: destination and position
const gateIds = Object.values(c.systems).flatMap(s => s.g);
const needGates = gateIds.filter(g => !c.gates[g]);
n = 0;
await pool(needGates, 16, async g => {
  const { data } = await esi(`/universe/stargates/${g}/`);
  c.gates[g] = { d: data.destination.system_id, p: [data.position.x, data.position.y, data.position.z] };
  if (++n % 2000 === 0) log(`  stargates ${n} of ${needGates.length}`);
});
log(`Stargates: ${gateIds.length} (fetched ${needGates.length})`);

// 4. NPC stations: name, services, position
const stationIds = Object.values(c.systems).flatMap(s => s.st);
const needSt = stationIds.filter(s => !c.stations[s]);
n = 0;
await pool(needSt, 16, async st => {
  const { data } = await esi(`/universe/stations/${st}/`);
  c.stations[st] = { n: data.name, sv: data.services || [], p: [data.position.x, data.position.y, data.position.z] };
  if (++n % 1000 === 0) log(`  stations ${n} of ${needSt.length}`);
});
log(`Stations: ${stationIds.length} (fetched ${needSt.length})`);

// 5. Planet positions, a limited number per run until all are known
const planetIds = Object.values(c.systems).flatMap(s => s.pl);
const needPl = planetIds.filter(p => !c.planets[p]);
const batch = needPl.slice(0, PLANET_BUDGET);
n = 0;
await pool(batch, 16, async pid => {
  const { data } = await esi(`/universe/planets/${pid}/`);
  c.planets[pid] = [data.position.x, data.position.y, data.position.z];
  if (++n % 2000 === 0) log(`  planets ${n} of ${batch.length}`);
});
log(`Planets: ${planetIds.length - needPl.length + n} of ${planetIds.length} known (${needPl.length - n} left for later runs)`);

await writeJSON(CACHE_FILE, c);

// 6. Public files for the site
const catalog = { savedAt: Date.now(), cloneRule: CLONE_RULE, prebuilt: true, regions: {}, consToRegion: {}, constellations: {}, systems: {} };
for (const [id, r] of Object.entries(c.regions)) {
  catalog.regions[id] = r.name;
  r.cons.forEach(cid => { catalog.consToRegion[cid] = +id; catalog.constellations[cid] = c.constellations[cid] || `Constellation ${cid}`; });
}
const mapdata = { pos: {}, links: {} };
const stations = {};
let sized = 0;
for (const [id, s] of Object.entries(c.systems)) {
  const out = { n: s.n, s: s.s, c: s.c, sid: s.st };
  const sts = s.st.map(x => c.stations[x]);
  if (sts.every(Boolean)) {
    const sv = [...new Set(sts.flatMap(x => x.sv))].sort();
    out.sv = sv; out.jc = hasClone(sv);
    if (sts.length) stations[id] = sts.map(x => [x.n, x.sv]).sort((a, b) => a[0].localeCompare(b[0]));
  }
  // Radius: distance from the star (at 0,0,0) to the farthest planet, stargate or station.
  const gates = s.g.map(g => c.gates[g]);
  const planets = s.pl.map(p => c.planets[p]);
  if (planets.every(Boolean) && gates.every(Boolean) && sts.every(Boolean)) {
    const far = Math.max(0, ...planets.map(dist), ...gates.map(g => dist(g.p)), ...sts.map(x => dist(x.p)));
    if (far > 0) { out.r = Math.round(far / AU * 100) / 100; sized++; }
  }
  catalog.systems[id] = out;
  if (s.p) mapdata.pos[id] = s.p;
  if (gates.every(Boolean)) mapdata.links[id] = [...new Set(gates.map(g => g.d))];
}
await writeJSON(`${PUB}/catalog.json`, catalog);
await writeJSON(`${PUB}/mapdata.json`, mapdata);
await writeJSON(`${PUB}/stations.json`, stations);
log(`Wrote public files. Systems with a size so far: ${sized} of ${Object.keys(c.systems).length}`);
log(`ESI requests: ${stats.requests}, retries: ${stats.retries}, failures: ${stats.failures}`);
