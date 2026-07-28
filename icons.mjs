// Downloads all entry icons into docs/assets/icons/ and rewrites icon URLs to
// local relative paths, so the published site doesn't hotlink poe2db's CDN.
// Run after scrape.mjs. Idempotent: already-downloaded files are kept.
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const ROOT = import.meta.dirname;
const DATA = path.join(ROOT, "docs", "data");
const ICONS = path.join(ROOT, "docs", "assets", "icons");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) poe2-cn-en reference builder";
const DELAY_MS = 80;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await mkdir(ICONS, { recursive: true });
const data = JSON.parse(await readFile(path.join(DATA, "reference.json"), "utf8"));

// unique remote URLs -> local filename (basename + short hash to avoid collisions)
const urls = new Map();
for (const e of data.entries) {
  if (e.icon && /^https?:/.test(e.icon)) {
    if (!urls.has(e.icon)) {
      const base = decodeURIComponent(e.icon.split("/").pop() ?? "icon.webp")
        .replace(/\?.*$/, "")
        .replace(/[^A-Za-z0-9._-]/g, "_");
      const hash = createHash("sha1").update(e.icon).digest("hex").slice(0, 6);
      urls.set(e.icon, `${hash}_${base}`.toLowerCase());
    }
  }
}
console.log(`${urls.size} unique icons`);

let done = 0;
let failed = 0;
for (const [url, file] of urls) {
  const target = path.join(ICONS, file);
  try {
    await access(target);
  } catch {
    try {
      await sleep(DELAY_MS);
      const res = await fetch(url, { headers: { "User-Agent": UA, "Referer": "https://poe2db.tw/" } });
      if (!res.ok) throw new Error(String(res.status));
      await writeFile(target, Buffer.from(await res.arrayBuffer()));
    } catch (err) {
      console.warn(`  ! ${url}: ${err.message}`);
      urls.delete(url); // keep remote URL in data for this one
      failed++;
      continue;
    }
  }
  done++;
  if (done % 200 === 0) console.log(`  ${done}/${urls.size}`);
}
console.log(`downloaded/present: ${done}, failed: ${failed}`);

for (const e of data.entries) {
  if (e.icon && urls.has(e.icon)) e.icon = `assets/icons/${urls.get(e.icon)}`;
}

await writeFile(path.join(DATA, "reference.json"), JSON.stringify(data, null, 1));
await writeFile(path.join(DATA, "reference.js"), "window.POE2REF = " + JSON.stringify(data) + ";\n");
console.log("rewrote docs/data/reference.{json,js} with local icon paths");
