// Hourly job: reads CCP's pirate insurgency feed (the one behind the Frontlines page on eveonline.com)
// and writes data/public/insurgency.json for the site. This feed is not an official API, so if it fails
// or changes shape, the last good file is kept and the site hides icons once that file is over 12 hours old.
import { readFile, writeFile, mkdir } from "node:fs/promises";

const DATA = process.env.DATA_DIR || "data";
const OUT = `${DATA}/public/insurgency.json`;
const URL = process.env.INSURGENCY_URL || "https://www.eveonline.com/api/warzone/insurgency";
const UA = `QuietSpace/1.0 (+https://github.com/${process.env.GITHUB_REPOSITORY || "local"})`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const num = v => (typeof v === "number" && isFinite(v) ? v : null);

try {
  const res = await fetch(URL, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (!res.ok) throw new Error(`feed answered ${res.status}`);
  const feed = await res.json();
  if (!Array.isArray(feed)) throw new Error("feed is not a list of campaigns");

  const campaigns = [], systems = {};
  for (const c of feed) {
    if (!c || typeof c !== "object" || !Array.isArray(c.insurgencies)) continue;
    const id = c.campaignId ?? c.id;
    campaigns.push({
      id,
      faction: num(c.pirateFactionId),
      state: typeof c.state === "string" ? c.state : null,
      start: c.startDateTime || null,
      end: c.endDateTime || null,
      origin: c.originSolarSystem ? { id: num(c.originSolarSystem.id), name: c.originSolarSystem.name || null } : null,
      corruptionThreshold: num(c.corruptionThresHold ?? c.corruptionThreshold),
      suppressionThreshold: num(c.suppressionThresHold ?? c.suppressionThreshold),
      systems: c.insurgencies.length
    });
    for (const s of c.insurgencies) {
      const sid = s?.solarSystem?.id;
      if (typeof sid !== "number") continue;
      systems[sid] = {
        c: id,
        cs: num(s.corruptionState), cp: num(s.corruptionPercentage), cd: s.corruptionDate || null,
        ss: num(s.suppressionState), sp: num(s.suppressionPercentage), sd: s.suppressionDate || null
      };
    }
  }
  await mkdir(`${DATA}/public`, { recursive: true });
  await writeFile(OUT, JSON.stringify({ updated: new Date().toISOString(), campaigns, systems }));
  log(`Insurgencies: ${campaigns.length} campaign(s), ${Object.keys(systems).length} affected systems`);
} catch (e) {
  let kept = "no previous file";
  try { kept = `keeping file from ${JSON.parse(await readFile(OUT, "utf8")).updated}`; } catch {}
  log(`Insurgency feed unavailable (${e.message}); ${kept}.`);
}
