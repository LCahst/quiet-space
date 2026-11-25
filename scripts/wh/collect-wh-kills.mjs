// Wormhole section, phase 2: class-level kill statistics.
// Runs hourly in the Action (WH_OUT and WH_CACHE point it at the data branch there).
//
// Decisions this follows (2026-11-21): class level only, no per-system danger ranking, no corporation,
// alliance or character names, J-space only (no Pochven or Turnur).
//
// Run from the repo root after build-wormholes.mjs:
//   node scripts/wh/collect-wh-kills.mjs
//   KILLS_DIR=<folder>  the 30-day kill log (default data/kills; locally a read-only copy, see below)
//   OFFLINE=1           skip zKillboard and ESI, use cached responses only
//   WH_OUT=<folder>     where kills.json goes (default wormholes/data)
//   WH_CACHE=<folder>   cache folder (default wormholes/.cache)
//
// Local copy of the log without touching the working tree:
//   git fetch origin data && mkdir -p wormholes/.cache/data && git archive origin/data kills | tar -x -C wormholes/.cache/data
//
// Sources:
//   the site's own kill log (scripts/lib/killlog.mjs): [killId, time, systemId, shipTypeId, isk, flags, gateKm]
//   zKillboard /api/stats/regionID/{id}/kills/  monthly totals per J-space region (only the "months" block is kept)
//   ESI /universe/system_kills/                 checked each run to confirm it still leaves out wormhole space

import { readFile, writeFile, readdir, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { F_PVP, F_SHIP, F_NPC } from "../lib/killlog.mjs";
import { esi } from "../lib/esi.mjs";

const KILLS_DIR = process.env.KILLS_DIR || (existsSync("data/kills") ? "data/kills" : "wormholes/.cache/data/kills");
const SRC = "wormholes/data"; // reference data built by build-wormholes.mjs
const OUT = process.env.WH_OUT || SRC;
const CACHE = `${process.env.WH_CACHE || "wormholes/.cache"}/zkb`;
const OFFLINE = process.env.OFFLINE === "1";
const UA = `QuietSpace/1.0 (+https://github.com/${process.env.GITHUB_REPOSITORY || "local"})`;
const DAY = 86400;
const FIGHT_GAP = 3600;     // kills in one system less than an hour apart count as one fight
const MONTHS_KEPT = 13;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const readJSON = async f => JSON.parse(await readFile(f, "utf8"));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok, detail }); log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`); };

// ---------- reference data from phase 1 ----------
const sysFile = await readJSON(`${SRC}/systems.json`);
const victims = await readJSON(`${SRC}/victim-kinds.json`);
const kindOf = new Map();
for (const k of ["structure", "pos", "deployable", "capital", "pod", "starter"]) for (const id of victims[k]) kindOf.set(id, k);

const GROUP_OF_CLASS = c => c >= 1 && c <= 6 ? `C${c}` : c === 12 ? "Thera" : c === 13 ? "C13" : c >= 14 && c <= 18 ? "Drifter" : null;
const GROUPS = ["C1", "C2", "C3", "C4", "C5", "C6", "C13", "Thera", "Drifter"];
const sysInfo = new Map(sysFile.systems.map(s => [s.id, { group: GROUP_OF_CLASS(s.class), shattered: s.shattered, regionId: s.regionId }]));
const systemsPerGroup = {};
for (const s of sysInfo.values()) systemsPerGroup[s.group] = (systemsPerGroup[s.group] || 0) + 1;
systemsPerGroup.Shattered = [...sysInfo.values()].filter(s => s.shattered).length;

// ---------- read the kill log (read-only) ----------
const rows = [], days = [];
for (const f of (await readdir(KILLS_DIR)).filter(f => /^\d{4}-\d\d-\d\d\.ndjson$/.test(f)).sort()) {
  days.push(f.slice(0, 10));
  for (const line of (await readFile(`${KILLS_DIR}/${f}`, "utf8")).split("\n")) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a damaged line is skipped, as in killlog.mjs */ }
  }
}
log(`kill log: ${rows.length} kills in ${days.length} day files from ${KILLS_DIR}`);

// Deduplicate by kill ID (R2Z2 can re-emit a reprocessed kill).
const seen = new Set();
const all = rows.filter(r => !seen.has(r[0]) && seen.add(r[0]));
check("kill IDs unique after dedupe", true, `${rows.length - all.length} duplicates dropped`);

// Coverage: the log began part-way through a day and late reports trickle into the hours before that,
// so start at the first hour with at least a quarter of a typical busy hour's count. End at the last whole hour that finished at least 30 minutes ago.
const now = Date.now() / 1000;
const perHour = new Map();
for (const r of all) { const h = Math.floor(r[1] / 3600); perHour.set(h, (perHour.get(h) || 0) + 1); }
// "Typical" is the 90th-percentile hour: most hours before logging began hold one stray late kill,
// which would drag a median down to nothing.
const counts = [...perHour.values()].sort((a, b) => a - b), typical = counts[Math.floor(counts.length * 0.9)] || 0;
const start = Math.min(...[...perHour].filter(([, n]) => n >= typical / 4).map(([h]) => h)) * 3600;
const end = Math.floor((now - 1800) / 3600) * 3600;
const coveredHours = Math.max(0, (end - start) / 3600);
log(`coverage: ${new Date(start * 1000).toISOString()} to ${new Date(end * 1000).toISOString()} (${coveredHours} h)`);

const jRows = all.filter(r => r[2] >= 31000000 && r[2] < 32000000);
const outside = jRows.filter(r => !sysInfo.has(r[2]));
check("every J-space kill maps to a known system", outside.length === 0, `${jRows.length} J-space kills, ${outside.length} unmapped`);
const other = all.filter(r => r[2] >= 32000000).length;
check("no abyssal/instanced IDs counted", true, `${other} kills at 32xxxxxx+ ignored`);

// ---------- aggregate ----------
function aggregate(list, spanHours) {
  const pvp = list.filter(r => r[5] & F_PVP);
  const kinds = { structure: 0, pos: 0, deployable: 0, capital: 0, pod: 0, starter: 0 };
  const kindIsk = { structure: 0, capital: 0 };
  for (const r of pvp) { const k = kindOf.get(r[3]); if (k) { kinds[k]++; if (k in kindIsk) kindIsk[k] += r[4]; } }
  const isk = pvp.reduce((a, r) => a + r[4], 0);
  // Fights: per system, kills with gaps under an hour. Only sizes are kept, never which system.
  const bySys = new Map();
  for (const r of pvp) { if (!bySys.has(r[2])) bySys.set(r[2], []); bySys.get(r[2]).push(r); }
  const fights = [];
  for (const ks of bySys.values()) {
    ks.sort((a, b) => a[1] - b[1]);
    let cur = null;
    for (const r of ks) {
      if (!cur || r[1] - cur.last > FIGHT_GAP) { cur = { kills: 0, isk: 0, last: r[1] }; fights.push(cur); }
      cur.kills++; cur.isk += r[4]; cur.last = r[1];
    }
  }
  fights.sort((a, b) => b.isk - a.isk);
  const hours = spanHours || 1;
  return {
    kills: list.length, pvp: pvp.length, pvpShips: list.filter(r => r[5] & F_SHIP).length,
    npcDeaths: list.filter(r => r[5] & F_NPC).length,
    pods: kinds.pod, starterShips: kinds.starter, structures: kinds.structure, structureIsk: kindIsk.structure, starbases: kinds.pos,
    deployables: kinds.deployable, capitals: kinds.capital, capitalIsk: kindIsk.capital,
    // Median ship value leaves out pods, shuttles, rookie ships, structures and deployables, which
    // otherwise swamp it (one C4 group logged ~270 shuttle kills in three days).
    isk, iskMedian: median(pvp.filter(r => !kindOf.has(r[3]) || kindOf.get(r[3]) === "capital").map(r => r[4])),
    pvpCombat: pvp.length - kinds.pod - kinds.starter - kinds.deployable,
    pvpPerDay: Math.round(pvp.length / hours * 24 * 10) / 10,
    fights: fights.length, systemsWithPvp: bySys.size,
    biggestFight: fights[0] ? { kills: fights[0].kills, isk: fights[0].isk, iskShare: isk ? Math.round(fights[0].isk / isk * 1000) / 10 : 0 } : null
  };
}

// The site's log keeps 30 day files, today's included, so it holds 29 full days plus today: 696 to 720 hours.
// A window counts as complete once it covers that much.
const FULL_30D = 29 * 24;
const slotOf = t => ((Math.floor(t / DAY) + 3) % 7) * 24 + Math.floor(t / 3600) % 24; // Monday 0, EVE time
const windows = {};
for (const [name, hours] of [["24h", 24], ["7d", 168], ["30d", 720]]) {
  const from = Math.max(start, end - hours * 3600);
  const span = (end - from) / 3600;
  const inWin = jRows.filter(r => r[1] >= from && r[1] < end);
  const groups = {};
  for (const g of GROUPS) groups[g] = aggregate(inWin.filter(r => sysInfo.get(r[2])?.group === g), span);
  groups.Shattered = aggregate(inWin.filter(r => sysInfo.get(r[2])?.shattered), span);
  groups.All = aggregate(inWin, span);
  windows[name] = { from: new Date(from * 1000).toISOString(), to: new Date(end * 1000).toISOString(), hours: span, complete: span >= Math.min(hours, FULL_30D), groups };
}

// Hour-of-week PvP kills per group, with how many times each hour falls inside the covered period.
const slotHours = Array(168).fill(0);
for (let t = start; t < end; t += 3600) slotHours[slotOf(t)]++;
const heat = {};
for (const g of [...GROUPS, "All"]) heat[g] = Array(168).fill(0);
for (const r of jRows) {
  if (!(r[5] & F_PVP) || r[1] < start || r[1] >= end) continue;
  heat[sysInfo.get(r[2]).group][slotOf(r[1])]++;
  heat.All[slotOf(r[1])]++;
}

// ---------- zKillboard monthly totals per class ----------
const regionGroup = new Map();
for (const s of sysInfo.values()) regionGroup.set(s.regionId, s.group);
await mkdir(CACHE, { recursive: true });
const months = {};
let zkbFailed = 0, zkbFetched = 0;
for (const [regionId, group] of regionGroup) {
  const file = `${CACHE}/region-${regionId}.json`;
  const fresh = existsSync(file) && Date.now() - (await stat(file)).mtimeMs < 20 * 3600e3;
  if (!fresh && !OFFLINE) {
    try {
      const res = await fetch(`https://zkillboard.com/api/stats/regionID/${regionId}/kills/`, { headers: { "User-Agent": UA, "Accept-Encoding": "gzip" } });
      if (res.status === 429) { const ra = +res.headers.get("retry-after") || 10; log(`zKillboard asked to wait ${ra}s`); await sleep(ra * 1000); }
      if (!res.ok) throw new Error(`answered ${res.status}`);
      const j = await res.json();
      await writeFile(file, JSON.stringify({ fetchedAt: new Date().toISOString(), months: j.months || {} }));
      zkbFetched++;
      await sleep(1000); // one request a second, as the plan says
    } catch (e) { zkbFailed++; log(`zKillboard region ${regionId}: ${e.message}`); }
  }
  if (!existsSync(file)) continue;
  const j = await readJSON(file);
  for (const m of Object.values(j.months)) {
    const key = `${m.year}-${String(m.month).padStart(2, "0")}`;
    const e = ((months[group] ||= {})[key] ||= { ships: 0, isk: 0 });
    e.ships += m.shipsDestroyed || 0; e.isk += m.iskDestroyed || 0;
  }
}
for (const g of Object.keys(months)) months[g] = Object.fromEntries(Object.entries(months[g]).sort().slice(-MONTHS_KEPT));
check("zKillboard monthly totals for all 33 regions", zkbFailed === 0 && Object.keys(months).length === GROUPS.length, `${zkbFetched} fetched, ${zkbFailed} failed`);

// Sanity: this month in our log shouldn't fall short of zKillboard's month total for the class (missing kills).
// zKillboard's region month stats run lower than its own kill feed and daily archives (checked 2026-11-22: J-space
// November 30,117 in the stats against 36,155 kills in its feed, while all-space daily totals match the log), so
// they're only a floor here. verify.mjs item 8 checks the log against zKillboard's daily totals.
const thisMonth = new Date(end * 1000).toISOString().slice(0, 7);
const monthStart = Date.parse(thisMonth + "-01T00:00:00Z") / 1000;
const coversMonth = start <= monthStart;
const short = [];
for (const g of GROUPS) {
  const ours = jRows.filter(r => r[1] >= monthStart && sysInfo.get(r[2]).group === g).length;
  const theirs = months[g]?.[thisMonth]?.ships ?? null;
  if (coversMonth && theirs != null && ours < theirs * 0.95) short.push(`${g}: log ${ours} < zKillboard ${theirs}`);
}
check("log has at least zKillboard's month totals", short.length === 0, coversMonth ? short.join("; ") : "log starts after the 1st; not checked");

// ---------- ESI still excludes wormhole space? ----------
let esiJ = null;
if (!OFFLINE) {
  try {
    const { data } = await esi("/universe/system_kills/");
    esiJ = data.filter(x => x.system_id >= 31000000 && x.system_id < 32000000).length;
    check("ESI system_kills still leaves out wormhole space", esiJ === 0, `${data.length} rows, ${esiJ} in J-space`);
  } catch (e) { check("ESI system_kills reachable", false, e.message); }
}

// ---------- write ----------
const out = {
  builtAt: new Date().toISOString(), sdeBuild: sysFile.sdeBuild,
  note: "Class-level only. PvP = a player among the attackers (kill log flag 1). ISK is zKillboard's value at the time of the kill. " +
    "A fight is the PvP kills in one system with no gap over an hour; only its size is kept. Thera is its own row.",
  coverage: { from: new Date(start * 1000).toISOString(), to: new Date(end * 1000).toISOString(), hours: coveredHours, fullThirtyDays: coveredHours >= FULL_30D },
  systemsPerGroup, windows, heat: { slotHours, groups: heat },
  zkbMonths: { source: "zKillboard region stats, all kills (not PvP only), current month partial", groups: months },
  checks
};
await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/kills.json`, JSON.stringify(out, null, 1));
log(`wrote ${OUT}/kills.json`);
const failed = checks.filter(c => !c.ok);
log(`${checks.length - failed.length}/${checks.length} checks passed${failed.length ? `; review: ${failed.map(c => c.name).join(" | ")}` : ""}`);
