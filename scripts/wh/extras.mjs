// Wormhole section: extra reference data built alongside build-wormholes.mjs (added 2026-11-21).
// Run by hand (not in the Action).
//   fitting-mass.json  mass that propulsion modules, armour plates and Higgs Anchor rigs add (CCP data)
//   wanderers.json     holes that can open in each class besides its statics (Tripwire, cross-checked with Wanderer)
//   sleepers.json      Sleeper and related NPC stats computed from CCP data
//   fullerites.json    m³ per unit of each fullerite (CCP data)

// whtype.info keeps its table as a JS file holding one array literal. It's downloaded (cached a week) and
// converted to JSON with text rules, never executed.
async function loadWhtype() {
  const { readFile, writeFile, stat, mkdir } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const file = "wormholes/.cache/whtype/wormholes.js";
  await mkdir("wormholes/.cache/whtype", { recursive: true });
  const fresh = existsSync(file) && Date.now() - (await stat(file)).mtimeMs < 7 * 86400e3;
  if (!fresh && process.env.OFFLINE !== "1") {
    try { const r = await fetch("https://whtype.info/js/wormholes.js", { headers: { "User-Agent": "QuietSpace/1.0 (wormhole reference build)" } }); if (r.ok) await writeFile(file, await r.text()); } catch { }
  }
  if (!existsSync(file)) return null;
  const src = await readFile(file, "utf8"), at = src.indexOf("WH_ENTRIES");
  if (at < 0) return null;
  const body = src.slice(src.indexOf("[", at), src.indexOf("];", at) + 1)
    .replace(/\/\/[^\n]*/g, "")                 // line comments
    .replace(/([{,]\s*)([a-z_]+)\s*:/g, '$1"$2":') // quote keys
    .replace(/'/g, '"')                          // single to double quotes
    .replace(/,\s*([}\]])/g, "$1");              // trailing commas
  try { return JSON.parse(body).filter(e => /^[A-Z]\d{3}$/.test(e.wormhole)); } catch { return null; }
}

// Cached download (a week) of a small community file; returns its text or null.
async function cachedFetch(url, file) {
  const { readFile, writeFile, stat, mkdir } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  await mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  const fresh = existsSync(file) && Date.now() - (await stat(file)).mtimeMs < 7 * 86400e3;
  if (!fresh && process.env.OFFLINE !== "1") {
    try { const r = await fetch(url, { headers: { "User-Agent": "QuietSpace/1.0 (wormhole reference build)" } }); if (r.ok) await writeFile(file, await r.text()); } catch { }
  }
  return existsSync(file) ? readFile(file, "utf8") : null;
}

// Signature level per hole type. whtype.info gives a level I/II/III (and, in its tooltips, separate levels for a
// type's static and wandering versions); Pathfinder's wormhole.csv gives a base signature strength. They line up
// as bands: I ≈ strength 6.67–10, II ≈ 4–5, III ≈ 1.25–2.5. Lower strength = fainter signature, harder to scan.
async function buildSignatures(whtype, check, writeJSON, stamp) {
  const tips = await cachedFetch("https://whtype.info/js/tooltips.js", "wormholes/.cache/whtype/tooltips.js");
  const split = {};
  if (tips) for (const m of tips.matchAll(/'([A-Z]\d{3})':\s*`([\s\S]*?)`/g)) {
    const st = m[2].match(/Static:<\/em>\s*(I{1,3})/), wa = m[2].match(/Wandering:<\/em>\s*(I{1,3})/);
    if (st || wa) split[m[1]] = { static: st?.[1] || null, wandering: wa?.[1] || null };
  }
  const csv = await cachedFetch("https://raw.githubusercontent.com/goryn-clade/pathfinder/master/export/csv/wormhole.csv", "wormholes/.cache/pathfinder/wormhole.csv");
  const pf = {};
  if (csv) for (const line of csv.trim().split(/\r?\n/).slice(1)) { const [, name, s] = line.split(";"); if (name && s !== "" && s != null) pf[name.trim()] = +s; }
  const band = s => s == null ? null : s >= 6 ? "I" : s >= 3 ? "II" : "III";
  const out = {}, conflicts = [];
  for (const w of whtype || []) {
    const levels = w.sig_level || [];
    const strength = pf[w.wormhole] ?? null;
    if (!levels.length && strength == null) continue;
    const agrees = strength == null || !levels.length ? null : levels.includes(band(strength));
    if (agrees === false) conflicts.push(`${w.wormhole} (whtype ${levels.join("/")}, Pathfinder ${strength})`);
    out[w.wormhole] = { levels, static: split[w.wormhole]?.static || null, wandering: split[w.wormhole]?.wandering || null, pathfinderStrength: strength, agrees };
  }
  const n = Object.keys(out).length, both = Object.values(out).filter(x => x.agrees !== null).length;
  check("signature levels: whtype levels match Pathfinder's strength bands", conflicts.length <= 3, `${n} hole types; ${both} in both sources, ${conflicts.length} differ: ${conflicts.join(", ") || "none"}`);
  await writeJSON("hole-signatures.json", { ...stamp, note: "Signature level I/II/III from whtype.info (static and wandering versions where it gives both); base signature strength from Pathfinder's wormhole.csv. Lower strength = harder to scan. Bands: I ≈ 6.67–10, II ≈ 4–5, III ≈ 1.25–2.5.", holes: out });
}

export async function buildExtras(ctx) {
  const { rd, types, groups, dogma, en, stamp, check, report, writeJSON, holeByCode, systemsRaw, classOf, twStatics, twHoles, wd } = ctx;
  const attrName = new Map((await rd("dogmaAttributes")).map(a => [a._key, a.name]));
  const effName = new Map((await rd("dogmaEffects")).map(e => [e._key, e.name]));
  const effects = id => (dogma.get(id)?.dogmaEffects || []).map(e => effName.get(e.effectID) || "");
  const attrs = id => Object.fromEntries((dogma.get(id)?.dogmaAttributes || []).map(a => [attrName.get(a.attributeID), a.value]));

  // ---- 1. fitting mass ----
  const prop = {}, plates = {}, higgs = [];
  for (const t of types.values()) {
    if (!t.published) continue;
    const g = en(groups.get(t.groupID)) || "", a = attrs(t._key), name = en(t);
    if (g === "Propulsion Module" && a.massAddition) {
      const size = (name.match(/(\d+MN)/) || [])[1];
      const kind = /Microwarpdrive/.test(name) ? "MWD" : /Afterburner/.test(name) ? "AB" : null;
      if (size && kind) (prop[`${size} ${kind}`] ||= new Set()).add(a.massAddition);
    } else if (g === "Armor Plate" && a.massAddition) {
      const size = (name.match(/(\d+mm)/) || [])[1];
      if (size) (plates[size] ||= new Set()).add(a.massAddition);
    } else if (/Higgs Anchor/.test(name) && a.massBonusPercentage) higgs.push({ name, massPercent: a.massBonusPercentage });
  }
  const out = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, [...v].sort((x, y) => x - y)]).sort((a, b) => parseInt(a[0]) - parseInt(b[0]) || a[0].localeCompare(b[0])));
  const fitMass = { ...stamp, note: "Mass added while a propulsion module is running (massAddition), by armour plates (always), and by Higgs Anchor rigs (% of hull mass). CCP data.", propulsion: out(prop), plates: out(plates), higgs };
  check("fitting mass: 100MN AB and 500MN MWD add 50M kg; Higgs doubles mass",
    fitMass.propulsion["100MN AB"]?.includes(50e6) && fitMass.propulsion["500MN MWD"]?.includes(50e6) && higgs.length > 0 && higgs.every(h => h.massPercent === 100),
    Object.entries(fitMass.propulsion).map(([k, v]) => `${k} ${v.map(x => x / 1e6).join("/")}M`).join(", "));
  await writeJSON("fitting-mass.json", fitMass);

  // ---- 2. wandering holes per class ----
  // Tripwire's per-type "from" field, cross-checked with Wanderer's per-class lists. Pochven links are left out
  // (decision 1); J377 leads to Turnur and is labelled so.
  const FROM = { "Class-1": 1, "Class-2": 2, "Class-3": 3, "Class-4": 4, "Class-5": 5, "Class-6": 6, "Class-13": 13, "Thera": 12 };
  const staticByClass = {};
  for (const sy of systemsRaw) { const c = classOf(sy); for (const code of twStatics[en(sy)] || []) (staticByClass[c] ||= new Set()).add(code); }
  const sysById = new Map(systemsRaw.map(q => [q._key, q]));
  const wdWand = {};
  for (const x of wd) { const sy = sysById.get(x.solarSystemID); if (sy) wdWand[classOf(sy)] = new Set(x.wanderers || []); }
  const entry = (code, c, sources) => {
    const h = holeByCode.get(code);
    return { code, target: h?.target ?? null, targetLabel: code === "J377" ? "Low-sec (Turnur)" : h?.targetLabel ?? null, maxJumpMass: h?.maxJumpMass ?? null, alsoStatic: !!staticByClass[c]?.has(code), sources };
  };
  const wanderers = {};
  for (const [code, t] of Object.entries(twHoles)) {
    const h = holeByCode.get(code);
    if (!h || h.target === 25 || h.target === -1 || code === "K162") continue; // Pochven links are out of scope
    for (const lbl of [].concat(t.from || [])) {
      const c = FROM[lbl]; if (!c) continue;
      (wanderers[c] ||= []).push(entry(code, c, ["tripwire", ...(wdWand[c]?.has(code) ? ["wanderer"] : [])]));
    }
  }
  // Third source: whtype.info's data file (js/wormholes.js, a plain array of entries). Read as data, never run.
  const whtype = await loadWhtype();
  const WT_CLASS = { "Class 1": 1, "Class 2": 2, "Class 3": 3, "Class 4": 4, "Class 5": 5, "Class 6": 6, "Class 12 - Thera": 12, "Class 13 - Shattered": 13 };
  const wtWand = {};
  for (const w of whtype || []) if ((w.respawn || []).includes("Wandering")) for (const sp of w.spawn_in || []) { const c = WT_CLASS[sp]; if (c) (wtWand[c] ||= new Set()).add(w.wormhole); }
  const diff = [];
  for (const [c, set] of Object.entries(wdWand)) {
    if (+c > 6) continue; // Wanderer's "wanderers" for Drifter systems are really their statics
    for (const code of set) if (!wanderers[c]?.some(w => w.code === code)) { diff.push({ class: +c, code }); (wanderers[c] ||= []).push(entry(code, +c, ["wanderer"])); }
  }
  // whtype: confirm, add what only it records, and mark where it disagrees (statics excluded: it lists those as statics)
  const wtDisagree = [];
  if (whtype) {
    for (const [c, list] of Object.entries(wanderers)) for (const w of list) {
      if (wtWand[c]?.has(w.code)) w.sources.push("whtype");
      else if (!w.alsoStatic) { w.disputed = "whtype.info doesn't list it here"; wtDisagree.push(`C${c} ${w.code}`); }
    }
    for (const [c, set] of Object.entries(wtWand)) for (const code of set) {
      const h = holeByCode.get(code);
      if (!h || h.target === 25 || h.target === -1) continue;
      if (!wanderers[c]?.some(w => w.code === code)) (wanderers[c] ||= []).push(entry(code, +c, ["whtype"]));
    }
  }
  report.disagreements.wanderersWhtype = wtDisagree;
  await buildSignatures(whtype, check, writeJSON, stamp);
  for (const c of Object.keys(wanderers)) wanderers[c].sort((a, b) => a.maxJumpMass - b.maxJumpMass || a.code.localeCompare(b.code));
  check("wandering holes: whtype.info read as a third source", !!whtype, whtype ? `${whtype.length} entries; disagrees on ${wtDisagree.length}: ${wtDisagree.join(", ") || "none"}` : "not available");
  check("wandering holes: Wanderer's lists sit within Tripwire's", diff.length <= 1, `${diff.length} only in Wanderer: ${diff.map(d => `C${d.class} ${d.code}`).join(", ") || "none"}`);
  report.disagreements.wanderers = diff;
  await writeJSON("wanderers.json", { ...stamp, note: "Holes that can open in each class besides its statics (Tripwire's per-type 'from' lists, cross-checked with Wanderer's per-class lists and whtype.info). alsoStatic = some systems of the class have it as a static. Pochven links left out.", classes: wanderers });

  // ---- 3. Sleeper roster ----
  const RE = /^(Emergent|Awakened|Sleepless) (Patroller|Watchman|Escort|Outguard|Defender|Upholder|Preserver|Safeguard|Sentinel|Keeper|Warden|Guardian)$|^(Vigilant|Wakeful|Restless) Sentry Tower$|^Upgraded Avenger$|^Drifter (Response|Recon) Battleship$/;
  const avg = (a, kind) => { const v = ["Em", "Explosive", "Kinetic", "Thermal"].map(d => a[`${kind}${d}DamageResonance`]).filter(x => x != null); return v.length ? v.reduce((p, q) => p + q, 0) / v.length : 1; };
  const dmg = o => (o.emDamage || 0) + (o.explosiveDamage || 0) + (o.kineticDamage || 0) + (o.thermalDamage || 0);
  const sleepers = [];
  for (const t of types.values()) {
    const name = en(t); if (!name || !RE.test(name)) continue;
    const a = attrs(t._key), names = Object.keys(a);
    const shield = a.shieldCapacity || 0, armor = a.armorHP || 0, hull = a.hp || 0, sRes = avg(a, "shield"), aRes = avg(a, "armor");
    const m = a.entityMissileTypeID ? attrs(a.entityMissileTypeID) : null;
    // What an NPC can do comes from its effects (attributes alone can be left over, e.g. sentry towers carry a
    // missile type but have no missile launcher effect).
    const fx = effects(t._key), can = re => fx.some(e => re.test(e));
    sleepers.push({
      id: t._key, name, newModel: can(/behavior/i), shield, armor, hull,
      shieldResist: shield ? Math.round((1 - sRes) * 100) : null, armorResist: Math.round((1 - aRes) * 100),
      ehp: Math.round((shield ? shield / sRes : 0) + armor / aRes + hull),
      turretDps: a.damageMultiplier && a.speed ? Math.round(a.damageMultiplier * dmg(a) / (a.speed / 1000)) : 0,
      missileDps: m && a.missileLaunchDuration && can(/missileLaunching/i) ? Math.round((a.missileDamageMultiplier || 1) * dmg(m) / (a.missileLaunchDuration / 1000)) : 0,
      neutGJs: !can(/EnergyNeutralizer/i) ? 0 : a.energyNeutralizerAmount ? Math.round(a.energyNeutralizerAmount / ((a.energyNeutralizerDuration || 10000) / 1000) * 10) / 10 : "yes",
      webPercent: !can(/modifyTargetSpeed|Webifier/i) ? 0 : Math.abs(a.speedFactor || 0) || "yes",
      scramPoints: !can(/warpScramble/i) ? 0 : a.warpScrambleStrength || "yes",
      remoteRepair: can(/RemoteArmorRepair/i),
      sig: a.signatureRadius ?? null, speed: a.maxVelocity ?? 0, range: a.entityAttackRange || a.maxRange || null
    });
  }
  sleepers.sort((x, y) => x.name.localeCompare(y.name) || x.id - y.id);
  const s = sleepers.find(x => x.name === "Sleepless Sentinel");
  check("Sleeper stats: Sleepless Sentinel 147,714 EHP, 202 turret + 263 missile DPS (matches EVE University)",
    s?.ehp === 147714 && s.turretDps === 202 && s.missileDps === 263, s ? `${s.ehp} EHP, ${s.turretDps} + ${s.missileDps} DPS; ${sleepers.length} NPC types` : "missing");
  await writeJSON("sleepers.json", { ...stamp, note: "Computed from CCP data. EHP = shield ÷ average shield resonance + armour ÷ average armour resonance + hull. DPS = damage multiplier × damage per shot ÷ cycle time. newModel = uses the newer NPC behaviour attributes (the 2026 versions).", sleepers });

  // ---- 4. fullerite volumes ----
  const fullerites = Object.fromEntries([...types.values()].filter(t => /^Fullerite-C\d+$/.test(en(t) || "")).map(t => [en(t).replace("Fullerite-", ""), t.volume]));
  check("nine fullerites with volumes", Object.keys(fullerites).length === 9, JSON.stringify(fullerites));
  const fulleriteIds = Object.fromEntries([...types.values()].filter(t => /^Fullerite-C\d+$/.test(en(t) || "")).map(t => [en(t).replace("Fullerite-", ""), t._key]));
  await writeJSON("fullerites.json", { ...stamp, note: "m³ per unit and type IDs, CCP data.", volumes: fullerites, typeIds: fulleriteIds });

  // ---- 5. ore volumes (IV-grade asteroids, the grade J-space belts spawn) ----
  const ores = Object.fromEntries([...types.values()].filter(t => / IV-Grade$/.test(en(t) || "") && t.published).map(t => [en(t), t.volume]));
  check("IV-grade ores with volumes", Object.keys(ores).length >= 15 && ores["Arkonor IV-Grade"] === 16, `${Object.keys(ores).length} ores`);
  const oreIds = Object.fromEntries([...types.values()].filter(t => / IV-Grade$/.test(en(t) || "") && t.published).map(t => [en(t), t._key]));
  // Compressed versions: CCP's compressibleTypes table. One compressed unit refines exactly like one raw unit (checked: same
  // typeMaterials per 100-unit portion) at 1/100 of the volume, so values compare unit for unit.
  const compressed = new Map((await rd("compressibleTypes")).map(c => [c._key, c.compressedTypeID]));
  const compressedIds = Object.fromEntries(Object.entries(oreIds).filter(([, id]) => compressed.has(id)).map(([n, id]) => [n, compressed.get(id)]));
  check("compressed IV-grade ores found", Object.keys(compressedIds).length >= 15, `${Object.keys(compressedIds).length} of ${Object.keys(oreIds).length}`);
  await writeJSON("ore-volumes.json", { ...stamp, note: "m³ per unit and type IDs (raw and compressed), CCP data. Compressed ore refines unit for unit like raw.", volumes: ores, typeIds: oreIds, compressedTypeIds: compressedIds });
}
