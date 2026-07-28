// Scrapes poe2db.tw EN (/us/) and CN (/cn/) pages and pairs official text
// into data/reference.js for the offline viewer (index.html).
//
// Usage: node scrape.mjs            (uses cache/ for previously fetched pages)
//        node scrape.mjs --fresh    (ignores cache)
import * as cheerio from "cheerio";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";

const ROOT = import.meta.dirname;
const CACHE = path.join(ROOT, "cache");
const OUT = path.join(ROOT, "docs", "data");
const FRESH = process.argv.includes("--fresh");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) poe2-cn-en reference builder";
const DELAY_MS = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastFetch = 0;

async function getPage(lang, slug) {
  const cacheFile = path.join(CACHE, `${lang}_${slug.replaceAll("/", "_")}.html`);
  if (!FRESH) {
    try {
      await access(cacheFile);
      return await readFile(cacheFile, "utf8");
    } catch {}
  }
  const wait = lastFetch + DELAY_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastFetch = Date.now();
  const url = `https://poe2db.tw/${lang}/${slug}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  const html = await res.text();
  await writeFile(cacheFile, html);
  return html;
}

function cleanText($el) {
  return $el
    .text()
    .replace(/\s+\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

// Parse every "card" section on a page into { header, entries[] } where an
// entry is the d-flex icon+text pattern used for boons, mods, pledges, rooms.
function parseCardSections(html) {
  const $ = cheerio.load(html);
  const sections = [];
  $("div.card").each((_, card) => {
    const header = $(card).find("h5.card-header").first().text().trim();
    const entries = [];
    $(card)
      .find("div.d-flex")
      .each((_, row) => {
        const $row = $(row);
        const $img = $row.find(".flex-shrink-0 img").first();
        const icon = $img.attr("alt") ?? "";
        const iconUrl = $img.attr("src") ?? "";
        const $body = $row.find(".flex-grow-1").first();
        if (!$body.length) return;
        // name = text before the first <br> or child div; text after a <br>
        // (e.g. "Floor: Test of Strength" for rooms) becomes part of sub
        let name = "";
        let tail = "";
        let seenBreak = false;
        $body.contents().each((_, node) => {
          if (node.name === "div") return false;
          if (node.name === "br") {
            seenBreak = true;
            return;
          }
          const t = node.type === "text" || node.name === "a" || node.name === "span" ? $(node).text() : "";
          if (seenBreak) tail += t;
          else name += t;
        });
        name = name.replace(/\s+/g, " ").trim();
        // subcategory = first plain child div (no class), e.g. "Minor Boons"
        const sub = [
          $body.children("div:not([class])").first().text().trim(),
          tail.replace(/\s+/g, " ").trim(),
        ]
          .filter(Boolean)
          .join(" · ");
        const desc = $body
          .children("div.explicitMod, div.implicitMod")
          .map((_, d) => cleanText($(d)))
          .get()
          .join("\n");
        if (!name && !desc) return;
        entries.push({ icon, iconUrl, name, sub, desc });
      });
    sections.push({ header, entries });
  });
  return sections;
}

// Pair EN/CN sections: pick EN sections whose header starts with a configured
// prefix, then use the same section INDEX on the CN page (section order is
// identical across languages; headers themselves are translated).
function pairSections(enHtml, cnHtml, prefixToCat) {
  const en = parseCardSections(enHtml);
  const cn = parseCardSections(cnHtml);
  if (en.length !== cn.length) {
    console.warn(`  ! section count differs: en=${en.length} cn=${cn.length} (pairing by index may misalign)`);
  }
  const out = [];
  en.forEach((sec, i) => {
    const cat = Object.entries(prefixToCat).find(([p]) => sec.header.startsWith(p))?.[1];
    if (!cat) return;
    const cnSec = cn[i];
    if (!cnSec || cnSec.entries.length !== sec.entries.length) {
      console.warn(`  ! entry count mismatch in "${sec.header}": en=${sec.entries.length} cn=${cnSec?.entries.length ?? 0}`);
    }
    sec.entries.forEach((e, j) => {
      const c = cnSec?.entries[j];
      if (c && c.icon !== e.icon) {
        console.warn(`  ! icon mismatch at ${sec.header}[${j}]: ${e.icon} vs ${c.icon}`);
      }
      out.push({
        cat,
        key: `${cat}/${e.icon || j}#${j}`,
        icon: e.iconUrl || "",
        en: { name: e.name, sub: e.sub, desc: e.desc },
        cn: c ? { name: c.name, sub: c.sub, desc: c.desc } : null,
      });
    });
    console.log(`  ${sec.header.trim()} -> ${cat}: ${sec.entries.length} entries`);
  });
  return out;
}

// ---- Quests ----------------------------------------------------------------

function parseQuestIndex(html) {
  const $ = cheerio.load(html);
  // quest pane id is "Quest" on /us and localized "使命" on /cn
  const pane = $("[id='Quest'], [id='使命']").first();
  const quests = new Map();
  pane.find("a.questitem").each((_, a) => {
    const slug = ($(a).attr("href") ?? "").split("/").pop();
    if (!slug || quests.has(slug)) return;
    const name = $(a).text().trim();
    if (!name) return;
    // sibling div.property elements hold type ("Normal"/"主线"), act
    // ("Act 1"/"第 1 章"), reward ("Reward: ..."/"奖励: ...")
    const props = $(a)
      .closest(".flex-grow-1")
      .find("div.property")
      .map((_, p) => $(p).text().replace(/\s+/g, " ").trim())
      .get();
    const isReward = (p) => /^(Reward:|奖励[:：])/.test(p);
    const sub = props.filter((p) => p && !isReward(p)).slice(0, 2).join(" · ");
    const act = props.map((p) => p.match(/Act (\d+)/) ?? p.match(/第 ?(\d+) ?章/)).find(Boolean)?.[1] ?? "";
    const reward = props.find(isReward) ?? "";
    quests.set(slug, { name, sub, act, reward });
  });
  return quests;
}

function parseQuestDetail(html) {
  const $ = cheerio.load(html);
  const icon = $(".itemboximage img").first().attr("src") ?? "";
  const desc = cleanText($("div.implicitMod").first());
  const rewardText = $('span:contains("Reward:")').length
    ? cleanText($('span:contains("Reward:")').first())
    : "";
  const steps = [];
  $("table").each((_, t) => {
    const heads = $(t)
      .find("thead th")
      .map((_, th) => $(th).text().trim())
      .get();
    if (heads[0] !== "#") return;
    $(t)
      .find("tbody tr")
      .each((_, tr) => {
        const tds = $(tr).children("td");
        const n = $(tds[0]).text().trim();
        const cellHtml = $(tds[1]).html() ?? "";
        const area = $(tds[1]).find("span.MapPins").first().text().trim();
        const parts = cellHtml
          .split(/<br\s*\/?>/i)
          .map((p) => cheerio.load(`<x>${p}</x>`)("x").text().replace(/\s+/g, " ").trim())
          .filter((p) => p && !/^(Area|区域)[:：]/.test(p));
        const name = parts.shift() ?? "";
        steps.push({ n, name, desc: parts.join(" "), area });
      });
  });
  return { icon, desc, rewardText, steps };
}

async function scrapeQuests() {
  console.log("Quests:");
  const enIdx = parseQuestIndex(await getPage("us", "Quest"));
  const cnIdx = parseQuestIndex(await getPage("cn", "Quest"));
  const out = [];
  let i = 0;
  for (const [slug, enQ] of enIdx) {
    i++;
    const cnQ = cnIdx.get(slug);
    let enD = null;
    let cnD = null;
    try {
      enD = parseQuestDetail(await getPage("us", slug));
      cnD = parseQuestDetail(await getPage("cn", slug));
    } catch (err) {
      console.warn(`  ! detail failed for ${slug}: ${err.message}`);
    }
    // align steps by number
    const steps = (enD?.steps ?? []).map((s) => {
      const c = (cnD?.steps ?? []).find((x) => x.n === s.n) ?? null;
      return { n: s.n, en: { name: s.name, desc: s.desc, area: s.area }, cn: c ? { name: c.name, desc: c.desc, area: c.area } : null };
    });
    out.push({
      cat: "quest",
      key: `quest/${slug}`,
      slug,
      icon: enD?.icon ?? "",
      act: enQ.act || cnQ?.act || "",
      en: { name: enQ.name, sub: enQ.sub, desc: enD?.desc ?? "", reward: enQ.reward },
      cn: cnQ ? { name: cnQ.name, sub: cnQ.sub, desc: cnD?.desc ?? "", reward: cnQ.reward } : null,
      steps,
    });
    if (i % 20 === 0) console.log(`  ${i}/${enIdx.size} quest pages...`);
  }
  console.log(`  quests: ${out.length} entries`);
  return out;
}

// ---- Skill trees (atlas / genesis / passive) -------------------------------
// Node list + grouping comes from maxroll's planner data; localized text comes
// from poe2db per-node pages (same slug on /us and /cn).

const TREE_DATA_URL = "https://assets-ng.maxroll.gg/poe2planner/game/tree404.json";

async function getTreeData() {
  const cacheFile = path.join(CACHE, "maxroll_tree404.json");
  if (!FRESH) {
    try {
      await access(cacheFile);
      return JSON.parse(await readFile(cacheFile, "utf8"));
    } catch {}
  }
  const res = await fetch(TREE_DATA_URL, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${res.status} for ${TREE_DATA_URL}`);
  const text = await res.text();
  await writeFile(cacheFile, text);
  return JSON.parse(text);
}

function nameToSlug(name) {
  // poe2db slugs: text before ":", punctuation stripped, spaces -> "_"
  return name
    .split(":")[0]
    .replaceAll(/['’!?.,]/g, "")
    .trim()
    .replaceAll(/\s+/g, "_");
}

// Parse a poe2db passive/atlas node page: first item popup on the page
function parseNodePage(html) {
  const $ = cheerio.load(html);
  const popup = $(".newItemPopup").first();
  if (!popup.length) return null;
  const name = popup.find(".itemName .lc").first().text().trim();
  if (!name) return null;
  const props = popup
    .find(".Stats .property")
    .map((_, p) => $(p).text().replace(/\s+/g, " ").trim())
    .get()
    .filter((p) => p && !/^SubTree/.test(p));
  const mods = popup
    .find(".implicitMod, .explicitMod")
    .map((_, m) => {
      const $m = $(m);
      const lis = $m.find("li");
      if (lis.length) {
        return lis.map((_, li) => "• " + cleanText($(li))).get().join("\n");
      }
      return cleanText($m);
    })
    .get()
    .filter(Boolean);
  const flavour = cleanText(popup.find(".FlavourText").first());
  const icon = $(".itemboximage img").first().attr("src") ?? "";
  const desc = [...props, ...mods].join("\n");
  return { name, desc, flavour, icon };
}

async function scrapeTrees() {
  console.log("Skill trees (maxroll node lists + poe2db text):");
  const tree = await getTreeData();
  const ps = tree.passive_skills;

  const skip = (s) =>
    !s ||
    !s.name ||
    s.name === "Attribute" ||
    s.variant_type === "GenericAttribute" ||
    s.is_just_icon;

  const kind = (s) => (s.is_keystone ? "Keystone" : s.is_notable ? "Notable" : "Small");

  // slug -> { cats: Map<cat, {sub, kinds:Set}>, names:Set }
  const wanted = new Map();
  const addSkill = (s, cat, sub) => {
    if (skip(s)) return;
    const slug = nameToSlug(s.name);
    if (!wanted.has(slug)) wanted.set(slug, { cats: new Map(), fallbackName: s.name.split(":")[0].trim() });
    const w = wanted.get(slug);
    const k = `${cat} ${sub}`;
    if (!w.cats.has(k)) w.cats.set(k, { cat, sub, kinds: new Set() });
    w.cats.get(k).kinds.add(kind(s));
  };
  const addNodes = (nodes, cat, subOf) => {
    for (const node of Object.values(nodes)) {
      const s = ps[node.skill_id];
      if (s) addSkill(s, cat, subOf ? subOf(s) : "");
    }
  };

  addNodes(tree.atlas_passive_tree.nodes, "atlas-tree", (s) => s.atlas_sub_tree ?? "Core");
  // master sub-tree skills are flagged in passive_skills; some (e.g. the whole
  // Expedition cluster) are absent from atlas_passive_tree.nodes, so add the
  // flagged set directly
  for (const s of Object.values(ps)) {
    if (s.atlas_sub_tree) addSkill(s, "atlas-tree", s.atlas_sub_tree);
  }
  addNodes(tree.genesis_passive_tree.nodes, "genesis-tree", () => "");
  addNodes(tree.passive_tree.nodes, "passive-tree", (s) => (s.ascendancy ? `Ascendancy: ${s.ascendancy}` : ""));

  console.log(`  ${wanted.size} unique node pages to fetch`);
  const out = [];
  const misses = [];
  let i = 0;
  for (const [slug, w] of wanted) {
    i++;
    if (i % 100 === 0) console.log(`  ${i}/${wanted.size} node pages...`);
    let enP = null;
    let cnP = null;
    try {
      enP = parseNodePage(await getPage("us", slug));
    } catch {}
    try {
      cnP = parseNodePage(await getPage("cn", slug));
    } catch {}
    if (!enP) {
      misses.push(slug);
      continue;
    }
    for (const { cat, sub, kinds } of w.cats.values()) {
      const kindLabel = [...kinds].sort().join("/");
      const subLabel = [sub, kindLabel].filter(Boolean).join(" · ");
      out.push({
        cat,
        key: `${cat}/${slug}`,
        icon: enP.icon,
        en: { name: enP.name, sub: subLabel, desc: enP.desc, flavour: enP.flavour },
        cn: cnP ? { name: cnP.name, sub: subLabel, desc: cnP.desc, flavour: cnP.flavour } : null,
      });
    }
  }
  if (misses.length) {
    console.warn(`  ! ${misses.length} node pages missing/unparsable on poe2db:`);
    console.warn("    " + misses.slice(0, 30).join(", ") + (misses.length > 30 ? " ..." : ""));
  }
  const counts = {};
  for (const e of out) counts[e.cat] = (counts[e.cat] ?? 0) + 1;
  console.log("  tree entries:", JSON.stringify(counts));
  return out;
}

// ---- Atlas Masters ---------------------------------------------------------
// poe2db /us/Atlas_Masters and /cn/Atlas_Masters list all master specialization
// nodes (Doryani's Science, Hilda's Hunting, Jado's Spycraft) with a
// "<name> <span>Master's Spec T#</span>" row; paired by icon filename.

function parseMastersPage(html) {
  const $ = cheerio.load(html);
  const out = [];
  $("div.d-flex.border-top").each((_, row) => {
    const $row = $(row);
    const $img = $row.children(".flex-shrink-0").find("img").first();
    const iconKey = $img.attr("alt") ?? "";
    const iconUrl = $img.attr("src") ?? "";
    const $body = $row.children(".flex-grow-1").first();
    if (!$body.length) return;
    const $nameRow = $body.children("div.d-flex").first();
    if (!$nameRow.length) return;
    const sub = $nameRow.find("span").first().text().replace(/\s+/g, " ").trim();
    const name = $nameRow.clone().children("span").remove().end().text().replace(/\s+/g, " ").trim();
    if (!name) return;
    const desc = $body
      .children("div")
      .not($nameRow)
      .map((_, d) => cleanText($(d)))
      .get()
      .filter(Boolean)
      .join("\n");
    out.push({ iconKey, iconUrl, name, sub, desc });
  });
  return out;
}

async function scrapeAtlasMasters() {
  console.log("Atlas Masters:");
  const en = parseMastersPage(await getPage("us", "Atlas_Masters"));
  const cn = parseMastersPage(await getPage("cn", "Atlas_Masters"));
  const cnByKey = new Map(cn.map((e) => [e.iconKey, e]));
  const out = en.map((e, i) => {
    const c = e.iconKey ? cnByKey.get(e.iconKey) : cn[i];
    return {
      cat: "atlas-master",
      key: `atlas-master/${e.iconKey || i}`,
      icon: e.iconUrl,
      en: { name: e.name, sub: e.sub, desc: e.desc },
      cn: c ? { name: c.name, sub: c.sub, desc: c.desc } : null,
    };
  });
  console.log(`  atlas-master: ${out.length} entries (cn paired: ${out.filter((e) => e.cn).length})`);
  return out;
}

// ---- main ------------------------------------------------------------------

await mkdir(CACHE, { recursive: true });
await mkdir(OUT, { recursive: true });

const entries = [];

console.log("Trial of the Sekhemas:");
entries.push(
  ...pairSections(
    await getPage("us", "Trial_of_the_Sekhemas"),
    await getPage("cn", "Trial_of_the_Sekhemas"),
    {
      "Boon ": "sekhemas-boon",
      "Affliction ": "sekhemas-affliction",
      "Pledges ": "sekhemas-pledge",
      "Rooms ": "sekhemas-room",
    },
  ),
);

console.log("Trial of Chaos (Ultimatum):");
entries.push(
  ...pairSections(await getPage("us", "Ultimatum"), await getPage("cn", "Ultimatum"), {
    "Modifiers ": "chaos-mod",
  }),
);

entries.push(...(await scrapeQuests()));
entries.push(...(await scrapeAtlasMasters()));
entries.push(...(await scrapeTrees()));

// drop unlocalized internal rows (CamelCase key shown as name in both
// languages, no description) — they have no player-facing text
const before = entries.length;
const filtered = entries.filter(
  (e) => !(e.cn && e.cn.name === e.en.name && !e.en.desc && /^[A-Za-z]+$/.test(e.en.name)),
);
if (filtered.length !== before) console.log(`dropped ${before - filtered.length} unlocalized internal entries`);
entries.length = 0;
entries.push(...filtered);

const data = {
  generated: new Date().toISOString(),
  source: "poe2db.tw (/us and /cn)",
  entries,
};
await writeFile(path.join(OUT, "reference.js"), "window.POE2REF = " + JSON.stringify(data, null, 1) + ";\n");
await writeFile(path.join(OUT, "reference.json"), JSON.stringify(data, null, 1));
console.log(`\nWrote ${entries.length} entries to data/reference.js`);
const missing = entries.filter((e) => !e.cn).length;
if (missing) console.warn(`${missing} entries have no CN pairing`);
