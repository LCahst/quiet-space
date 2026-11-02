// Hourly job: saves CCP's faction warfare feed (the one behind the Frontlines page on eveonline.com)
// as data/public/warzone.json, for the faction warfare page in development. Web pages can't read the
// feed directly, so the Action fetches it. The feed is stored as received, inside a small wrapper, so its
// format can be studied before the page relies on it. Each save also keeps the previous save's contested
// amounts, so the page can show how much each system moved since the last update. If the feed fails, the
// last good file is kept.
import { readFile, writeFile, mkdir } from "node:fs/promises";

const DATA = process.env.DATA_DIR || "data";
const OUT = `${DATA}/public/warzone.json`;
const URL = process.env.WARZONE_URL || "https://www.eveonline.com/api/warzone";
const UA = `QuietSpace/1.0 (+https://github.com/${process.env.GITHUB_REPOSITORY || "local"})`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

try {
  const res = await fetch(URL, { headers: { "User-Agent": UA, "Accept": "application/json" }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`feed answered ${res.status}`);
  const text = await res.text();
  const feed = JSON.parse(text); // throws if it isn't JSON
  // The previous save's contested amounts become the comparison point for "change since the last update".
  let previous = null;
  try {
    const old = JSON.parse(await readFile(OUT, "utf8"));
    if (Array.isArray(old.feed)) {
      const amounts = {}, occupiers = {};
      for (const s of old.feed) if (typeof s.solarsystemID === "number") { amounts[s.solarsystemID] = +s.contestedAmount || 0; occupiers[s.solarsystemID] = s.occupierFaction; }
      previous = { updated: old.updated, amounts, occupiers };
    }
  } catch {}
  await mkdir(`${DATA}/public`, { recursive: true });
  await writeFile(OUT, JSON.stringify({ updated: new Date().toISOString(), source: URL, previous, feed }));
  const size = Array.isArray(feed) ? `${feed.length} entries` : `keys: ${Object.keys(feed).slice(0, 12).join(", ")}`;
  log(`Warzone feed saved (${Math.round(text.length / 1024)} KB, ${size})`);
} catch (e) {
  let kept = "no previous file";
  try { kept = `keeping file from ${JSON.parse(await readFile(OUT, "utf8")).updated}`; } catch {}
  log(`Warzone feed unavailable (${e.message}); ${kept}.`);
}
