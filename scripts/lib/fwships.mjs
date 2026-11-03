// Faction warfare ship statistics, built from the zKillboard kills the hourly ISK collector already reads
// (no extra requests to zKillboard). Only kills inside warzone systems count, so the figures show what's
// flown in the warzones themselves. Kept for 7 days; writes data/public/fw-ships.json with 24-hour and 7-day
// totals per warzone, for kills involving militia pilots (empire or pirate) and for all kills in the warzones.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { esi, pool, names } from "./esi.mjs";

const DATA = process.env.DATA_DIR || "data";
const STORE = `${DATA}/cache/fw-kills.json`;
const TYPES = `${DATA}/cache/fw-types.json`;
const OUT = `${DATA}/public/fw-ships.json`;
const KEEP_S = 7 * 86400;
const EMPIRES = { 500001: "cg", 500004: "cg", 500003: "am", 500002: "am" };
const PIRATES = { 500010: "cg", 500011: "am" };
const FW = { ...EMPIRES, ...PIRATES };
const MAX_SHIPS = 150; // per list, to keep the file small
// fitted slots: high, medium, low, rig, subsystem
const isFitted = f => (f >= 27 && f <= 34) || (f >= 19 && f <= 26) || (f >= 11 && f <= 18) || (f >= 92 && f <= 99) || (f >= 125 && f <= 132);
const readJSON = async (file, fallback) => { try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; } };
const writeJSON = async (file, obj) => { await mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true }); await writeFile(file, JSON.stringify(obj)); };

// One compact record per FW kill.
function compact(d, zoneOf) {
  const km = d.esi || d.killmail || (d.victim ? d : null);
  if (!km || !km.victim || !km.victim.ship_type_id) return null;
  const sys = km.solar_system_id;
  if (typeof sys !== "number" || sys >= 31000000) return null; // known space only
  const zkb = d.zkb || km.zkb || {};
  const v = km.victim, vf = v.faction_id || 0;
  // player attackers only, grouped by ship and faction: [ship, faction, count, final blow]
  const groups = new Map();
  for (const a of km.attackers || []) {
    if (!a.character_id || !a.ship_type_id) continue;
    const key = `${a.ship_type_id}:${a.faction_id || 0}`;
    const g = groups.get(key) || [a.ship_type_id, a.faction_id || 0, 0, 0];
    g[2]++; if (a.final_blow) g[3] = 1;
    groups.set(key, g);
  }
  const att = [...groups.values()];
  if (!zoneOf.has(sys)) return null; // warzone systems only
  const militia = !!(FW[vf] || att.some(a => FW[a[1]]));
  const inZone = true;
  const zone = zoneOf.get(sys);
  const mods = [...new Set((v.items || []).filter(i => isFitted(i.flag)).map(i => i.item_type_id))];
  return {
    id: d.killmail_id || km.killmail_id,
    t: Math.floor(Date.parse(km.killmail_time || new Date().toISOString()) / 1000),
    s: sys, z: zone, w: inZone ? 1 : 0, m: militia ? 1 : 0,
    v: v.ship_type_id, vf, val: Math.round(+zkb.totalValue || 0), solo: zkb.solo ? 1 : 0,
    a: att, mods
  };
}

const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
const top = (o, n) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n));

function aggregate(records) {
  const S = { kills: records.length, isk: 0, ships: {}, factions: {} };
  const ship = id => (S.ships[id] ||= { k: 0, fb: 0, solo: 0, l: 0, iskK: 0, iskL: 0, kf: {}, lf: {}, sys: {}, kills: {}, killedBy: {}, mods: {} });
  const fac = id => (S.factions[id] ||= { k: 0, l: 0, iskK: 0, iskL: 0 });
  for (const r of records) {
    S.isk += r.val;
    // the loss
    const L = ship(r.v);
    L.l++; L.iskL += r.val; bump(L.lf, r.vf); bump(L.sys, r.s);
    for (const m of r.mods) bump(L.mods, m);
    const F = fac(r.vf); F.l++; F.iskL += r.val;
    // the killers: each ship type and each faction counts once per kill
    const shipsSeen = new Set(), facsSeen = new Set();
    for (const [sid, fid, , fb] of r.a) {
      const K = ship(sid);
      if (!shipsSeen.has(sid)) { shipsSeen.add(sid); K.k++; K.iskK += r.val; bump(K.sys, r.s); bump(K.kills, r.v); bump(L.killedBy, sid); }
      bump(K.kf, fid);
      if (fb) { K.fb++; if (r.solo) K.solo++; }
      if (!facsSeen.has(fid)) { facsSeen.add(fid); const A = fac(fid); A.k++; A.iskK += r.val; }
    }
  }
  // keep the most-used ships and trim each ship's detail lists
  const keep = Object.entries(S.ships).sort((a, b) => (b[1].k + b[1].l) - (a[1].k + a[1].l)).slice(0, MAX_SHIPS);
  S.ships = Object.fromEntries(keep.map(([id, s]) => [id, { ...s, sys: top(s.sys, 5), kills: top(s.kills, 5), killedBy: top(s.killedBy, 5), mods: top(s.mods, 14) }]));
  return S;
}

// Ship names with their group (class), module names. Looked up once and cached.
async function resolveTypes(shipIds, modIds) {
  const cache = await readJSON(TYPES, { ships: {}, groups: {}, mods: {} });
  const newShips = shipIds.filter(id => !cache.ships[id]);
  await pool(newShips, 6, async id => {
    const { data } = await esi(`/universe/types/${id}/`);
    cache.ships[id] = [data.name, data.group_id];
  });
  const newGroups = [...new Set(Object.values(cache.ships).map(s => s[1]))].filter(g => g && !cache.groups[g]);
  await pool(newGroups, 6, async gid => { const { data } = await esi(`/universe/groups/${gid}/`); cache.groups[gid] = data.name; });
  const newMods = modIds.filter(id => !cache.mods[id]);
  if (newMods.length) Object.assign(cache.mods, await names(newMods));
  await writeJSON(TYPES, cache);
  const ships = {};
  for (const id of shipIds) if (cache.ships[id]) ships[id] = [cache.ships[id][0], cache.groups[cache.ships[id][1]] || ""];
  const mods = {};
  for (const id of modIds) if (cache.mods[id]) mods[id] = cache.mods[id];
  return { ships, mods };
}

export async function updateFwShips(entries, log = console.log) {
  // warzone systems and which warzone each belongs to, from the saved Frontlines feed
  const wz = await readJSON(`${DATA}/public/warzone.json`, null);
  const zoneOf = new Map();
  for (const s of (wz && wz.feed) || []) {
    const z = EMPIRES[s.occupierFaction] || EMPIRES[s.ownerFaction];
    if (z && typeof s.solarsystemID === "number") zoneOf.set(s.solarsystemID, z);
  }
  const store = await readJSON(STORE, []);
  const seen = new Set(store.map(r => r.id));
  let added = 0;
  for (const d of entries) {
    const r = compact(d, zoneOf);
    if (r && r.id && !seen.has(r.id)) { store.push(r); seen.add(r.id); added++; }
  }
  const now = Math.floor(Date.now() / 1000);
  const kept = store.filter(r => now - r.t < KEEP_S && r.w); // also drops kills outside the warzones saved before this rule
  await writeJSON(STORE, kept);

  const windows = {};
  for (const [name, span] of [["24h", 86400], ["7d", KEEP_S]]) {
    const inWindow = kept.filter(r => now - r.t < span);
    windows[name] = {};
    for (const zone of ["all", "cg", "am"]) {
      const inZone = inWindow.filter(r => zone === "all" || r.z === zone);
      windows[name][zone] = { militia: aggregate(inZone.filter(r => r.m)), all: aggregate(inZone) };
    }
  }
  const shipIds = new Set(), modIds = new Set();
  for (const w of Object.values(windows)) for (const z of Object.values(w)) for (const S of Object.values(z)) {
    for (const [id, s] of Object.entries(S.ships)) {
      shipIds.add(+id);
      Object.keys(s.kills).forEach(x => shipIds.add(+x)); Object.keys(s.killedBy).forEach(x => shipIds.add(+x));
      Object.keys(s.mods).forEach(x => modIds.add(+x));
    }
  }
  let types = { ships: {}, mods: {} };
  try { types = await resolveTypes([...shipIds], [...modIds]); } catch (e) { log(`  couldn't resolve some ship names (${e.message})`); }
  const oldest = kept.length ? Math.min(...kept.map(r => r.t)) : now;
  await writeJSON(OUT, { updated: new Date().toISOString(), since: new Date(oldest * 1000).toISOString(), types, windows });
  log(`FW ship stats: ${added} new FW kills, ${kept.length} kept for 7 days (${kept.filter(r => r.m).length} involving militia)`);
}
