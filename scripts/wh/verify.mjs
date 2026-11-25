// Wormhole section, phase 4: the pre-launch checklist. Run by hand (not in the Action).
//
// Run from the repo root after build-wormholes.mjs and collect-wh-kills.mjs:
//   node scripts/wh/verify.mjs              (needs scripts/wh/preview.mjs running for the phone check)
//   OFFLINE=1 node scripts/wh/verify.mjs    skip zKillboard's daily totals
//
// Writes wormholes/data/checklist.json and prints the list. Each item is PASS, FAIL or HAND
// (HAND = needs a person: in-game checks or a decision). The section launches only when every
// item is PASS or a HAND item has been signed off in SIGNED_OFF below.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const D = "wormholes/data";
const OFFLINE = process.env.OFFLINE === "1";
const PREVIEW = `http://127.0.0.1:${process.env.PORT || 8765}`;
const UA = `QuietSpace/1.0 (+https://github.com/${process.env.GITHUB_REPOSITORY || "local"})`;
const read = async f => JSON.parse(await readFile(f, "utf8"));
const items = [];
const item = (n, name, status, detail) => items.push({ n, name, status, detail });

// Hand checks that have been done, with who/when/how. Add an entry to sign one off.
const SIGNED_OFF = {
  // "4": "Checked in game 2026-12-01: J005926 shows Red Giant effects",
  "4": "Decided 2026-11-21 (site owner): show the community version (ellatha.com, eveapex.com, Wanderer and the EVE Geological Survey's effect counts all agree) for J005926, J010569, J011824 and J010247, with a note that CCP's beacon data differs.",
};

// Source checks done against the live pages on 2026-11-21 (CCP patch notes 22.02, 23.01, 23.02, 24.01, 24.02,
// Cradle of War and Rampant Drone Fabricator news, Fractured Skies notes; EVE University Sleepers, Wormhole space,
// Shattered wormhole systems, Drifters, Planetary Industry). Recorded here so the checklist shows what was checked.
const SOURCE_CHECKS = [
  ["Cradle of War / C1–C3 AI rework date", "PASS", "2026-09-22 (patch notes section 2026-09-22.1); the 24.01 page's 2026-06-09 is its first release, not the rework. Pods/Zephyrs 09-24, no respawn 09-25. Stated for combat sites only."],
  ["Neuting C1–C3 Sleepers", "PASS", "CCP Cradle of War article, 2026-09-22."],
  ["Rampant Drone Fabricator", "PASS", "Permanent in C1–C6 from 2026-07-23; wave cap 30 → 100; solo 'unlikely to survive past 40 waves or so'."],
  ["Marauder / Black Ops masses", "PASS", "Kronos 118.4M kg (from 148M), 2026-09-22.1; matches the SDE."],
  ["Escalation rules", "PASS", "Escalate any time before wave 2 (22.02, 2025-01-16.1); Strange Energy Readings and The Mirror escalate (2024-12-03.1); Avenger loot 35m → 50m (23.01). 'A beacon marks escalated sites' NOT found: removed from the guide."],
  ["Arithmos needs a capital on grid", "PASS", "EVE University Drifters page, citing 22.02 (2025-01-16.1); not found verbatim in CCP's summary text."],
  ["Drifter connections scanned down", "PASS", "23.02, 2026-03-18.1."],
  ["Ordinary Perimeter Reservoir sentries", "PASS", "Corrected: replaced with Sizeable Perimeter Reservoir NPCs (23.02), not 'Sleeper ships'."],
  ["Synchronizer Rigs and C1–C3 content", "PASS", "Corrected to CCP's wording in the Fractured Skies expansion notes (2026-11-06)."],
  ["Wormhole asteroid grades (June 2026)", "PASS", "Not found in CCP's notes: shown on the guide as unconfirmed."],
  ["Supercapitals barred from wormholes", "PASS", "EVE University Wormhole space: 'Supercapitals don't fit through wormholes.'"],
  ["Shattered Ice Field", "PASS", "EVE University: all ice types incl. high-yield isotope ice; the only ice in J-space."],
  ["PI in shattered systems and customs tax", "PASS", "EVE University Planetary Industry: no PI in shattered systems; wormhole customs offices are player-owned and their owners set the tax."],
  ["Wormhole Show Info wording seen in game", "PASS", "Site owner's screenshots, 2026-11-21 (B735, K162, R051): 'Destination:' Drifter wormhole systems / Class 1-3 wormhole systems / Low-security systems; 'Maximum Ship Size:' Large / Extra large (Extra large on a 1,000M hole); 'Reliable Lifetime:' Less than 1 day / Less than 4 hours remaining; 'Mass Stability:' More than 50% remaining. Halo gyrates more near collapse (owner's observation). B735 (k-space end of a Drifter hole) showed Large with more than 50% mass, matching CCP data (375M jump, 750M total). Travel filaments (Needlejack, Pochven) cannot be activated inside wormhole systems (owner's in-game knowledge, 2026-11-22; Signal Cartel's Navigating New Eden guide says the same but is members-only; EVE Uni silent). Nothing is unprobeable: a scanner with the Virtue implant set in a bonused ship will always probe a ship out (owner's in-game knowledge, 2026-11-22; matches forum testers 2021-2022)."],
  ["Wormhole Show Info wording", "PASS", "CCP 23.01 (2025-09-09.1) simplified destination, size, lifetime and mass messages, added colour, a 1-hour message and C13/Drifter destinations. Lifetime/mass strings from EVE Uni's coloured list; old sentences (unknown / dangerous unknown / deadly unknown) shown as 'Before'. Exact new destination wording unconfirmed and labelled so."],
  ["Site figures vs LGI.tools", "PASS", "All 69 sites compared 2026-11-21: 61 identical; the rest differ only because LGI counts optional spawns in ISK/EHP/DPS (our with-extra-spawn EHP matches LGI exactly) and shows Rykki's stale Data Field total. Gas values within a few % (LGI basis unstated)."],
  ["Avengers per capital", "PASS", "EVE University says 3 (C5) / 4 (C6) but the page is flagged out of date: the guide gives no number."]
];

// ---------- 1–3, 5–7: reference data ----------
const sys = await read(`${D}/systems.json`), rep = await read(`${D}/verify-report.json`);
const effects = await read(`${D}/effects.json`), holes = await read(`${D}/holes.json`), ships = await read(`${D}/ships-fit.json`);
const chk = name => rep.checks.find(c => c.name.startsWith(name));
const pass = c => c ? (c.ok ? "PASS" : "FAIL") : "FAIL";

const c1 = ["J-space systems", "systems per class", "no system without a class"].map(chk);
item(1, "System totals and per-class counts", c1.every(c => c?.ok) ? "PASS" : "FAIL", `${c1.map(c => c ? `${c.name}: ${c.ok ? "ok" : c.detail}` : "missing").join("; ")} (SDE build ${sys.sdeBuild})`);
item(2, "Shattered systems", pass(chk("shattered systems")), chk("shattered systems")?.detail);

// 3: effect strengths follow the published ladder for every effect and class
const LADDERS = [[15, 22, 29, 36, 43, 50], [30, 44, 58, 72, 86, 100], [60, 88, 116, 144, 172, 200]];
const bad = [];
const kinds = [...new Set(effects.effects.map(e => e.kind))];
for (const kind of kinds) {
  const byClass = Object.fromEntries(effects.effects.filter(e => e.kind === kind).map(e => [e.beaconClass, e]));
  const attrs = byClass[1].mods.map(m => m.attr);
  for (const a of attrs) {
    const vals = [1, 2, 3, 4, 5, 6].map(c => Math.abs(byClass[c]?.mods.find(m => m.attr === a)?.pct ?? NaN));
    if (!LADDERS.some(l => l.every((v, i) => Math.abs(v - vals[i]) < 0.6))) bad.push(`${kind} ${byClass[1].mods.find(m => m.attr === a).label}: ${vals.join("/")}`);
  }
}
item(3, "Effect systems and strengths", chk("systems with an effect")?.ok && !bad.length ? "PASS" : "FAIL",
  `${chk("systems with an effect")?.detail} effect systems; ${kinds.length} effects × 6 classes on the ±15–50 / ±30–100 / +60–200% ladders${bad.length ? `; off-ladder: ${bad.join("; ")}` : ""}`);

const odd = rep.disagreements.beaconMismatch;
item(4, "Odd effect beacons resolved (in game or by decision)", SIGNED_OFF[4] ? "PASS" : "HAND",
  SIGNED_OFF[4] || `${odd.map(o => `${o.name} (C${o.class}, ${o.sun} star; CCP beacon: ${o.beacon})`).join("; ")}. Pages show the ellatha/eveapex/Wanderer version with a note (decided 2026-11-21). Open the system's info panel in game to see which effect applies, then sign off here.`);

const tiers = ships.tiers.map(t => t / 1e6);
const esiOk = chk("hole dogma: SDE matches live ESI");
item(5, "Hole types match CCP's live server", esiOk?.ok && !tiers.some(t => t === 1350 || t === 1800) ? "PASS" : "FAIL",
  `${esiOk?.detail ?? "ESI check not run (OFFLINE build)"}; jump tiers ${tiers.join(", ")}M; no 1,350M or 1,800M tier exists (older wiki figures).`);

const st = rep.disagreements.statics, shown = st.filter(d => !d.resolvedBy);
const unconf = sys.systems.flatMap(s => s.statics.filter(x => !x.confirmed).map(x => `${s.name} ${x.code}`));
const okStatic = ["Thera present", "five Drifter systems", "J015092 static is N110", "no Pochven or Turnur"].map(chk);
item(6, "Statics", okStatic.every(c => c?.ok) && unconf.length === shown.reduce((a, d) => a + Math.abs(d.tripwire.length - d.wanderer.length), 0) ? "PASS" : "FAIL",
  `${st.length} disagreements: ${st.length - shown.length} settled by a third source, ${shown.length} left and shown as unconfirmed (${unconf.join(", ") || "none"}). Thera, Drifter, J015092 = N110, no Pochven/Turnur: ${okStatic.every(c => c?.ok) ? "ok" : "problem"}.`);

const fitNames = ["Nestor fits a 62M hole", "Orca fits a 375M hole", "Kronos mass is 118.4M", "titans and supercarriers are marked barred"];
const fit = fitNames.map(chk);
item(7, "Ship size limits", fit.every(c => c?.ok) ? "PASS" : "FAIL", fit.map(c => c ? `${c.name}${c.ok ? "" : " FAILED"}` : "missing").join("; "));

// ---------- 8: kills ----------
const kills = existsSync(`${D}/kills.json`) ? await read(`${D}/kills.json`) : null;
if (!kills) item(8, "Kill statistics", "FAIL", "kills.json not built");
else {
  const kOk = kills.checks.every(c => c.ok);
  // completeness: our log against zKillboard's own daily totals, full days only
  let complete = "not checked (OFFLINE)", completeOk = true;
  if (!OFFLINE) {
    try {
      const totals = await (await fetch("https://r2z2.zkillboard.com/history/totals.json", { headers: { "User-Agent": UA } })).json();
      const dir = existsSync("data/kills") ? "data/kills" : "wormholes/.cache/data/kills";
      const from = kills.coverage.from.slice(0, 10), to = kills.coverage.to.slice(0, 10);
      const rows = [];
      for (const [day, n] of Object.entries(totals)) {
        const iso = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`;
        if (iso <= from || iso >= to || !existsSync(`${dir}/${iso}.ndjson`)) continue; // whole days inside coverage only
        const ours = (await readFile(`${dir}/${iso}.ndjson`, "utf8")).split("\n").filter(Boolean).length;
        rows.push([iso, ours, n, ours / n]);
      }
      completeOk = rows.length > 0 && rows.every(r => r[3] >= 0.95);
      complete = rows.map(r => `${r[0]} ${(r[3] * 100).toFixed(1)}%`).join(", ") || "no whole days yet";
    } catch (e) { complete = `zKillboard totals unavailable: ${e.message}`; completeOk = false; }
  }
  const full = kills.coverage.fullThirtyDays;
  item(8, "Kill statistics", kOk && completeOk && full ? "PASS" : kOk && completeOk ? "WAIT" : "FAIL",
    `${kills.checks.length} build checks ${kOk ? "pass" : "FAIL"}; log vs zKillboard daily totals (need ≥95%): ${complete}; coverage ${kills.coverage.hours} h${full ? "" : " — waiting for 30 days (about 2026-12-18)"}.`);
}

// ---------- 9–12: pages ----------
const page = async p => readFile(`wormholes/${p}`, "utf8");
const pages = ["index.html", "class.html", "search.html", "holes.html", "guide.html"];
const html = Object.fromEntries(await Promise.all(pages.map(async p => [p, await page(p)])));
const whjs = await page("wh.js");
item(9, "Patch-sourced claims checked against CCP's pages", SOURCE_CHECKS.every(s => s[1] === "PASS") ? "PASS" : "FAIL", `${SOURCE_CHECKS.length} claims checked 2026-11-21; see sourceChecks in checklist.json.`);

const guide = html["guide.html"];
// ISK-per-hour figures are allowed only with a date label (class="dated") within 400 characters after them,
// so a reader sees how old the figure is. "an hour" wording is caught too.
const iskHourRe = /\d[\d.,]*\s*(m|b|bil|mil)\w*\s*(isk)?\s*(\/|per|an|a)\s*(h\b|hour)/gi;
const iskHour = [...(guide + whjs).matchAll(iskHourRe)].some(m => !/class="dated"/.test((guide + whjs).slice(m.index, m.index + 400)));
const avengerNum = /\b[34]\s+(Upgraded\s+)?Avengers?\b/i.test(guide);
const shipRows = (guide.match(/<div class="shipcard">[\s\S]*?<!--\/shipcard-->/g) || []).filter(r => /ashy|EVE Uni WC|Krabbi|Brave/i.test(r));
const undated = shipRows.filter(r => !/class="dated"/.test(r));
item(10, "Stale figures labelled or removed", !iskHour && !avengerNum && !undated.length ? "PASS" : "FAIL",
  `ISK/hour figures without a date: ${iskHour ? "FOUND" : "none"}; Avenger count: ${avengerNum ? "FOUND" : "not stated"}; ship cards without a year: ${undated.length} of ${shipRows.length}.`);

const dataText = (await Promise.all(["systems", "holes", "effects", "ships-fit", "kills"].map(n => readFile(`${D}/${n}.json`, "utf8")))).join("");
const nameKeys = /"(character|corporation|alliance)(_?id|_?name|s)?"\s*:|created_by_name/i.test(dataText);
const perSys = /"(top|ranking|dangerous)\w*"\s*:\s*\[\s*\[?\s*3100/i.test(dataText);
item(11, "Privacy: no names, no per-system danger ranking", !nameKeys && !perSys ? "PASS" : "FAIL", `name fields in data: ${nameKeys ? "FOUND" : "none"}; per-system ranking: ${perSys ? "FOUND" : "none"}.`);

const ccp = /© 2014 CCP hf\. All rights reserved/.test(whjs);
const footers = pages.filter(p => /WH\.footer\(/.test(html[p]));
const mit = /Tripwire<\/a> \(MIT licence/.test(whjs) && /Wanderer<\/a> \(MIT licence/.test(whjs);
item(12, "Attribution and CCP notice", ccp && mit && footers.length === pages.length ? "PASS" : "FAIL",
  `CCP notice (DLA §7.1 wording): ${ccp ? "present" : "MISSING"}; Tripwire/Wanderer MIT credits: ${mit ? "present" : "MISSING"}; footer on ${footers.length}/${pages.length} pages. EVE-Scout and anoik.is are linked only, not copied.`);

// ---------- 13: phone width ----------
let phone = "preview server not running: start node scripts/wh/preview.mjs", phoneOk = false;
const chrome = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
let up = false;
try { up = (await fetch(`${PREVIEW}/wormholes/`)).ok; } catch { }
if (up && chrome) {
  // Headless Chrome won't make a window narrower than ~500px, so each page loads in a 390px frame instead.
  await mkdir("wormholes/.cache", { recursive: true });
  const targets = ["index.html", "class.html?c=C5", "search.html?s=J005926", "holes.html", "guide.html"];
  await writeFile("wormholes/.cache/phone-test.html", `<!doctype html><meta charset="utf-8"><body><pre id="out">running</pre>
${targets.map((t, i) => `<iframe id="f${i}" src="../${t}" style="width:390px;height:800px;border:0"></iframe>`).join("")}
<script>
setTimeout(() => {
  const r = ${JSON.stringify(targets)}.map((t, i) => { const d = document.getElementById("f" + i).contentDocument.documentElement;
    const wide = [...d.querySelectorAll("body *")].filter(e => { const b = e.getBoundingClientRect(); return b.right > 391 && !e.closest(".tablewrap") && getComputedStyle(e).position !== "absolute"; }).slice(0, 3).map(e => e.tagName.toLowerCase() + (e.className ? "." + String(e.className).split(" ")[0] : ""));
    return { page: t, scrollWidth: d.scrollWidth, wide }; });
  document.getElementById("out").textContent = "RESULT" + JSON.stringify(r) + "END";
}, 5000);
</script>`);
  try {
    const out = execFileSync(chrome, ["--headless", "--disable-gpu", "--no-first-run", `--user-data-dir=${process.cwd()}/wormholes/.cache/shots/prof`, "--virtual-time-budget=9000", "--dump-dom", `${PREVIEW}/wormholes/.cache/phone-test.html`], { timeout: 90000, stdio: ["ignore", "pipe", "ignore"] }).toString();
    const m = out.match(/RESULT(.*?)END/s);
    const res = m ? JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&")) : null;
    if (!res) phone = "test page did not report";
    else { phoneOk = res.every(r => r.scrollWidth <= 390); phone = res.map(r => `${r.page}: ${r.scrollWidth}px${r.wide.length ? ` (too wide: ${r.wide.join(", ")})` : ""}`).join("; "); }
  } catch (e) { phone = `browser check failed: ${e.message.split("\n")[0]}`; }
} else if (!chrome) phone = "no Chrome or Edge found";
item(13, "Pages fit a 390px phone screen", phoneOk ? "PASS" : "FAIL", phone);

// ---------- 14: site and Sleeper figures (added 2026-11-21) ----------
const sitesFile = existsSync(`${D}/sites.json`) ? await read(`${D}/sites.json`) : null;
const extraChecks = ["fitting mass", "wandering holes", "Sleeper stats", "nine fullerites"].map(chk);
item(14, "Site, Sleeper, wandering-hole and fitting-mass data", sitesFile && sitesFile.checks.every(c => c.ok) && extraChecks.every(c => c?.ok) ? "PASS" : "FAIL",
  `${extraChecks.map(c => c ? `${c.name.split(":")[0]}: ${c.ok ? "ok" : "FAIL"}` : "missing").join("; ")}; sites.json: ${sitesFile ? `${sitesFile.checks.filter(c => c.ok).length}/${sitesFile.checks.length} checks` : "not built (run build-sites.mjs)"}. Waves and loot from Rykki's Guide, checked against EVE University and summed from per-ship loot where known; C1–C3 combat waves predate the 2026 rebuild and are labelled so.`);

// ---------- 15: Jita prices (added 2026-11-21) ----------
const pr = existsSync(`${D}/prices.json`) ? await read(`${D}/prices.json`) : null;
const prAge = pr ? (Date.now() - Date.parse(pr.fetchedAt)) / 3600e3 : null;
const noBuy = pr ? Object.values(pr.items).filter(p => p.buy == null).map(p => p.name) : [];
item(15, "Jita gas and ore prices are fresh", pr && prAge < 48 && !noBuy.length && !pr.failed ? "PASS" : "FAIL",
  pr ? `${Object.keys(pr.items).length} items, fetched ${Math.round(prAge)} h ago${noBuy.length ? `; no buy orders for ${noBuy.join(", ")}` : ""}. Refreshed hourly by the Action.` : "prices.json not built (run collect-wh-prices.mjs)");

// ---------- 16: scripts parse and every page loads without a script error (added 2026-11-21) ----------
{
  const problems = [];
  try { execFileSync(process.execPath, ["--check", "wormholes/wh.js"], { stdio: "pipe" }); }
  catch (e) { problems.push(`wh.js: ${String(e.stderr || e.message).split(/\r?\n/).find(l => /Error/.test(l)) || "syntax error"}`); }
  // Load each page in the browser and look for uncaught script errors in its console log.
  if (up && chrome) {
    const { spawnSync } = await import("node:child_process");
    for (const p of ["index.html", "class.html?c=C5", "search.html?s=J005926", "holes.html", "guide.html"]) {
      const r = spawnSync(chrome, ["--headless", "--disable-gpu", "--no-first-run", `--user-data-dir=${process.cwd()}/wormholes/.cache/shots/prof`, "--enable-logging=stderr", "--v=0", "--virtual-time-budget=8000", "--dump-dom", `${PREVIEW}/wormholes/${p}`], { timeout: 90000, encoding: "utf8" });
      const m = (r.stderr || "").match(/Uncaught[^"]*/);
      if (m) problems.push(`${p}: ${m[0]}`);
    }
  }
  item(16, "Scripts parse and pages load without errors", !problems.length && up && chrome ? "PASS" : "FAIL", problems.join("; ") || (up && chrome ? "wh.js parses; 5 pages load with no script errors" : "preview server or browser not available"));
}

// ---------- write ----------
const out = { checkedAt: new Date().toISOString(), sdeBuild: sys.sdeBuild, items, sourceChecks: SOURCE_CHECKS.map(([claim, status, note]) => ({ claim, status, note })) };
await writeFile(`${D}/checklist.json`, JSON.stringify(out, null, 1));
const mark = { PASS: "PASS", FAIL: "FAIL", HAND: "HAND", WAIT: "WAIT" };
for (const i of items) console.log(`${String(i.n).padStart(2)}  ${mark[i.status].padEnd(4)}  ${i.name}\n      ${i.detail}`);
const left = items.filter(i => i.status !== "PASS");
console.log(`\n${items.length - left.length}/${items.length} pass.${left.length ? ` Before launch: ${left.map(i => `${i.n} (${i.status})`).join(", ")}.` : " Ready to launch."}`);
