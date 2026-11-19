// 30-day log of stripped-down kills, so the site can split its longer-term figures into all kills,
// PvP kills and PvP ship-and-pod kills.
//
// One file per day, data/kills/YYYY-MM-DD.ndjson, with one JSON array per line:
//   [killId, unixTime, systemId, shipTypeId, isk, flags, gateKm]
// flags (add together): 1 PvP (a player pilot, a player corporation or CONCORD among the attackers),
//   2 PvP between ships (a piloted ship or capsule lost to a player pilot or CONCORD), 4 a smartbomb or bomb
//   among the attackers' weapons (from 2026-11-19; see worker/src/area-weapons.mjs), 8 killed only by NPCs.
// gateKm: distance from the nearest stargate in whole km, or null when unknown. "On a gate" is worked out
//   from it when the figures are built, so the gate distance can change later for every stored kill.
// Nothing else is kept: no attackers, fittings or names.
import { readFile, appendFile, mkdir, readdir, unlink } from "node:fs/promises";

export const F_PVP = 1, F_SHIP = 2, F_AREA = 4, F_NPC = 8;
export const KEEP_DAYS = 30;
const dayOf = t => new Date(t * 1000).toISOString().slice(0, 10);
const dayNum = d => Math.floor(Date.parse(d + "T00:00:00Z") / 86400e3);

async function readDay(file) {
  let text;
  try { text = await readFile(file, "utf8"); } catch { return []; }
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip a damaged line rather than lose the day */ }
  }
  return rows;
}

// Add new kills to their day's file. Kills already in that file (by kill ID) are skipped.
export async function appendKills(dir, rows) {
  await mkdir(dir, { recursive: true });
  const byDay = {};
  for (const r of rows) (byDay[dayOf(r[1])] ||= []).push(r);
  let added = 0;
  for (const [day, list] of Object.entries(byDay)) {
    const file = `${dir}/${day}.ndjson`;
    const seen = new Set((await readDay(file)).map(r => r[0]));
    const fresh = [];
    for (const r of list) if (!seen.has(r[0])) { seen.add(r[0]); fresh.push(r); }
    if (!fresh.length) continue;
    await appendFile(file, fresh.map(r => JSON.stringify(r)).join("\n") + "\n");
    added += fresh.length;
  }
  return added;
}

// Delete days older than KEEP_DAYS, then read the rest. Returns { rows, days: [day, ...] }.
export async function loadLog(dir) {
  await mkdir(dir, { recursive: true });
  const today = Math.floor(Date.now() / 86400e3);
  const rows = [], days = [];
  for (const f of (await readdir(dir)).filter(f => /^\d{4}-\d\d-\d\d\.ndjson$/.test(f)).sort()) {
    const d = f.slice(0, 10);
    if (today - dayNum(d) >= KEEP_DAYS) { await unlink(`${dir}/${f}`); continue; }
    days.push(d);
    for (const r of await readDay(`${dir}/${f}`)) rows.push(r);
  }
  return { rows, days };
}

// PvP and ships-only versions of the 7- and 30-day ISK windows (same shape as isk.json's windows:
// systems { id: [isk, kills] } and the top 10 systems with their 3 biggest kills), plus rolling
// 24-hour kill counts.
export function buildSplits(rows) {
  const today = Math.floor(Date.now() / 86400e3), now = Date.now() / 1000;
  const kinds = { pvp: F_PVP, ship: F_SHIP };
  const windows = {};
  for (const span of [7, 30]) {
    const w = {};
    for (const [kind, bit] of Object.entries(kinds)) {
      const totals = {};
      for (const r of rows) {
        if (!(r[5] & bit) || today - Math.floor(r[1] / 86400) >= span) continue;
        const t = (totals[r[2]] ||= [0, 0, []]);
        t[0] += r[4]; t[1]++;
        t[2].push([r[0], r[4], r[3]]);
      }
      const systems = {}, list = [];
      for (const [id, [isk, n, kills]] of Object.entries(totals)) {
        systems[id] = [isk, n];
        list.push([+id, isk, n, kills.sort((a, b) => b[1] - a[1]).slice(0, 3)]);
      }
      list.sort((a, b) => b[1] - a[1]);
      w[kind] = { systems, top: list.slice(0, 10) };
    }
    windows[span] = w;
  }
  const kills24 = { pvp: {}, ship: {} };
  for (const r of rows) {
    if (r[1] < now - 86400) continue;
    if (r[5] & F_PVP) kills24.pvp[r[2]] = (kills24.pvp[r[2]] || 0) + 1;
    if (r[5] & F_SHIP) kills24.ship[r[2]] = (kills24.ship[r[2]] || 0) + 1;
  }
  return { windows, kills24 };
}
