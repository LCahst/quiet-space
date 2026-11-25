// Wormhole section: Jita 4-4 prices for wormhole gas and ore, from CCP's ESI market data.
// Runs hourly in the Action. WH_OUT = where prices.json goes (default wormholes/data), WH_CACHE = cache folder (default wormholes/.cache).
//
// Run after build-wormholes.mjs and build-sites.mjs:  node scripts/wh/collect-wh-prices.mjs
// Out: $WH_OUT/prices.json
//
// For each item: every order in The Forge (ESI /markets/10000002/orders/), kept only if it's in Jita IV - Moon 4 -
// Caldari Navy Assembly Plant (60003760). Price = volume-weighted average of the best orders until they would take
// a load of DEPTH_M3 (50,000 m³), so a tiny order at an odd price can't set the figure, and the huge low-ball buy
// orders that sit at Jita (millions of units at token prices) don't drag it down either.
//   buy  = what Jita buy orders pay now (selling straight away) — the headline value
//   sell = what Jita sellers ask (often missing for raw ore, which mostly trades compressed)
// Ore is priced raw and compressed (one compressed unit refines like one raw unit; the load is the same number of units).
// Trade volume: average units traded a day in The Forge over the last 30 days (ESI market history, updated daily by CCP,
// so it's cached for 20 hours).

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { esi, pool, stats } from "../lib/esi.mjs";

const REGION = 10000002, STATION = 60003760, DEPTH_M3 = 50000;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const read = async f => JSON.parse(await readFile(f, "utf8"));

const ful = await read("wormholes/data/fullerites.json");
const oreVol = await read("wormholes/data/ore-volumes.json");
const ore = await read("wormholes/data/ore.json");
const items = [];
for (const [code, id] of Object.entries(ful.typeIds)) items.push({ key: code, name: `Fullerite-${code}`, id, kind: "gas", m3: ful.volumes[code] });
const oreNames = new Set(Object.values(ore.sites).flatMap(s => s.ore.map(o => o.name)));
for (const n of oreNames) {
  const full = `${n} IV-Grade`;
  if (oreVol.typeIds[full]) items.push({ key: n, name: full, id: oreVol.typeIds[full], kind: "ore", m3: oreVol.volumes[full] });
  // compressed: priced over the same number of units as a raw load, so depth uses the raw m³
  if (oreVol.compressedTypeIds?.[full]) items.push({ key: `Compressed ${n}`, name: `Compressed ${full}`, id: oreVol.compressedTypeIds[full], kind: "compressed ore", m3: oreVol.volumes[full] });
}
log(`${items.length} items: ${items.filter(i => i.kind === "gas").length} gases, ${items.filter(i => i.kind === "ore").length} ores`);

// volume-weighted average over the best orders (highest buys / lowest sells) until they cover DEPTH_M3 of cargo
function topPrice(orders, buy, m3) {
  if (!orders.length) return null;
  const sorted = [...orders].sort((a, b) => buy ? b.price - a.price : a.price - b.price);
  const total = sorted.reduce((a, o) => a + o.volume_remain, 0), want = Math.min(total, Math.max(1, Math.round(DEPTH_M3 / m3)));
  let got = 0, value = 0;
  for (const o of sorted) { const take = Math.min(o.volume_remain, want - got); got += take; value += take * o.price; if (got >= want) break; }
  return Math.round(value / got * 100) / 100;
}

const HIST = `${process.env.WH_CACHE || "wormholes/.cache"}/market-history`;
const OUT = process.env.WH_OUT || "wormholes/data";
await mkdir(OUT, { recursive: true });
await mkdir(HIST, { recursive: true });
const prices = {};
const failed = await pool(items, 6, async it => {
  const orders = [];
  let regionBestBuy = null;
  for (let page = 1, pages = 1; page <= pages; page++) {
    const { data, headers } = await esi(`/markets/${REGION}/orders/?type_id=${it.id}&order_type=all&page=${page}`);
    pages = +(headers.get("x-pages") || 1);
    orders.push(...data.filter(o => o.location_id === STATION));
    for (const o of data) if (o.is_buy_order && o.volume_remain * it.m3 >= 1000 && (regionBestBuy == null || o.price > regionBestBuy)) regionBestBuy = o.price;
  }
  const buys = orders.filter(o => o.is_buy_order), sells = orders.filter(o => !o.is_buy_order);
  // 30-day trade volume (cached 20 h: CCP updates market history once a day)
  const hf = `${HIST}/${it.id}.json`;
  let hist = null;
  if (existsSync(hf) && Date.now() - (await stat(hf)).mtimeMs < 20 * 3600e3) hist = JSON.parse(await readFile(hf, "utf8"));
  else { hist = (await esi(`/markets/${REGION}/history/?type_id=${it.id}`)).data.slice(-30); await writeFile(hf, JSON.stringify(hist)); }
  const tradedPerDay = hist.length ? Math.round(hist.reduce((a, d) => a + d.volume, 0) / hist.length) : 0;
  prices[it.key] = {
    name: it.name, typeId: it.id, kind: it.kind, m3: it.m3,
    buy: topPrice(buys, true, it.m3), sell: topPrice(sells, false, it.m3), regionBestBuy,
    bestBuy: buys.length ? Math.max(...buys.map(o => o.price)) : null, bestSell: sells.length ? Math.min(...sells.map(o => o.price)) : null,
    buyVolume: buys.reduce((a, o) => a + o.volume_remain, 0), sellVolume: sells.reduce((a, o) => a + o.volume_remain, 0),
    tradedPerDay, tradedDays: hist.filter(d => d.volume > 0).length, historyDays: hist.length
  };
});

// Few real buyers at Jita 4-4 itself when its price is under half the best sizeable buy order elsewhere in The Forge
// (e.g. compressed Omber: one 1.11 ISK order at Jita while a nearby structure buys at 120).
for (const p of Object.values(prices)) p.fewBuyersAtJita = p.buy != null && p.regionBestBuy != null && p.buy < p.regionBestBuy * 0.5;
const few = Object.values(prices).filter(p => p.fewBuyersAtJita).map(p => p.name);
if (few.length) log(`few buyers at Jita 4-4: ${few.join(", ")}`);
const missingBuy = Object.values(prices).filter(p => p.buy == null).map(p => p.name);
log(`${Object.keys(prices).length} priced, ${failed} failed, ${stats.requests} ESI requests; no buy orders for: ${missingBuy.join(", ") || "none"}`);
const sorted = Object.fromEntries(Object.entries(prices).sort((a, b) => a[1].kind.localeCompare(b[1].kind) || a[0].localeCompare(b[0])));
const thin = Object.entries(sorted).filter(([, v]) => v.tradedPerDay === 0).map(([k]) => k);
if (thin.length) log(`no trades in 30 days: ${thin.join(", ")}`);
await writeFile(`${OUT}/prices.json`, JSON.stringify({
  fetchedAt: new Date().toISOString(), market: "Jita IV - Moon 4 - Caldari Navy Assembly Plant (The Forge)", source: "CCP ESI market orders",
  basis: `average price over the best orders for a ${DEPTH_M3.toLocaleString("en-GB")} m³ load (compressed ore: the same number of units); buy = Jita buy orders (sell now), sell = Jita sell orders; tradedPerDay = average units traded a day in The Forge over the last 30 days`, depthM3: DEPTH_M3,
  failed, items: sorted
}, null, 1));
log(`wrote ${OUT}/prices.json`);
