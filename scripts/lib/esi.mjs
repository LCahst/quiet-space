// Small ESI client for the scheduled GitHub Action. Node 20+, no dependencies.
export const ESI = process.env.ESI_BASE || "https://esi.evetech.net";
export const COMPAT_DATE = "2026-08-18";
const UA = `QuietSpace/1.0 (+https://github.com/${process.env.GITHUB_REPOSITORY || "local"})`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pauseUntil = 0;
export const stats = { requests: 0, retries: 0, failures: 0 };

export async function esi(path, opts = {}, attempt = 0) {
  const wait = pauseUntil - Date.now();
  if (wait > 0) await sleep(wait);
  const headers = {
    "User-Agent": UA,
    "Accept": "application/json",
    "X-Compatibility-Date": opts.compatDate || COMPAT_DATE,
    ...(opts.headers || {})
  };
  stats.requests++;
  let res;
  try {
    res = await fetch(ESI + path, { method: opts.method || "GET", headers, body: opts.body });
  } catch (e) {
    if (attempt < 4) { stats.retries++; await sleep(1000 * 2 ** attempt); return esi(path, opts, attempt + 1); }
    stats.failures++;
    throw new Error(`Network error for ${path}: ${e.message}`);
  }
  // Back off before ESI starts refusing us.
  const remain = res.headers.get("x-esi-error-limit-remain");
  const reset = res.headers.get("x-esi-error-limit-reset");
  if (remain !== null && +remain < 20) pauseUntil = Math.max(pauseUntil, Date.now() + ((+reset || 10) + 1) * 1000);
  const rl = res.headers.get("x-ratelimit-remaining");
  if (rl !== null && +rl < 10) pauseUntil = Math.max(pauseUntil, Date.now() + 2000);

  if (res.status === 429 && attempt < 8) {
    const ra = +res.headers.get("retry-after") || 10;
    pauseUntil = Math.max(pauseUntil, Date.now() + ra * 1000);
    stats.retries++;
    return esi(path, opts, attempt + 1);
  }
  if (res.status >= 500 && attempt < 4) { stats.retries++; await sleep(1500 * 2 ** attempt); return esi(path, opts, attempt + 1); }
  if (!res.ok) { stats.failures++; throw new Error(`ESI answered ${res.status} for ${path}`); }
  return { data: await res.json(), headers: res.headers };
}

// Run fn over items with limited concurrency; failures are counted, not fatal.
export async function pool(items, size, fn) {
  let i = 0, failed = 0;
  const worker = async () => {
    while (i < items.length) {
      const item = items[i++];
      try { await fn(item); } catch (e) { failed++; if (failed <= 5) console.warn("  skipped:", e.message); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  if (failed > 5) console.warn(`  ...and ${failed - 5} more skipped`);
  return failed;
}

// Resolve IDs to names in batches of 1,000.
export async function names(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 1000) {
    const { data } = await esi("/universe/names/", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ids.slice(i, i + 1000))
    });
    data.forEach(d => { out[d.id] = d.name; });
  }
  return out;
}
