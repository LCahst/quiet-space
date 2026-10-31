// Daily job: saves the first few kilobytes of data feeds that later features will use,
// so their real format can be checked before building on them. Never fails the workflow.
import { writeFile, mkdir } from "node:fs/promises";

const DATA = process.env.DATA_DIR || "data";
const OUT = `${DATA}/samples`;
const UA = `QuietSpace/1.0 (+https://github.com/${process.env.GITHUB_REPOSITORY || "local"})`;
const FEEDS = {
  "insurgency.txt": "https://www.eveonline.com/api/warzone/insurgency",
  "everef-structures.txt": "https://data.everef.net/structures/structures-latest.v2.json"
};
const LIMIT = 6000;

await mkdir(OUT, { recursive: true });
for (const [name, url] of Object.entries(FEEDS)) {
  let text;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, "Range": `bytes=0-${LIMIT - 1}` } });
    let body = "";
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    while (body.length < LIMIT) {
      const { done, value } = await reader.read();
      if (done) break;
      body += dec.decode(value, { stream: true });
    }
    try { await reader.cancel(); } catch {}
    text = `URL: ${url}\nStatus: ${res.status}\nContent-Type: ${res.headers.get("content-type")}\nFetched: ${new Date().toISOString()}\n\n${body.slice(0, LIMIT)}`;
  } catch (e) {
    text = `URL: ${url}\nFailed: ${e.message}\nFetched: ${new Date().toISOString()}\n`;
  }
  await writeFile(`${OUT}/${name}`, text);
  console.log(`Saved sample ${name}`);
}
