// Events section: Jita 4-4 prices for everything a current event page lists (turn-in items, tokens, trader shop items).
// Runs hourly in the Action (EV_OUT and EV_CACHE point it at the data branch there).
//
// Run from the repo root:  node scripts/events/collect-event-prices.mjs
//   EV_OUT=<folder>    where prices.json goes (default events/data)
//   EV_CACHE=<folder>  cache for type IDs and market history (default events/.cache)
//
// Item names come from the event data files (events/data/<event>.json); their type IDs are looked up once with
// ESI POST /universe/ids/ and cached. Prices: every order in The Forge for the type, kept only at Jita IV - Moon 4 -
// Caldari Navy Assembly Plant. Many event items trade rarely, so besides the best buy and sell we keep the order volume
// and 30-day trade count, and flag thin markets so the page doesn't present a lone 50B ISK sell order as a price.

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { esi, pool, stats } from "../lib/esi.mjs";

const REGION = 10000002, STATION = 60003760;
const OUT = process.env.EV_OUT || "events/data";
const CACHE = process.env.EV_CACHE || "events/.cache";
const EVENTS = ["fractured-skies"];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
await mkdir(OUT, { recursive: true });
await mkdir(`${CACHE}/market-history`, { recursive: true });

// ---------- item names from the event files ----------
const names = new Set();
for (const ev of EVENTS) {
  const d = JSON.parse(await readFile(`events/data/${ev}.json`, "utf8"));
  for (const e of Object.values(d.empires)) {
    names.add(e.token); names.add(e.ore);
    for (const it of Object.values(e.items)) names.add(it);
    for (const s of e.shop) names.add(s[1]);
  }
  for (const s of d.commonShop || []) names.add(s[1]);
}

// ---------- names -> type IDs (cached; ESI wants at most 500 names a call) ----------
const idFile = `${CACHE}/type-ids.json`;
const ids = existsSync(idFile) ? JSON.parse(await readFile(idFile, "utf8")) : {};
// names not found last time are asked again: ESI's name lookup can miss a new item for a while
const missing = [...names].filter(n => !ids[n]);
for (let i = 0; i < missing.length; i += 500) {
  const chunk = missing.slice(i, i + 500);
  const { data } = await esi("/universe/ids/", { method: "POST", body: JSON.stringify(chunk), headers: { "Content-Type": "application/json" } });
  for (const t of data.inventory_types || []) ids[t.name] = t.id;
  for (const n of chunk) if (!(n in ids)) ids[n] = null;
}
// CCP's own names sometimes carry a stray trailing space (live, Nov 2026: "Caldari Conquest Booster Crate "),
// which the exact-name lookup won't match; try that spelling for anything still missing
const retry = [...names].filter(n => !ids[n]);
if (retry.length) {
  const { data } = await esi("/universe/ids/", { method: "POST", body: JSON.stringify(retry.map(n => n + " ")), headers: { "Content-Type": "application/json" } });
  for (const t of data.inventory_types || []) ids[t.name.trim()] = t.id;
}
await writeFile(idFile, JSON.stringify(ids, null, 1));
const unknown = [...names].filter(n => !ids[n]);
if (unknown.length) log(`no type ID for: ${unknown.join(" | ")}`);

// ---------- prices ----------
const items = [...names].filter(n => ids[n]).map(n => ({ name: n, id: ids[n] }));
const prices = {};
const failed = await pool(items, 6, async it => {
  const orders = [];
  for (let page = 1, pages = 1; page <= pages; page++) {
    const { data, headers } = await esi(`/markets/${REGION}/orders/?type_id=${it.id}&order_type=all&page=${page}`);
    pages = +(headers.get("x-pages") || 1);
    orders.push(...data.filter(o => o.location_id === STATION));
  }
  const buys = orders.filter(o => o.is_buy_order), sells = orders.filter(o => !o.is_buy_order);
  const hf = `${CACHE}/market-history/${it.id}.json`;
  let hist;
  if (existsSync(hf) && Date.now() - (await stat(hf)).mtimeMs < 20 * 3600e3) hist = JSON.parse(await readFile(hf, "utf8"));
  else {
    // items that can't be sold on the market (e.g. the scanning blueprint crates) have no history: ESI answers 400
    try { hist = (await esi(`/markets/${REGION}/history/?type_id=${it.id}`)).data.slice(-30); } catch { hist = []; }
    await writeFile(hf, JSON.stringify(hist));
  }
  const traded30d = hist.reduce((a, d) => a + d.volume, 0);
  const last = hist.length ? hist[hist.length - 1] : null;
  prices[it.name] = {
    typeId: it.id,
    buy: buys.length ? Math.max(...buys.map(o => o.price)) : null,
    sell: sells.length ? Math.min(...sells.map(o => o.price)) : null,
    buyVolume: buys.reduce((a, o) => a + o.volume_remain, 0),
    sellVolume: sells.reduce((a, o) => a + o.volume_remain, 0),
    traded30d, tradedDays: hist.filter(d => d.volume > 0).length,
    lastAverage: last ? last.average : null,
    // thin: hardly trades, so the order book says little about what it's worth
    thin: traded30d < 10
  };
});

log(`${Object.keys(prices).length} priced, ${failed} failed, ${unknown.length} names without a type ID, ${stats.requests} ESI requests`);
await writeFile(`${OUT}/prices.json`, JSON.stringify({
  fetchedAt: new Date().toISOString(),
  market: "Jita IV - Moon 4 - Caldari Navy Assembly Plant (The Forge)", source: "CCP ESI market orders and history",
  basis: "buy = highest Jita 4-4 buy order (sell now), sell = lowest Jita 4-4 sell order; traded30d = units traded in The Forge over the last 30 days; thin = fewer than 10 traded in 30 days",
  failed, unknown, items: Object.fromEntries(Object.entries(prices).sort((a, b) => a[0].localeCompare(b[0])))
}, null, 1));
log(`wrote ${OUT}/prices.json`);
