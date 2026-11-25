// Wormhole section: shared helpers and hand-written reference facts.
// Kept separate from index.html on purpose (decision 5, 2026-11-21).
"use strict";
const WH = (() => {
  const VERIFIED = "2026-11-21";
  const cache = {};
  const load = name => (cache[name] ||= fetch(`data/${name}.json`).then(r => { if (!r.ok) throw new Error(`${name}.json: ${r.status}`); return r.json(); }));

  // ---------- formatting ----------
  const nf = new Intl.NumberFormat("en-GB");
  const num = n => n == null ? "–" : nf.format(Math.round(n));
  const dec = (n, d = 1) => n == null ? "–" : n.toLocaleString("en-GB", { minimumFractionDigits: d, maximumFractionDigits: d });
  const isk = n => n == null ? "–" : n >= 1e12 ? `${dec(n / 1e12)}t` : n >= 1e9 ? `${dec(n / 1e9)}b` : n >= 1e6 ? `${dec(n / 1e6, n < 1e8 ? 1 : 0)}m` : n >= 1e3 ? `${dec(n / 1e3, 0)}k` : `${Math.round(n)}`;
  const mass = kg => kg == null ? "–" : kg >= 1e9 ? `${dec(kg / 1e9, kg % 1e8 ? 2 : 1)} billion kg` : `${num(kg / 1e6)} million kg`;
  const massShort = kg => kg == null ? "–" : `${num(kg / 1e6)}M`;
  const hours = min => min == null ? "–" : min % 60 ? `${dec(min / 60)}\u00a0h` : `${min / 60}\u00a0h`; // no-break space
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = (a, b) => b ? `${Math.round(a / b * 100)}%` : "–";

  // ---------- classes ----------
  // key = the group used in kills.json; classes = SDE wormholeClassID values in the group
  const GROUPS = [
    { key: "C1", classes: [1], name: "Class 1", short: "C1" },
    { key: "C2", classes: [2], name: "Class 2", short: "C2" },
    { key: "C3", classes: [3], name: "Class 3", short: "C3" },
    { key: "C4", classes: [4], name: "Class 4", short: "C4" },
    { key: "C5", classes: [5], name: "Class 5", short: "C5" },
    { key: "C6", classes: [6], name: "Class 6", short: "C6" },
    { key: "C13", classes: [13], name: "Class 13 (small-ship shattered)", short: "C13" },
    { key: "Thera", classes: [12], name: "Thera", short: "Thera" },
    { key: "Drifter", classes: [14, 15, 16, 17, 18], name: "Drifter systems", short: "Drifter" }
  ];
  const groupOfClass = c => GROUPS.find(g => g.classes.includes(c));

  // Short, sourced facts per group. Numbers that come from data are computed on the pages instead.
  const S = {
    euWhSpace: ["EVE University: Wormhole space", "https://wiki.eveuniversity.org/Wormhole_space"],
    euSites: ["EVE University: Wormhole sites", "https://wiki.eveuniversity.org/Wormhole_sites"],
    euSleepers: ["EVE University: Sleepers", "https://wiki.eveuniversity.org/Sleepers"],
    euDrifters: ["EVE University: Drifters", "https://wiki.eveuniversity.org/Drifters"],
    wincoDrifter: ["WinterCo: Drifter wormhole maps (April 2025)", "https://wiki.winterco.org/en/guide/drifter_wormhole_maps"],
    euGas: ["EVE University: Gas cloud harvesting", "https://wiki.eveuniversity.org/Gas_cloud_harvesting"],
    euDoctrines: ["EVE University Wormhole Community PvE doctrines (2024)", "https://wiki.eveuniversity.org/User:Lord_Finnbar/Wormhole_Community_PvE_Doctrines"],
    ccp2401: ["CCP patch notes 24.01", "https://www.eveonline.com/news/view/patch-notes-version-24-01"],
    ccp2202: ["CCP patch notes 22.02", "https://www.eveonline.com/news/view/patch-notes-version-22-02"],
    ccpCow: ["CCP: Cradle of War is live", "https://www.eveonline.com/news/view/cradle-of-war-major-update-is-live"],
    ccpRdf: ["CCP: Rampant Drone Fabricator sites are back", "https://www.eveonline.com/news/view/rampant-drone-fabricator-sites-are-back"],
    apex: ["eveapex patch catalogue (summary of CCP notes)", "https://eveapex.com/patches"],
    ccp2301: ["CCP patch notes 23.01", "https://www.eveonline.com/news/view/patch-notes-version-23-01"],
    ccp2302: ["CCP patch notes 23.02", "https://www.eveonline.com/news/view/patch-notes-version-23-02"],
    ccpFS: ["CCP: Fractured Skies expansion notes", "https://www.eveonline.com/news/view/fractured-skies-expansion-notes"],
    euShattered: ["EVE University: Shattered wormhole systems", "https://wiki.eveuniversity.org/Shattered_wormhole_systems"],
    euPI: ["EVE University: Planetary Industry", "https://wiki.eveuniversity.org/Planetary_Industry"],
    ashy1: ["Ashy: How 2 Krab part 1, mining and gas (2019)", "https://ashy.vargur.dev/how-2-krab-mining/"],
    ashy2: ["Ashy: How 2 Krab part 2, hacking and PI (2019)", "https://ashy.vargur.dev/how-2-krab-hacking-pi/"],
    ashy3: ["Ashy: How 2 Krab part 3, low-class sites (2019–2021)", "https://ashy.vargur.dev/how-2-krab-3-low-class-sites/"],
    ashy5: ["Ashy: How 2 Krab part 5, high-class sites (2019)", "https://ashy.vargur.dev/how-2-krab-part-5-high-class-sites/"],
    ashy7: ["Ashy: How 2 Krab part 7, alpha clones (2020)", "https://ashy.vargur.dev/how-2-krab-part-7-alpha-clones/"],
    allout: ["All-Out: Guide to wormhole gas (undated, c. 2015)", "https://all-out.github.io/guides/wormhole-gas/"],
    brave: ["Brave Collective: Brave Hole Divers (2021, CC BY 4.0)", "https://wiki.bravecollective.com/public/alliance/sigs/brave_hole_divers"],
    rykki: ["Rykki's Guide 1.5 (Grubu's maintained version), community sheet of Sleeper site data", "https://docs.google.com/spreadsheets/d/e/2PACX-1vSaCHnBRDw8Ki6nuamMzQv3InN978Zh7F6RcwlYdJHnlQkDrrdz5zrG3Of_8eoyxeqJimMHt9-7GjLn/pubhtml"],
    ashyPrimer: ["Ashy: Living in wormhole space primer (2021)", "https://ashy.vargur.dev/living-in-wormhole-space-primer/"],
    krabbi: ["Krabbi Wormhole Tours: wormhole prep", "https://krabbi-wormhole-tours.readthedocs.io/en/latest/wormhole_prep.html"],
    sde: ["CCP static data export", "https://developers.eveonline.com/docs/services/static-data/"]
  };
  const SHORT = k => k.startsWith("eu") ? "EVE Uni" : k.startsWith("ashy") ? "Ashy" : k.startsWith("ccp") ? "CCP" : k === "apex" ? "eveapex" : k === "krabbi" ? "Krabbi" : k === "sde" ? "CCP data" : "source";
  const src = (key, label) => { const [t, u] = S[key]; return `<a class="src" href="${u}" target="_blank" rel="noopener" title="${esc(t)}">${esc(label || SHORT(key))}</a>`; };

  const CLASS_NOTES = {
    C1: ["The easiest Sleeper sites. Holes out of a C1 take nothing bigger than a battlecruiser, with one exception: the Nestor battleship is light enough to fit.", ["euWhSpace"]],
    C2: ["Easy Sleeper sites. C2s normally have two statics, one into k-space and one into another wormhole, which makes a C2 with a useful k-space static popular to live in.", ["euWhSpace", "ashyPrimer"]],
    C3: ["Medium Sleeper sites that a single well-fitted battleship or strategic cruiser can run. Sleepers here scram, which stops micro-jump escapes.", ["euSleepers", "ashy3"]],
    C4: ["Harder sites, run with the same methods as C5s for less reward. Nearly all C4 statics lead to other wormholes rather than k-space.", ["ashy5"]],
    C5: ["Hard sites run by battleship fleets or capitals. Warping a capital into a site brings in extra Sleeper battleships (capital escalation).", ["euSleepers", "ashy5"]],
    C6: ["The hardest Sleeper sites, with the strongest system effects. Capital escalation works here as in C5.", ["euSleepers", "euWhSpace"]],
    C13: ["Shattered systems that only frigate-size ships can reach. All of them have the Wolf-Rayet effect at Class 6 strength, which favours small armour ships.", ["euWhSpace", "sde"]],
    Thera: ["A single large system with four NPC stations and many wormholes to k-space and to other wormholes. Signal Cartel's EVE-Scout publishes its current connections.", ["euWhSpace", "sde"]],
    Drifter: ["Five systems held by the Drifters' enemies since the 2025 Drifter crisis. Each has six statics into C1–C6 and, unusually, 50–70 more connections to k-space. Since March 2026 their k-space entrances have to be scanned down.", ["euDrifters", "ccp2302"]]
  };

  // ---------- sites and danger tiers ----------
  // Danger tier is the site's own assessment, built from the rules on the guide page (TIER_RULES).
  // Anomaly tier by class; guarded data/relic sites rate one tier higher (Ashy: "about as hard as the next class up").
  const ANOM_TIER = { 1: 1, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5 };
  const TIER_LABEL = { 1: "Low", 2: "Moderate", 3: "High", 4: "Severe", 5: "Extreme" };
  const anomalies = {
    1: ["Perimeter Ambush Point", "Perimeter Camp", "Phase Catalyst Node", "The Line"],
    2: ["Perimeter Checkpoint", "Perimeter Hangar", "The Ruins of Enclave Cohort 27", "Sleeper Data Sanctuary"],
    3: ["Fortification Frontier Stronghold", "Outpost Frontier Stronghold", "Solar Cell", "The Oruze Construct"],
    4: ["Frontier Barracks", "Frontier Command Post", "Integrated Terminus", "Sleeper Information Sanctum"],
    5: ["Core Garrison", "Core Stronghold", "Oruze Osobnyk", "Quarantine Area"],
    6: ["Core Citadel", "Core Bastion", "Strange Energy Readings", "The Mirror"]
  };
  const data = {
    1: ["Unsecured Perimeter Amplifier", "Unsecured Perimeter Information Center"],
    2: ["Unsecured Perimeter Comms Relay", "Unsecured Perimeter Transponder Farm"],
    3: ["Unsecured Frontier Database", "Unsecured Frontier Receiver"],
    4: ["Unsecured Frontier Digital Nexus", "Unsecured Frontier Trinary Hub"],
    5: ["Unsecured Frontier Enclave Relay", "Unsecured Frontier Server Bank"],
    6: ["Unsecured Core Backup Array", "Unsecured Core Emergence"]
  };
  const relic = {
    1: ["Forgotten Perimeter Coronation Platform", "Forgotten Perimeter Power Array"],
    2: ["Forgotten Perimeter Gateway", "Forgotten Perimeter Habitation Coils"],
    3: ["Forgotten Frontier Quarantine Outpost", "Forgotten Frontier Recursive Depot"],
    4: ["Forgotten Frontier Conversion Module", "Forgotten Frontier Evacuation Center"],
    5: ["Forgotten Core Data Field", "Forgotten Core Information Pen"],
    6: ["Forgotten Core Assembly Hall", "Forgotten Core Circuitry Disassembler"]
  };
  const SITE_NOTES = {
    "Outpost Frontier Stronghold": "Heavy webs and over 800 DPS incoming.",
    "Fortification Frontier Stronghold": "The worst energy neutralising of the C3 anomalies.",
    "Unsecured Frontier Receiver": "Since 24.01 the Sleepless Defender must be destroyed, not just attacked, to bring wave 4.",
    "Strange Energy Readings": "Capital escalation works here since December 2024.",
    "The Mirror": "Capital escalation works here since December 2024; the warp-in was moved in February 2025."
  };
  const SITE_NOTE_SRC = { "Outpost Frontier Stronghold": "ashy3", "Fortification Frontier Stronghold": "ashy3", "Unsecured Frontier Receiver": "ccp2401", "Strange Energy Readings": "ccp2202", "The Mirror": "ccp2202" };

  // Factors shown next to each site. Sources: euSleepers (scram C3+, RR higher classes, escalation C5/C6), ccpCow (C1–C3 AI).
  const factors = (cls, kind) => {
    const f = [];
    // CCP's 2026 rework names C1–C3 combat sites; whether data and relic guards changed too is unconfirmed.
    if (cls <= 3 && kind === "Combat anomaly") f.push("2026 AI: splits fire across pilots, ignores drones and pods, can be neuted");
    else if (cls <= 3) f.push("guards may or may not use the 2026 AI (unconfirmed)");
    else f.push("Older AI: switches to the highest threat, attacks drones");
    if (cls >= 3) f.push("scrams (no micro-jump escape)");
    f.push("neuts and webs");
    if (cls >= 5) f.push("capital escalation possible");
    if (kind !== "Combat anomaly") f.push("must be scanned down; hacking cans guarded by Sleepers");
    return f;
  };
  const SITES = [];
  for (let c = 1; c <= 6; c++) {
    for (const n of anomalies[c]) SITES.push({ name: n, cls: c, kind: "Combat anomaly", tier: ANOM_TIER[c] });
    for (const n of data[c]) SITES.push({ name: n, cls: c, kind: "Data site", tier: Math.min(5, ANOM_TIER[c] + 1) });
    for (const n of relic[c]) SITES.push({ name: n, cls: c, kind: "Relic site", tier: Math.min(5, ANOM_TIER[c] + 1) });
  }
  for (const s of SITES) { s.factors = factors(s.cls, s.kind); s.note = SITE_NOTES[s.name] || ""; s.noteSrc = SITE_NOTE_SRC[s.name] || ""; }

  const GAS = [
    { name: "Barren Perimeter Reservoir", area: "Perimeter", classes: "C1–C4", main: "C50", second: "C60", tier: 1 },
    { name: "Token Perimeter Reservoir", area: "Perimeter", classes: "C1–C4", main: "C60", second: "C70", tier: 1 },
    { name: "Minor Perimeter Reservoir", area: "Perimeter", classes: "C1–C4", main: "C70", second: "C72", tier: 1 },
    { name: "Ordinary Perimeter Reservoir", area: "Perimeter", classes: "C1–C4", main: "C72", second: "C84", tier: 1, note: "Its sentry towers were replaced in March 2026 with the same NPCs as the Sizeable Perimeter Reservoir." },
    { name: "Sizeable Perimeter Reservoir", area: "Perimeter", classes: "C1–C4", main: "C84", second: "C50", tier: 1 },
    { name: "Bountiful Frontier Reservoir", area: "Frontier", classes: "C3–C6", main: "C28", second: "C32", tier: 3 },
    { name: "Vast Frontier Reservoir", area: "Frontier", classes: "C3–C6", main: "C32", second: "C28", tier: 3 },
    { name: "Instrumental Core Reservoir", area: "Core", classes: "C5, C6, shattered", main: "C320", second: "C540", tier: 4 },
    { name: "Vital Core Reservoir", area: "Core", classes: "C5, C6, shattered", main: "C540", second: "C320", tier: 4 }
  ];

  // ---------- chart: single-series bars with hover tooltip and a table view ----------
  // values: [{ label, value, tip }]; opts: { height, yLabel, every (x label step) }
  function bars(el, values, opts = {}) {
    // drawn at the container's real width so text stays at its true size
    const W = Math.max(300, Math.round(el.clientWidth || 640)), H = opts.height || 220, L = 40, R = 6, T = 10, B = 24;
    const max = Math.max(1, ...values.map(v => v.value));
    const step = niceStep(max), top = Math.ceil(max / step) * step;
    const n = values.length, slot = (W - L - R) / n, bw = Math.max(2, slot - 2); // 2px gap between bars
    const y = v => T + (H - T - B) * (1 - v / top);
    let g = "";
    for (let t = 0; t <= top; t += step) g += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${t >= 1000 ? `${t / 1000}k` : t}</text>`;
    let b = "", x = "";
    values.forEach((v, i) => {
      const x0 = L + i * slot + 1, h = H - B - y(v.value);
      const r = Math.min(4, bw / 2, h);
      // bar anchored to the baseline, rounded 4px at the data end only
      const d = h <= 0 ? "" : `M${x0},${H - B}V${y(v.value) + r}Q${x0},${y(v.value)} ${x0 + r},${y(v.value)}H${x0 + bw - r}Q${x0 + bw},${y(v.value)} ${x0 + bw},${y(v.value) + r}V${H - B}Z`;
      b += `<rect class="hit" x="${L + i * slot}" y="${T}" width="${slot}" height="${H - T - B}" data-i="${i}"/><path class="bar" d="${d}"/>`;
      if (i % (opts.every || 1) === 0) x += `<text x="${x0 + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(v.label)}</text>`;
    });
    el.classList.add("chart");
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title || "")}"><g class="grid axis">${g}</g><g>${b}</g><g class="axis">${x}</g></svg><div class="tip" hidden></div>
      <details class="asTable"><summary>Show as a table</summary><div class="tablewrap"><table class="t"><thead><tr><th>${esc(opts.xName || "")}</th><th class="num">${esc(opts.yName || "Value")}</th></tr></thead><tbody>${values.map(v => `<tr><td>${esc(v.label)}</td><td class="num">${num(v.value)}</td></tr>`).join("")}</tbody></table></div></details>`;
    const tip = el.querySelector(".tip"), svg = el.querySelector("svg");
    el.querySelectorAll(".hit").forEach(h => {
      h.addEventListener("mousemove", () => {
        const v = values[+h.dataset.i], r = svg.getBoundingClientRect(), k = r.width / W;
        tip.innerHTML = v.tip || `<b>${esc(v.label)}</b>: ${num(v.value)}`;
        tip.style.left = `${(+h.getAttribute("x") + slot / 2) * k}px`;
        tip.style.top = `${y(v.value) * k}px`;
        tip.hidden = false;
      });
      h.addEventListener("mouseleave", () => { tip.hidden = true; });
    });
  }
  function niceStep(max) {
    const raw = max / 4, p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
  }

  // ---------- shared page furniture ----------
  function footer(extra = "") {
    const f = document.createElement("footer");
    f.innerHTML = `${extra}
      <p><b>Data:</b> classes, effects, planets and wormhole types from CCP's static data export, checked against ESI. Statics from <a href="https://bitbucket.org/daimian/tripwire/src/production/tools/" target="_blank" rel="noopener">Tripwire</a> (MIT licence, © Daimian Mercer and contributors), cross-checked with <a href="https://github.com/wanderer-industries/wanderer" target="_blank" rel="noopener">Wanderer</a> (MIT licence, © Wanderer Industries). Kills from <a href="https://zkillboard.com/" target="_blank" rel="noopener">zKillboard</a>. Sleeper site waves and blue loot from <a href="https://docs.google.com/spreadsheets/d/e/2PACX-1vSaCHnBRDw8Ki6nuamMzQv3InN978Zh7F6RcwlYdJHnlQkDrrdz5zrG3Of_8eoyxeqJimMHt9-7GjLn/pubhtml" target="_blank" rel="noopener">Rykki's Guide</a> (maintained by Grubu Niminenson, building on Rykki Atruin, Karr and Nolak), cross-checked with the <a href="https://wiki.eveuniversity.org/Wormhole_sites" target="_blank" rel="noopener">EVE University wiki</a> (CC BY-SA 4.0); C5 fleet advice from <a href="https://wiki.bravecollective.com/public/alliance/sigs/brave_hole_divers" target="_blank" rel="noopener">Brave Collective</a> (CC BY 4.0); gas site contents and defenders from Rykki's Guide; wandering holes and signature levels from <a href="https://whtype.info/" target="_blank" rel="noopener">whtype.info</a>, signature strength from <a href="https://github.com/goryn-clade/pathfinder" target="_blank" rel="noopener">Pathfinder</a> (MIT licence); which ores occur in wormholes cross-checked with <a href="https://ore.cerlestes.de/ore" target="_blank" rel="noopener">cerlestes.de</a>. Guide facts summarised in our own words from the sources linked beside each one; facts last checked ${VERIFIED}.</p>
      <p>© 2014 CCP hf. All rights reserved. “EVE”, “EVE Online”, “CCP”, and all related logos and images are trademarks or registered trademarks of CCP hf. This is a fan-made site and isn’t affiliated with or endorsed by CCP.</p>`;
    document.body.appendChild(f);
  }

  // ---------- shared site table ----------
  // sitesData = data/sites.json (EVE University wave lists + CCP NPC stats); may be null.
  // "wave 1: Awakened Escort · wave 2: 2 Awakened Escorts" plus special cases and the C5/C6 relay trigger
  function triggerText(d) {
    const byWave = {};
    for (const t of d.triggers) (byWave[t.wave] ||= []).push(`${t.count > 1 ? t.count + " " : ""}${t.ship}${t.count > 1 ? "s" : ""}`);
    const parts = Object.entries(byWave).map(([w, l]) => `wave ${w}: ${l.join(" or ")}`);
    const notes = (d.triggerNotes || []).map(n => n
      .replace(/^wave (\d+): 1st Death Trigger \((.+)\)$/, "wave $1: killing any one $2 brings the next wave")
      .replace(/^wave (\d+): Trigger on Attack \((.+)\)$/, "wave $1: attacking the $2 brings the next wave"));
    const relay = d.dta?.length ? [`the ${d.dta.join(" or ")} triggers the Transmission Relay (where the Drifter comes from)`] : [];
    return esc([...parts, ...notes, ...relay].join(" · "));
  }

  function siteTable(cls, sitesData) {
    const D = sitesData?.sites || {};
    const rows = SITES.filter(s => s.cls === cls).map(s => {
      const d = D[s.name];
      const loot = d ? isk(d.blueLootIsk[0]) + (d.extraSpawnIsk ? `<br><span class="muted">+${isk(d.extraSpawnIsk)} if the extra ship spawns</span>` : "")
        + (d.iskDisagrees ? `<br><span class="dated" title="EVE University lists ${d.eveUniIsk.map(isk).join(" or ")}">EVE Uni: ${d.eveUniIsk.map(isk).join("/")}</span>` : "") : "–";
      const pre = cls <= 3 && s.kind === "Combat anomaly" && d ? '<span class="dated" title="EVE University recorded these waves before CCP rebuilt C1–C3 combat sites in September 2026">pre-2026 waves</span>' : "";
      const unsure = d?.uncertain ? `<span class="dated" title="${esc(d.uncertain)}">check counts</span>` : "";
      const ew = d ? [d.peakWaveNeutGJs ? `neuts up to ${d.peakWaveNeutGJs} GJ/s` : "", d.websters ? `${d.websters} ships that web` : "", d.scramblers ? `${d.scramblers} that scram` : "", d.remoteRepairers ? `${d.remoteRepairers} that repair others` : ""].filter(Boolean).join(", ") : "";
      return `<tr><td>${d ? `<a href="${d.url}" target="_blank" rel="noopener">${esc(s.name)}</a>` : esc(s.name)}<br><span class="muted">${s.kind}</span></td>
        <td><span class="tier tier${s.tier}">${s.tier}</span> ${TIER_LABEL[s.tier]}</td>
        <td class="num">${loot}</td><td class="num">${d ? d.waves : "–"}</td><td class="num">${d ? num(d.ehp / 1000) + "k" + (d.ehpIfExtraSpawns > d.ehp ? `<br><span class="muted">${num(d.ehpIfExtraSpawns / 1000)}k with extra spawns</span>` : "") : "–"}</td><td class="num">${d ? num(d.peakWaveDps) + (d.peakWaveDpsIfExtraSpawns > d.peakWaveDps ? `<br><span class="muted">${num(d.peakWaveDpsIfExtraSpawns)} with extra spawns</span>` : "") : "–"}${pre}${unsure}</td>
        <td>${esc(s.factors.join("; "))}${ew ? `<br><span class="muted">Waves include: ${esc(ew)}.</span>` : ""}${d?.triggers?.length ? `<br><span class="cond"><b>Triggers:</b> ${triggerText(d)}</span>` : ""}${s.note ? `<br><span class="muted">${esc(s.note)}</span>${src(s.noteSrc)}` : ""}${d?.note ? `<br><span class="muted">${esc(d.note)}</span>${src("euSites")}` : ""}</td></tr>`;
    }).join("");
    return `<div class="tablewrap"><table class="t"><thead><tr><th>Site<small>links to EVE University's wave tables</small></th><th>Danger</th><th class="num">Blue loot<small>ISK</small></th><th class="num">Waves</th><th class="num">Total EHP<small>guaranteed spawns</small></th><th class="num">Strongest wave<small>DPS if all fire</small></th><th>What to expect</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  // signature level text for a hole type (data/hole-signatures.json); kind = "static" | "wandering" | undefined
  function sigText(sig, kind) {
    if (!sig) return "–";
    const word = { I: "I easier", II: "II medium", III: "III harder" };
    let lv = kind && sig[kind] ? [sig[kind]] : sig.levels;
    let t = lv.length ? lv.map(l => word[l] || l).join(" / ") : "–";
    if (!kind && sig.static && sig.wandering && sig.static !== sig.wandering) t = `static ${sig.static}, wandering ${sig.wandering}`;
    if (sig.pathfinderStrength != null) t += ` <span class="muted">(strength ${sig.pathfinderStrength})</span>`;
    if (sig.agrees === false) t += ' <span class="badge b-warn" title="The level from whtype.info and the strength from Pathfinder point to different levels">sources differ</span>';
    return t;
  }

  return { VERIFIED, load, siteTable, sigText, num, dec, isk, mass, massShort, hours, esc, pct, GROUPS, groupOfClass, CLASS_NOTES, S, src, SITES, GAS, TIER_LABEL, bars, footer };
})();
