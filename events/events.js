// Events section: shared helpers (data loading, formatting, countdowns, footer).
"use strict";
const EV = (() => {
  const cache = {};
  const load = name => (cache[name] ||= fetch(`data/${name}.json`, { cache: "no-cache" }).then(r => { if (!r.ok) throw new Error(`${name}.json: ${r.status}`); return r.json(); }));
  const optional = name => load(name).catch(() => null);

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const nf = new Intl.NumberFormat("en-GB");
  const num = n => n == null ? "–" : nf.format(Math.round(n));
  const dec = (n, d = 1) => n == null ? "–" : n.toLocaleString("en-GB", { minimumFractionDigits: d, maximumFractionDigits: d });
  // ISK in the short form players use: 10.3m, 1.2b
  const isk = n => n == null ? "–" : Math.abs(n) >= 1e9 ? `${dec(n / 1e9, 2)}b` : Math.abs(n) >= 1e6 ? `${dec(n / 1e6, Math.abs(n) < 1e8 ? 2 : 0)}m` : Math.abs(n) >= 1e4 ? `${dec(n / 1e3, 1)}k` : nf.format(Math.round(n));

  const date = (iso, withTime) => {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) + (withTime ? ` ${d.toISOString().slice(11, 16)} UTC` : "");
  };
  function until(iso) {
    const ms = new Date(iso) - Date.now();
    if (ms <= 0) return "ended";
    const d = Math.floor(ms / 864e5), h = Math.floor(ms % 864e5 / 36e5);
    return d ? `${d} day${d === 1 ? "" : "s"} ${h} h left` : `${h} h ${Math.floor(ms % 36e5 / 6e4)} min left`;
  }
  // running / starts in / ended, for a {start, end} pair (either may be null)
  function status(start, end) {
    const now = Date.now();
    if (start && new Date(start) > now) return { cls: "st-soon", text: "Starts " + date(start) };
    if (end && new Date(end) <= now) return { cls: "", text: "Ended" };
    if (!end) return { cls: "st-ongoing", text: "Ongoing" };
    return { cls: "st-live", text: "Running" };
  }

  function footer(extra = "") {
    const f = document.createElement("footer");
    f.innerHTML = `${extra}
      <p>Prices from CCP's ESI market data for Jita 4-4, refreshed hourly. Event facts are summarised in our own words from the sources listed on each page and checked in game; CCP changes events often, so trust the game if something here doesn't match.</p>
      <p>© 2014 CCP hf. All rights reserved. “EVE”, “EVE Online”, “CCP”, and all related logos and images are trademarks or registered trademarks of CCP hf. This is a fan-made site and isn’t affiliated with or endorsed by CCP.</p>`;
    document.body.appendChild(f);
  }

  return { load, optional, esc, num, dec, isk, date, until, status, footer };
})();
