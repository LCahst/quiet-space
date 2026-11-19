// Quiet Space recent kills, kept up to date every minute on Cloudflare's free Workers plan.
//
// Every minute: read new kills from zKillboard's R2Z2 feed (one request per kill) and keep the last
// 90 minutes in 1-minute slices per system. Serves the same kills-recent.json the GitHub Action makes,
// so the page can load an up-to-the-minute snapshot and only top up the last minute or so live.
//
// Free plan limits that shape this: about 50 outgoing requests per run (so at most MAX_FETCH kills
// per run; the feed averages about 5 a minute) and 10 ms of CPU (waiting on the network doesn't count).
// State lives in one D1 row, because the free Workers KV allows only 1,000 writes a day.

import gatesBin from "./gates.bin"; // ArrayBuffer (wrangler bundles .bin files as data)
import { isAreaKill } from "./area-weapons.mjs";

const R2Z2 ="https://r2z2.zkillboard.com/ephemeral";
const SEED_URL = "https://lcahst.github.io/quiet-space/data/kills-recent.json"; // GitHub snapshot, used once to start
const GATE_KM = 100;            // a kill within this distance of a stargate counts as a gate kill
const UA = "QuietSpace/1.0 (+https://github.com/LCahst/quiet-space)";
const MAX_FETCH = 40;           // kills per run, leaving room under the ~50 request limit
const GAP_MS = 100;             // zKillboard asks for no more than about 10 requests a second
const SLICE = 60;               // 1-minute slices
const KEEP_SECONDS = 90 * 60;   // keep 90 minutes of slices
const MAX_BEHIND = 3000;        // if this far behind (about 10 hours), skip ahead rather than crawl

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*"
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);

async function loadState(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)").run();
  const row = await env.DB.prepare("SELECT value FROM state WHERE key = 'recent'").first();
  return row ? JSON.parse(row.value) : null;
}
async function saveState(env, s) {
  await env.DB.prepare("INSERT INTO state (key, value) VALUES ('recent', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify(s)).run();
}
const get = url => fetch(url, { headers: { "User-Agent": UA, "Accept-Encoding": "gzip" }, cf: { cacheTtl: 0 } });

// Stargate positions in km, bundled with the Worker as raw 64-bit floats (built by
// scripts/build-worker-gates.mjs), so a run needs no download or JSON parsing. Layout:
// [n, systemIds x n (ascending), starts x (n + 1), x, y, z, ...].
const GATES = new Float64Array(gatesBin);
const GATE_N = GATES[0];
const GATE_COORDS = 1 + GATE_N + GATE_N + 1; // where the coordinates begin
// Index range of a system's gate coordinates, or null if it has none (binary search on the sorted ids).
function gateRange(sys) {
  let lo = 1, hi = GATE_N;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, id = GATES[mid];
    if (id === sys) { const s = 1 + GATE_N + (mid - 1); return [GATE_COORDS + GATES[s], GATE_COORDS + GATES[s + 1]]; }
    if (id < sys) lo = mid + 1; else hi = mid - 1;
  }
  return null;
}
// PvP: at least one attacker is a player pilot, a player corporation (for example its structure), or CONCORD
// (whose kills follow a player attacking someone in high sec). NPC corporations have IDs 1,000,000 to 1,999,999.
const CONCORD_CORP = 1000125;
function isPvp(km) {
  return (km.attackers || []).some(a => a.character_id || a.corporation_id === CONCORD_CORP ||
    (a.corporation_id && !(a.corporation_id >= 1000000 && a.corporation_id < 2000000)));
}
// PvP between ships: a piloted ship or capsule lost, with a player pilot or CONCORD among the attackers.
// Leaves out structure and deployable losses (no pilot) and kills made only by a player's structure.
function isPvpShip(km) {
  return !!(km.victim && km.victim.character_id) && (km.attackers || []).some(a => a.character_id || a.corporation_id === CONCORD_CORP);
}
function onGate(sys, p) {
  const r = gateRange(sys);
  if (!r || !p) return false;
  const x = p.x / 1000, y = p.y / 1000, z = p.z / 1000, g = GATES;
  for (let i = r[0]; i < r[1]; i += 3) {
    const dx = x - g[i], dy = y - g[i + 1], dz = z - g[i + 2];
    if (dx * dx + dy * dy + dz * dz <= GATE_KM * GATE_KM) return true;
  }
  return false;
}

async function update(env) {
  let s = await loadState(env);
  const head = await (await get(`${R2Z2}/sequence.json`)).json();
  if (typeof head.sequence !== "number") throw new Error("sequence.json has no sequence number");

  if (!s) {
    // First run: start from the GitHub snapshot so the first 90 minutes aren't empty.
    s = { next: head.sequence, slices: {}, ids: {}, runs: 0 };
    try {
      const seed = await (await get(SEED_URL)).json();
      if (seed && seed.slices && typeof seed.nextSeq === "number") {
        s.slices = seed.slices; s.gateSlices = seed.gateSlices || {};
        s.pvpSlices = seed.pvpSlices || {}; s.gatePvpSlices = seed.gatePvpSlices || {};
        s.pvpShipSlices = seed.pvpShipSlices || {}; s.gatePvpShipSlices = seed.gatePvpShipSlices || {}; s.areaSlices = seed.areaSlices || {}; s.next = seed.nextSeq;
      }
    } catch { /* start empty from the current head */ }
  }
  s.gateSlices ||= {}; // state saved before gate kills were counted
  s.pvpSlices ||= {}; s.gatePvpSlices ||= {}; s.pvpShipSlices ||= {}; s.gatePvpShipSlices ||= {}; // or before PvP kills were
  s.areaSlices ||= {}; // or before smartbomb and bomb kills were
  if (head.sequence - s.next > MAX_BEHIND) s.next = head.sequence - MAX_BEHIND;

  // Read forward one kill at a time until the feed has nothing newer (404) or this run's budget is spent.
  let fetched = 0, added = 0, stopped = "caught up";
  while (fetched < MAX_FETCH) {
    const res = await get(`${R2Z2}/${s.next}.json`);
    fetched++;
    if (res.status === 404) {
      // A 404 past the announced head means "not yet". Below it, the kill has expired: skip it.
      if (s.next > head.sequence) break;
      s.next++; continue;
    }
    if (!res.ok) { stopped = `zKillboard answered ${res.status}`; break; } // retry this kill next run
    const d = await res.json();
    s.next++;
    const km = d.esi || d.killmail || (d.victim ? d : null);
    const id = d.killmail_id || (km && km.killmail_id);
    if (km && id && typeof km.solar_system_id === "number" && km.solar_system_id < 32000000 && !s.ids[id]) {
      const t = Math.floor(Date.parse(km.killmail_time || new Date().toISOString()) / 1000);
      s.ids[id] = t; // reprocessed kills can reappear under a new sequence number; count each kill once
      const add = slices => { const x = (slices[Math.floor(t / SLICE) * SLICE] ||= {}); x[km.solar_system_id] = (x[km.solar_system_id] || 0) + 1; };
      const gate = onGate(km.solar_system_id, km.victim && km.victim.position);
      add(s.slices);
      if (gate) add(s.gateSlices);
      const pvp = isPvp(km);
      if (pvp) { add(s.pvpSlices); if (gate) add(s.gatePvpSlices); }
      if (pvp && isAreaKill(km)) add(s.areaSlices); // a player's smartbomb or bomb among the weapons
      if (isPvpShip(km)) { add(s.pvpShipSlices); if (gate) add(s.gatePvpShipSlices); }
      added++;
    }
    await sleep(GAP_MS);
  }
  if (fetched >= MAX_FETCH) stopped = "run budget reached";

  // Drop anything older than 90 minutes.
  const cutoff = now() - KEEP_SECONDS;
  for (const k of Object.keys(s.slices)) if (+k < cutoff) delete s.slices[k];
  for (const sl of [s.gateSlices, s.pvpSlices, s.gatePvpSlices, s.pvpShipSlices, s.gatePvpShipSlices, s.areaSlices]) for (const k of Object.keys(sl)) if (+k < cutoff) delete sl[k];
  for (const [id, t] of Object.entries(s.ids)) if (t < cutoff) delete s.ids[id];

  s.updated = new Date().toISOString();
  s.behind = Math.max(0, head.sequence - s.next); // rough: sequence.json only moves every 51 kills
  s.runs = (s.runs || 0) + 1;
  s.lastRun = { fetched, added, stopped };
  await saveState(env, s);
  console.log(`next ${s.next}, head ${head.sequence}, fetched ${fetched}, new kills ${added}, ${stopped}`);
}

function json(body, status = 200, extra = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status, headers: { ...CORS, "Content-Type": "application/json", ...extra }
  });
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(update(env));
  },
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const { pathname } = new URL(req.url);
    if (pathname === "/kills-recent.json") {
      const s = await loadState(env);
      if (!s) return json({ error: "not ready yet" }, 503);
      // Same shape as the GitHub snapshot, plus how fresh and how far behind the feed it is.
      // gateSlices: kills within 100 km of a stargate; pvpSlices and gatePvpSlices: the same, PvP only (see isPvp).
      // areaSlices: PvP kills where an attacker used a smartbomb or bomb (see area-weapons.mjs).
      return json({ updated: s.updated, nextSeq: s.next, sliceSeconds: SLICE, slices: s.slices, gateSlices: s.gateSlices || {},
        pvpSlices: s.pvpSlices || {}, gatePvpSlices: s.gatePvpSlices || {},
        pvpShipSlices: s.pvpShipSlices || {}, gatePvpShipSlices: s.gatePvpShipSlices || {}, areaSlices: s.areaSlices || {}, behind: s.behind, source: "worker" },
        200, { "Cache-Control": "public, max-age=15" });
    }
    if (pathname === "/status") {
      const s = await loadState(env);
      return json(s ? { updated: s.updated, next: s.next, behind: s.behind, runs: s.runs, lastRun: s.lastRun, slices: Object.keys(s.slices).length } : { error: "not ready yet" });
    }
    return json({ error: "not found" }, 404);
  }
};
