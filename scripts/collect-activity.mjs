// Hourly job: records ESI's last-hour jumps and kills, keeps 12 weeks of history,
// and writes the 30-day averages and weekly (day-of-week x hour) patterns the site shows.
import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { esi, stats } from "./lib/esi.mjs";

const DATA = process.env.DATA_DIR || "data";
const HIST = `${DATA}/history`;
const PUB = `${DATA}/public`;
const KEEP_DAYS = 84;     // 12 weeks of history for the weekly pattern
const AVG_DAYS = 30;      // window for the average column

const readJSON = async (file, fallback) => { try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; } };
const writeJSON = async (file, obj) => {
  await mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  await writeFile(file, JSON.stringify(obj));
};
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

// 1. Fetch the latest hour. ESI's Last-Modified marks the end of the hour it covers.
const [jumps, kills] = await Promise.all([esi("/universe/system_jumps/"), esi("/universe/system_kills/")]);
const lm = jumps.headers.get("last-modified");
const end = lm ? new Date(lm) : new Date();
const start = new Date(end.getTime() - 3600e3);
const day = start.toISOString().slice(0, 10);
const hour = start.getUTCHours();
log(`ESI data covers ${start.toISOString().slice(0, 13)}:00 UTC`);

// 2. Add it to that day's history file (once per hour, even if the job runs twice).
const file = `${HIST}/${day}.json`;
const h = await readJSON(file, { day, hours: [], j: {}, k: {}, n: {} });
if (h.hours.includes(hour)) {
  log("This hour is already recorded; refreshing outputs only.");
} else {
  h.hours.push(hour);
  h.hours.sort((a, b) => a - b);
  for (const r of jumps.data) {
    if (!r.ship_jumps) continue;
    (h.j[r.system_id] ||= Array(24).fill(0))[hour] = r.ship_jumps;
  }
  for (const r of kills.data) {
    const pvp = (r.ship_kills || 0) + (r.pod_kills || 0);
    if (pvp) h.k[r.system_id] = (h.k[r.system_id] || 0) + pvp;
    if (r.npc_kills) h.n[r.system_id] = (h.n[r.system_id] || 0) + r.npc_kills;
  }
  await writeJSON(file, h);
  log(`Recorded hour ${hour} for ${day}: ${Object.keys(h.j).length} systems with jumps so far today`);
}

// 3. Drop history older than 12 weeks.
await mkdir(HIST, { recursive: true });
const today = new Date(end.getTime());
const dayNum = d => Math.floor(Date.parse(d + "T00:00:00Z") / 86400e3);
const nowDay = Math.floor(today.getTime() / 86400e3);
const files = (await readdir(HIST)).filter(f => /^\d{4}-\d\d-\d\d\.json$/.test(f)).sort();
const history = [];
for (const f of files) {
  const d = f.slice(0, 10);
  if (nowDay - dayNum(d) >= KEEP_DAYS) { await unlink(`${HIST}/${f}`); log(`Removed old history ${d}`); continue; }
  history.push(await readJSON(`${HIST}/${f}`, null));
}
const days = history.filter(Boolean);

// 4. 30-day averages per captured hour: [jumps, ship+pod kills, NPC kills].
const recent = days.filter(d => nowDay - dayNum(d.day) < AVG_DAYS);
const hours30 = recent.reduce((t, d) => t + d.hours.length, 0);
const sums = {};
const add = (id, i, v) => { (sums[id] ||= [0, 0, 0])[i] += v; };
for (const d of recent) {
  for (const [id, arr] of Object.entries(d.j)) add(id, 0, arr.reduce((t, v) => t + v, 0));
  for (const [id, v] of Object.entries(d.k)) add(id, 1, v);
  for (const [id, v] of Object.entries(d.n)) add(id, 2, v);
}
const avg = {};
for (const [id, s] of Object.entries(sums)) avg[id] = [round(s[0] / hours30, 2), round(s[1] / hours30, 3), round(s[2] / hours30, 2)];
await writeJSON(`${PUB}/activity.json`, { updated: end.toISOString(), hours: hours30, days: recent.length, systems: avg });
log(`30-day averages from ${hours30} captured hours across ${recent.length} days`);

// 5. Weekly patterns: for each of the 168 day-of-week/hour slots, a trimmed average of jumps
//    (drops the highest and lowest sample when there are at least 5). One file per region.
const catalog = await readJSON(`${PUB}/catalog.json`, null);
if (!catalog) {
  log("No catalog yet (map data builds first), so weekly patterns are skipped this run.");
} else {
  const weekday = d => (new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7; // Monday = 0
  const slots = days.map(d => ({ w: weekday(d.day), hours: d.hours, j: d.j }));
  const byRegion = {};
  for (const [id, s] of Object.entries(catalog.systems)) {
    const reg = catalog.consToRegion[s.c];
    if (reg !== undefined) (byRegion[reg] ||= []).push(id);
  }
  const weeks = round(days.length / 7, 1);
  for (const [reg, ids] of Object.entries(byRegion)) {
    const systems = {};
    for (const id of ids) {
      const samples = Array.from({ length: 168 }, () => []);
      for (const d of slots) {
        const arr = d.j[id];
        for (const hr of d.hours) samples[d.w * 24 + hr].push(arr ? arr[hr] : 0);
      }
      let any = false;
      const prof = samples.map(list => {
        if (!list.length) return null;
        const v = list.slice().sort((a, b) => a - b);
        const use = v.length >= 5 ? v.slice(1, -1) : v;
        const m = use.reduce((t, x) => t + x, 0) / use.length;
        if (m > 0) any = true;
        return round(m, 1);
      });
      systems[id] = any ? prof : (prof.some(x => x !== null) ? 0 : null);
    }
    await writeJSON(`${PUB}/profiles/${reg}.json`, { updated: end.toISOString(), weeks, days: days.length, systems });
  }
  log(`Weekly patterns for ${Object.keys(byRegion).length} regions from ${days.length} days (${weeks} weeks)`);
}
log(`ESI requests: ${stats.requests}, retries: ${stats.retries}, failures: ${stats.failures}`);
