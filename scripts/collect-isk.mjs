// Runs about every 15 minutes: reads every new kill from zKillboard's R2Z2 feed
// (https://github.com/zKillboard/zKillboard/wiki/API-(R2Z2)) since the last run, and keeps:
//   - 30 days of ISK destroyed per system, with each system's biggest kills (data/public/isk.json)
//   - a rolling 24-hour kill count per system, for the faction warfare page (data/public/kills24.json)
//   - the last 90 minutes of kills in 1-minute slices, for recent kills on the main page (data/public/kills-recent.json)
// R2Z2 keeps each kill for at least 24 hours, so a skipped run is caught up next time.
// If the feed is unavailable, the last files are kept.
import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { names } from "./lib/esi.mjs";
import { updateFwShips } from "./lib/fwships.mjs";

const DATA = process.env.DATA_DIR || "data";
const R2Z2 = process.env.R2Z2_BASE || "https://r2z2.zkillboard.com/ephemeral";
const HIST = `${DATA}/history-isk`;
const STATE = `${DATA}/cache/r2z2.json`;
const KEEP_DAYS = 30;
const FIRST_RUN_BACKFILL = +(process.env.ISK_BACKFILL || 6000); // about half a day of kills on the very first run
const MAX_PER_RUN = +(process.env.ISK_MAX_PER_RUN || 20000);
const CONCURRENCY = 3;
// zKillboard allows 20 requests per second per IP. Stay well under it: requests start at least
// MIN_GAP_MS apart however many are in flight, and a 429 pauses every request.
const MIN_GAP_MS = +(process.env.ISK_MIN_GAP_MS || 100);
// Keep each hourly run short: stop after this long and carry on next run. A request gets this long to answer.
const RUN_BUDGET_MS = +(process.env.ISK_BUDGET_MS || 12 * 60 * 1000);
const REQUEST_TIMEOUT_MS = +(process.env.ISK_REQUEST_TIMEOUT_MS || 20000);
const startedAt = Date.now();
const outOfTime = () => Date.now() - startedAt > RUN_BUDGET_MS;
const UA = `QuietSpace/1.0 (+https://github.com/${process.env.GITHUB_REPOSITORY || "local"})`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJSON = async (file, fallback) => { try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; } };
const writeJSON = async (file, obj) => {
  await mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  await writeFile(file, JSON.stringify(obj));
};

let nextSlot = 0, pausedUntil = 0, rateLimited = 0;
async function slot() {
  for (;;) {
    const now = Date.now();
    const at = Math.max(nextSlot, pausedUntil);
    if (at <= now) { nextSlot = now + MIN_GAP_MS; return; }
    await sleep(at - now);
  }
}
async function getSeq(n, attempt = 0) {
  await slot();
  const res = await fetch(`${R2Z2}/${n}.json`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (res.status === 429) {
    rateLimited++;
    const wait = (+res.headers.get("retry-after") || 10) * 1000;
    pausedUntil = Math.max(pausedUntil, Date.now() + wait); // everyone waits, not just this request
    if (attempt < 8) return getSeq(n, attempt + 1);
  }
  if (res.status >= 500 && attempt < 3) { await sleep(2000); return getSeq(n, attempt + 1); }
  if (!res.ok) throw new Error(`R2Z2 answered ${res.status} for ${n}`);
  return res.json();
}
// Each entry carries the ESI killmail plus zKillboard's "zkb" block; read both tolerantly.
function parse(d) {
  const km = d.esi || d.killmail || (d.victim ? d : null);
  if (!km || !km.victim || typeof km.solar_system_id !== "number") return null;
  const zkb = d.zkb || km.zkb || {};
  return {
    id: d.killmail_id || km.killmail_id,
    day: (km.killmail_time || new Date().toISOString()).slice(0, 10),
    hour: (km.killmail_time || new Date().toISOString()).slice(0, 13), // "2026-11-02T15"
    t: Math.floor(Date.parse(km.killmail_time || new Date().toISOString()) / 1000),
    system: km.solar_system_id,
    ship: km.victim.ship_type_id || 0,
    value: +zkb.totalValue || 0
  };
}

try {
  const state = await readJSON(STATE, null);
  const head = await (await fetch(`${R2Z2}/sequence.json`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })).json();
  if (typeof head.sequence !== "number") throw new Error("sequence.json has no sequence number");
  let start = state?.next ?? Math.max(1, head.sequence - FIRST_RUN_BACKFILL);
  if (head.sequence - start > MAX_PER_RUN) start = head.sequence - MAX_PER_RUN; // don't fall hopelessly behind
  log(`R2Z2: reading from ${start} (latest announced ${head.sequence})${state ? "" : ", first run"}`);

  // Fetch forward with a few requests in flight, stopping at the first sequence that doesn't exist yet.
  const got = new Map();
  let next = start, end = Infinity, firstFailed = Infinity, stoppedForTime = false;
  async function worker() {
    while (next < end && next < firstFailed) {
      if (outOfTime()) { if (!stoppedForTime) { stoppedForTime = true; log(`  time budget reached at ${next}; the next run carries on from here`); } end = Math.min(end, next); break; }
      const n = next++;
      try {
        const d = await getSeq(n);
        if (d === null) {
          // Old sequences can expire; only treat a 404 as "caught up" once past the announced head.
          if (n > head.sequence) end = Math.min(end, n);
          continue;
        }
        got.set(n, d);
      } catch (e) {
        // Stop here and let the next run resume from this kill, rather than leaving a gap.
        if (n < firstFailed) { firstFailed = n; log(`  stopping at ${n}: ${e.message}; the next run resumes here`); }
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  for (const n of [...got.keys()]) if (n >= firstFailed) got.delete(n); // keep only the unbroken run of kills
  const last = Math.max(start - 1, ...got.keys());
  log(`Fetched ${got.size} kills in ${Math.round((Date.now() - startedAt) / 1000)}s${rateLimited ? ` (asked to slow down ${rateLimited} time${rateLimited === 1 ? "" : "s"})` : ""}`);

  // Add kills to their day's file: systems[id] = [isk, kills, [[killId, value, shipTypeId] x3 biggest]]
  const byDay = {};
  for (const d of got.values()) {
    const k = parse(d);
    if (!k || !k.id) continue;
    if (k.system >= 32000000) continue; // Abyssal deadspace isn't part of the rankings
    (byDay[k.day] ||= []).push(k);
  }
  const hourly = await readJSON(`${DATA}/cache/kills-hourly.json`, {}); // { "2026-11-02T15": { systemId: kills } }
  const recent = await readJSON(`${DATA}/cache/kills-recent.json`, {}); // { slice start (epoch seconds): { systemId: kills } }
  const SLICE = 60; // 1-minute slices, so "last 15 minutes" is accurate to within a minute
  for (const [day, list] of Object.entries(byDay)) {
    const file = `${HIST}/${day}.json`;
    const h = await readJSON(file, { day, ids: [], systems: {} });
    const seen = new Set(h.ids);
    for (const k of list) {
      if (seen.has(k.id)) continue;
      seen.add(k.id); h.ids.push(k.id);
      const bucket = (hourly[k.hour] ||= {});
      bucket[k.system] = (bucket[k.system] || 0) + 1;
      const slice = (recent[Math.floor(k.t / SLICE) * SLICE] ||= {});
      slice[k.system] = (slice[k.system] || 0) + 1;
      const e = (h.systems[k.system] ||= [0, 0, []]);
      e[0] += k.value; e[1]++;
      e[2].push([k.id, Math.round(k.value), k.ship]);
      e[2].sort((a, b) => b[1] - a[1]); e[2].length = Math.min(e[2].length, 3);
    }
    await writeJSON(file, h);
  }
  // "since" is the first day of collection, for "N days so far" (kills can arrive days after they happen).
  const since = state?.since || new Date().toISOString().slice(0, 10);
  await writeJSON(STATE, { next: Math.min(last + 1, firstFailed), since, updated: new Date().toISOString() });

  // Rolling 24-hour kill counts: keep the last 24 hourly buckets and total them per system.
  const cutoff = new Date(Date.now() - 24 * 3600e3).toISOString().slice(0, 13);
  for (const key of Object.keys(hourly)) if (key <= cutoff) delete hourly[key]; // keep only hours within the last 24
  const kills24 = {};
  for (const bucket of Object.values(hourly)) for (const [id, n] of Object.entries(bucket)) kills24[id] = (kills24[id] || 0) + n;
  await writeJSON(`${DATA}/cache/kills-hourly.json`, hourly);
  await writeJSON(`${DATA}/public/kills24.json`, { updated: new Date().toISOString(), hours: Object.keys(hourly).length, systems: kills24 });
  log(`24-hour kill counts: ${Object.values(kills24).reduce((a, b) => a + b, 0)} kills across ${Object.keys(kills24).length} systems`);

  // Recent kills: keep 90 minutes of 1-minute slices. nextSeq tells the page where this snapshot ends in
  // zKillboard's feed, so it can carry on from there live without counting anything twice.
  const recentCutoff = Math.floor(Date.now() / 1000) - 90 * 60;
  for (const key of Object.keys(recent)) if (+key < recentCutoff) delete recent[key];
  await writeJSON(`${DATA}/cache/kills-recent.json`, recent);
  await writeJSON(`${DATA}/public/kills-recent.json`, { updated: new Date().toISOString(), nextSeq: Math.min(last + 1, firstFailed), sliceSeconds: SLICE, slices: recent });
  const in15 = Object.entries(recent).filter(([t]) => +t >= Math.floor(Date.now() / 1000) - 15 * 60).reduce((n, [, s]) => n + Object.values(s).reduce((a, b) => a + b, 0), 0);
  log(`Recent kills: ${in15} in the last 15 minutes`);

  // Drop days older than 30 days, then build the 7- and 30-day windows.
  await mkdir(HIST, { recursive: true });
  const today = Math.floor(Date.now() / 86400e3);
  const dayNum = d => Math.floor(Date.parse(d + "T00:00:00Z") / 86400e3);
  const days = [];
  for (const f of (await readdir(HIST)).filter(f => /^\d{4}-\d\d-\d\d\.json$/.test(f)).sort()) {
    const d = f.slice(0, 10);
    if (today - dayNum(d) >= KEEP_DAYS) { await unlink(`${HIST}/${f}`); continue; }
    days.push(await readJSON(`${HIST}/${f}`, null));
  }
  const build = span => {
    const totals = {};
    for (const h of days.filter(Boolean).filter(h => today - dayNum(h.day) < span)) {
      for (const [id, [isk, n, top]] of Object.entries(h.systems)) {
        if (+id >= 32000000) continue; // drop any Abyssal kills recorded before they were excluded
        const t = (totals[id] ||= [0, 0, []]);
        t[0] += isk; t[1] += n; t[2].push(...top);
      }
    }
    const systems = {}, list = [];
    for (const [id, [isk, n, top]] of Object.entries(totals)) {
      systems[id] = [Math.round(isk), n];
      list.push([+id, Math.round(isk), n, top.sort((a, b) => b[1] - a[1]).slice(0, 3)]);
    }
    list.sort((a, b) => b[1] - a[1]);
    return { systems, top: list.slice(0, 10) };
  };
  const windows = { "7": build(7), "30": build(30) };
  const typeIds = [...new Set(Object.values(windows).flatMap(w => w.top.flatMap(t => t[3].map(k => k[2]))).filter(Boolean))];
  // Wormhole systems (31xxxxxx, named J123456) aren't on the site's map, so send their names along.
  const extraSystems = [...new Set(Object.values(windows).flatMap(w => w.top.map(t => t[0])).filter(id => id >= 31000000))];
  let types = {}, systemNames = {};
  try { types = await names(typeIds); } catch (e) { log(`Couldn't resolve ship names (${e.message})`); }
  try { if (extraSystems.length) systemNames = await names(extraSystems); } catch (e) { log(`Couldn't resolve system names (${e.message})`); }
  const collected = Math.min(KEEP_DAYS, today - dayNum(since) + 1);
  await writeJSON(`${DATA}/public/isk.json`, { updated: new Date().toISOString(), days: collected, types, systemNames, windows });
  log(`ISK windows built after ${collected} day(s) of collecting: ${Object.keys(windows["30"].systems).length} systems with kills in 30 days`);
  // Faction warfare ship statistics from the same kills (kept separate so a problem there can't affect the rankings).
  try { await updateFwShips([...got.values()], log); } catch (e) { log(`FW ship stats skipped (${e.message})`); }
} catch (e) {
  let kept = "no previous file";
  try { kept = `keeping file from ${JSON.parse(await readFile(`${DATA}/public/isk.json`, "utf8")).updated}`; } catch {}
  log(`ISK collection unavailable (${e.message}); ${kept}.`);
}
