// Run once (from the Action's "Backfill 30 days of kills" option): fills the last 30 days of kills from
// zKillboard's daily archives (https://r2z2.zkillboard.com/history/raw/YYYYMMDD.json), so the 30-day
// figures don't have to wait for the live feed to collect a month.
//
// Adds to the same files the live collector (collect-isk.mjs) keeps, and only kills they don't already have
// (matched by kill ID), so days already collected keep their kills and values. Run it just before
// collect-isk.mjs, which then rebuilds isk.json, the PvP splits and the kill-by-time-of-week files.
//   - data/history-isk/YYYY-MM-DD.json: ISK destroyed and kill counts per system
//   - data/kills/YYYY-MM-DD.ndjson: the 30-day kill log (scripts/lib/killlog.mjs)
//   - the "collecting since" dates in data/cache/r2z2.json and data/cache/killlog.json move back to the
//     first day filled, so the pages stop saying "N days so far"
//
// The archive has CCP's killmails without zKillboard's ISK values or labels, so for added kills:
//   - ISK: the hull and every destroyed and dropped item at CCP's ESI average prices (empty capsule 10,000 ISK,
//     as zKillboard values it; blueprint copies 0). Checked against two days collected live (19-20 Nov 2026):
//     total 1.008 times zKillboard's, per system within 5% for 90% of systems. Prices are today's, not the day's.
//   - "killed only by NPCs": no attacker is a player pilot or player corporation (agreed with zKillboard's
//     label for 99.7% of kills in the same check). The other flags and the gate distance use the live rules.
// Running it again adds nothing new. Today is left to the live feed; Abyssal kills are skipped, as live.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { appendKills, F_PVP, F_SHIP, F_AREA, F_NPC, KEEP_DAYS } from "./lib/killlog.mjs";
import { isAreaKill } from "../worker/src/area-weapons.mjs";
import { ESI } from "./lib/esi.mjs";

const DATA = process.env.DATA_DIR || "data";
const ARCHIVE = process.env.R2Z2_HISTORY || "https://r2z2.zkillboard.com/history/raw";
const CACHE = process.env.BACKFILL_CACHE || ""; // optional folder to keep downloads in (for local testing)
const DAYS = Math.min(KEEP_DAYS, +(process.env.BACKFILL_DAYS || KEEP_DAYS));
const UA = `QuietSpace/1.0 (+https://github.com/${process.env.GITHUB_REPOSITORY || "local"})`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJSON = async (file, fallback) => { try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; } };
const writeJSON = async (file, obj) => { await mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true }); await writeFile(file, JSON.stringify(obj)); };

async function getJSON(url, cacheName) {
  const cached = CACHE && `${CACHE}/${cacheName}`;
  if (cached && existsSync(cached)) return JSON.parse(await readFile(cached, "utf8"));
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(120000) });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) throw new Error(`answered ${res.status}`);
      if (!res.ok) throw new Error(`answered ${res.status}`);
      const text = await res.text();
      if (cached) { await mkdir(CACHE, { recursive: true }); await writeFile(cached, text); }
      return JSON.parse(text);
    } catch (e) {
      if (attempt >= 3) throw new Error(`${url} ${e.message}`);
      await sleep(5000 * (attempt + 1));
    }
  }
}

// Same rules as collect-isk.mjs
const CONCORD_CORP = 1000125;
const npcCorp = id => id >= 1000000 && id < 2000000;
const isPvp = km => (km.attackers || []).some(a => a.character_id || a.corporation_id === CONCORD_CORP || (a.corporation_id && !npcCorp(a.corporation_id)));
const isPvpShip = km => !!(km.victim && km.victim.character_id) && (km.attackers || []).some(a => a.character_id || a.corporation_id === CONCORD_CORP);
const isNpcOnly = km => !(km.attackers || []).some(a => a.character_id || (a.corporation_id && !npcCorp(a.corporation_id)));
function nearestGateKm(gates, km) {
  const g = gates && gates[km.solar_system_id], p = km.victim.position;
  if (!g || !p) return null;
  const x = p.x / 1000, y = p.y / 1000, z = p.z / 1000;
  let best = Infinity;
  for (let i = 0; i < g.length; i += 3) best = Math.min(best, Math.hypot(x - g[i], y - g[i + 1], z - g[i + 2]));
  return Number.isFinite(best) ? Math.round(best) : null;
}

const prices = await getJSON(`${ESI}/markets/prices/`, "esi-prices.json");
if (!Array.isArray(prices) || prices.length < 1000) throw new Error("ESI market prices unavailable; nothing changed");
const avg = new Map(prices.map(p => [p.type_id, p.average_price ?? p.adjusted_price ?? 0]));
const CAPSULES = new Set([670, 33328]); // no market price; zKillboard values an empty capsule at 10,000 ISK
function itemsValue(items) {
  let v = 0;
  for (const it of items || []) {
    if (it.singleton !== 2) v += ((it.quantity_destroyed || 0) + (it.quantity_dropped || 0)) * (avg.get(it.item_type_id) || 0);
    if (it.items) v += itemsValue(it.items);
  }
  return v;
}
const valueOf = km => (CAPSULES.has(km.victim.ship_type_id) ? 10000 : (avg.get(km.victim.ship_type_id) || 0)) + itemsValue(km.victim.items);

const gates = await readJSON(`${DATA}/public/gates.json`, null);
if (!gates) log("No stargate positions (data/public/gates.json): gate distances left unknown");

// Newest first, so a failure part-way leaves an unbroken run of days back from yesterday.
const todayN = Math.floor(Date.now() / 86400e3);
const isoOf = n => new Date(n * 86400e3).toISOString().slice(0, 10);
let earliest = null, addedLog = 0, addedIsk = 0, iskAdded = 0;
for (let n = todayN - 1; n > todayN - DAYS; n--) {
  const day = isoOf(n);
  let raw;
  try { raw = await getJSON(`${ARCHIVE}/${day.replaceAll("-", "")}.json`, `raw-${day}.json`); }
  catch (e) { log(`${day}: ${e.message}; stopping here`); break; }
  // zKillboard posts each day's archive some hours after it ends; the live feed already has the latest days
  if (!raw && n >= todayN - 2 && !earliest) { log(`${day}: no archive yet (the live feed has this day)`); continue; }
  if (!raw) { log(`${day}: no archive; stopping here`); break; }
  const kms = (Array.isArray(raw) ? raw : Object.values(raw))
    .filter(km => km && km.victim && typeof km.solar_system_id === "number" && km.solar_system_id < 32000000 && km.killmail_id);

  // ISK history: add kills the day file doesn't have
  const file = `${DATA}/history-isk/${day}.json`;
  const h = await readJSON(file, { day, ids: [], systems: {} });
  const seen = new Set(h.ids);
  const rows = [];
  let dayIsk = 0, dayAdded = 0;
  for (const km of kms) {
    const value = valueOf(km);
    rows.push([km.killmail_id, Math.floor(Date.parse(km.killmail_time) / 1000), km.solar_system_id, km.victim.ship_type_id || 0, Math.round(value),
      (isPvp(km) ? F_PVP : 0) | (isPvpShip(km) ? F_SHIP : 0) | (isAreaKill(km) ? F_AREA : 0) | (isNpcOnly(km) ? F_NPC : 0), nearestGateKm(gates, km)]);
    if (seen.has(km.killmail_id)) continue;
    seen.add(km.killmail_id); h.ids.push(km.killmail_id);
    const e = (h.systems[km.solar_system_id] ||= [0, 0, []]);
    e[0] += value; e[1]++;
    e[2].push([km.killmail_id, Math.round(value), km.victim.ship_type_id || 0]);
    e[2].sort((a, b) => b[1] - a[1]); e[2].length = Math.min(e[2].length, 3);
    dayAdded++; dayIsk += value;
  }
  await writeJSON(file, h);
  const logAdded = await appendKills(`${DATA}/kills`, rows);
  addedIsk += dayAdded; iskAdded += dayIsk; addedLog += logAdded;
  earliest = day;
  log(`${day}: ${kms.length} kills in the archive; added ${dayAdded} to the ISK history (${(dayIsk / 1e9).toFixed(0)}B ISK), ${logAdded} to the kill log`);
  await sleep(1000); // one archive a second at most
}

if (earliest) {
  // Move the "collecting since" dates back, so the windows count as full days collected
  const st = await readJSON(`${DATA}/cache/r2z2.json`, null);
  if (st && (!st.since || st.since > earliest)) await writeJSON(`${DATA}/cache/r2z2.json`, { ...st, since: earliest });
  const kl = await readJSON(`${DATA}/cache/killlog.json`, null) || {};
  if (!kl.since || kl.since > earliest) await writeJSON(`${DATA}/cache/killlog.json`, { ...kl, since: earliest });
  await writeJSON(`${DATA}/cache/backfill.json`, { ran: new Date().toISOString(), from: earliest, to: isoOf(todayN - 1),
    addedToIskHistory: addedIsk, addedToKillLog: addedLog, valuedAt: "ESI average prices on the day of the backfill" });
}
log(`Backfill done: back to ${earliest || "nothing"}; ${addedIsk} kills (${(iskAdded / 1e12).toFixed(2)}T ISK) added to the ISK history, ${addedLog} to the kill log`);
