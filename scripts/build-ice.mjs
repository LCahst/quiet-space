// One-time job: looks for ice belts in CCP's Static Data Export (celestial type "Ice Belt", group 4935)
// and checks the result against the EVE University wiki list built into index.html. If at least 90% of
// the wiki's ice systems are also in CCP's data, the official list is saved and used from then on;
// the SDE is not downloaded again. Otherwise the wiki list stays and a report explains why.
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

const DATA = process.env.DATA_DIR || "data";
const CACHE = `${DATA}/cache/ice.json`;
const SDE_URL = process.env.SDE_URL || "https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip";
const ICE_TYPE = 90335, ICE_GROUP = 4935;
const UA = `QuietSpace/1.0 (+https://github.com/${process.env.GITHUB_REPOSITORY || "local"})`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const readJSON = async (file, fallback) => { try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; } };

const done = await readJSON(CACHE, null);
if (done?.ok) {
  log(`Official ice list already verified on ${done.at} (${done.systems.length} systems); not downloading again.`);
} else {
  const report = [`Ice check, ${new Date().toISOString()}`, `Source: ${SDE_URL}`];
  const result = { ok: false, at: new Date().toISOString(), systems: [] };
  const zip = `${tmpdir()}/quiet-space-sde-ice.zip`;
  try {
    // The wiki list (names) from the site, mapped to system IDs with the catalog.
    const html = await readFile("index.html", "utf8");
    const block = html.match(/const ICE_SYSTEMS = \{([\s\S]*?)\n  \};/);
    if (!block) throw new Error("couldn't find the wiki ice list in index.html");
    const wikiNames = [...block[1].matchAll(/"[^"]+":\s*"([^"]+)"/g)].flatMap(m => m[1].split(" "));
    const catalog = await readJSON(`${DATA}/public/catalog.json`, null);
    if (!catalog) throw new Error("no catalog yet; will try after the map data is built");
    const idByName = new Map(Object.entries(catalog.systems).map(([id, s]) => [s.n.toLowerCase(), +id]));
    const wikiIds = wikiNames.map(n => idByName.get(n.toLowerCase())).filter(Boolean);
    report.push(`Wiki list: ${wikiNames.length} names, ${wikiIds.length} matched to systems`);

    const res = await fetch(SDE_URL, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`SDE download answered ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(zip));
    const entries = execFileSync("unzip", ["-Z1", zip], { maxBuffer: 64 * 1024 * 1024 }).toString().split("\n").filter(Boolean);
    const entry = entries.find(n => /(^|\/)mapAsteroidBelts\.jsonl$/.test(n));
    if (!entry) throw new Error("mapAsteroidBelts.jsonl not found in the SDE archive");
    const lines = execFileSync("unzip", ["-p", zip, entry], { maxBuffer: 1024 * 1024 * 1024 }).toString().split("\n").filter(Boolean);
    report.push(`\n${entry}: ${lines.length} belts`, `First record: ${lines[0]}`);

    const typeCounts = {}, ice = new Set();
    let firstIce = null;
    for (const line of lines) {
      const rec = JSON.parse(line);
      const type = rec.typeID ?? rec.type_id, group = rec.groupID ?? rec.group_id;
      const sys = rec.solarSystemID ?? rec.solar_system_id;
      typeCounts[type] = (typeCounts[type] || 0) + 1;
      if ((type === ICE_TYPE || group === ICE_GROUP) && typeof sys === "number") { ice.add(sys); if (!firstIce) firstIce = line; }
    }
    report.push(`Belt types: ${JSON.stringify(typeCounts)}`, `First ice belt record: ${firstIce || "none found"}`);

    const kspaceIce = [...ice].filter(id => catalog.systems[id]);
    const found = wikiIds.filter(id => ice.has(id));
    const share = wikiIds.length ? found.length / wikiIds.length : 0;
    const missing = wikiIds.filter(id => !ice.has(id)).map(id => catalog.systems[id].n);
    report.push(`\nSystems with ice belts in CCP's data: ${ice.size} (${kspaceIce.length} in known space)`,
      `Wiki ice systems also in CCP's data: ${found.length} of ${wikiIds.length} (${Math.round(share * 100)}%)`,
      `Wiki systems not in CCP's data: ${missing.slice(0, 40).join(", ") || "none"}${missing.length > 40 ? ` and ${missing.length - 40} more` : ""}`);
    result.ok = kspaceIce.length > 0 && share >= 0.9;
    if (result.ok) result.systems = kspaceIce.sort((a, b) => a - b);
    report.push(`\nResult: ${result.ok ? "Verified. Using CCP's ice list from now on." : "Not verified. Keeping the wiki list."}`);
  } catch (e) {
    report.push(`\nResult: couldn't check (${e.message}). Keeping the wiki list and trying again next run.`);
  } finally {
    try { await unlink(zip); } catch {}
  }
  await mkdir(`${DATA}/cache`, { recursive: true });
  await mkdir(`${DATA}/samples`, { recursive: true });
  await writeFile(`${DATA}/samples/ice-check.txt`, report.join("\n"));
  if (result.ok) await writeFile(CACHE, JSON.stringify(result));
  log(report[report.length - 1].trim());
}

// Publish the verified list (every run, so it survives the site being reassembled).
const final = await readJSON(CACHE, null);
if (final?.ok) {
  await mkdir(`${DATA}/public`, { recursive: true });
  await writeFile(`${DATA}/public/ice.json`, JSON.stringify({ source: "CCP static data", verified: final.at, systems: final.systems }));
}
