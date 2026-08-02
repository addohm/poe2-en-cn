// Scrapes poe2db.tw EN (/us/) and CN (/cn/) pages and pairs official text
// into data/reference.js for the offline viewer (index.html).
//
// Usage: node scrape.mjs            (uses cache/ for previously fetched pages)
//        node scrape.mjs --fresh    (ignores cache)
import * as cheerio from "cheerio";
import { mkdir, readFile, writeFile, access, rm } from "node:fs/promises";
import path from "node:path";

const ROOT = import.meta.dirname;
const CACHE = path.join(ROOT, "cache");
const OUT = path.join(ROOT, "docs", "data");
const FRESH = process.argv.includes("--fresh");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) poe2-cn-en reference builder";
const DELAY_MS = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastFetch = 0;

async function getUrl(url, cacheName, { fast = false, headers = {} } = {}) {
  const cacheFile = path.join(CACHE, cacheName);
  if (!FRESH) {
    try {
      await access(cacheFile);
      return await readFile(cacheFile, "utf8");
    } catch {}
  }
  for (let attempt = 0; ; attempt++) {
    // CDN fetches (fast) are cheap static files; site pages get the full delay
    const wait = lastFetch + (fast ? 100 : DELAY_MS) - Date.now();
    if (wait > 0) await sleep(wait);
    lastFetch = Date.now();
    const res = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
    if (res.ok) {
      const html = await res.text();
      await writeFile(cacheFile, html);
      return html;
    }
    // poe2db intermittently 503s under load — back off and retry
    if ((res.status === 503 || res.status === 429) && attempt < 4) {
      await sleep(3000 * (attempt + 1));
      continue;
    }
    throw new Error(`${res.status} for ${url}`);
  }
}

async function getPage(lang, slug) {
  return getUrl(`https://poe2db.tw/${lang}/${slug}`, `${lang}_${slug.replaceAll("/", "_")}.html`);
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

// ---- Story rewards ---------------------------------------------------------
// Selectable permanent campaign boons are quest items with "Grants ..." stat
// mods (Venom Draughts, Tattoos, medallions, ...), listed with full mod text
// in the Quest page's Quest Items pane. Passive/atlas point books excluded.

function parseQuestItemsPane(html) {
  const $ = cheerio.load(html);
  const pane = $("[id='QuestItem'], [id='任务物品']").first();
  const out = [];
  pane.find("div.d-flex.border-top").each((_, row) => {
    const $row = $(row);
    const $a = $row.find("a.questitem").last();
    const slug = ($a.attr("href") ?? "").split("/").pop();
    const name = $a.text().trim();
    const hover = decodeURIComponent($row.find("a.questitem").first().attr("data-hover") ?? "");
    const act = hover.match(/Act(\d+)/)?.[1] ?? "";
    const icon = $row.find("img").first().attr("src") ?? "";
    const mods = $row.find("div.explicitMod").map((_, m) => cleanText($(m))).get();
    if (slug && name) out.push({ slug, name, act, icon, mods });
  });
  return out;
}

async function scrapeStoryRewards(questEntries) {
  console.log("Story rewards:");
  const en = parseQuestItemsPane(await getPage("us", "Quest"));
  const cn = parseQuestItemsPane(await getPage("cn", "Quest"));
  const cnBySlug = new Map(cn.map((x) => [x.slug, x]));
  const isBoon = (x) =>
    x.mods.some((m) => /^Grants? /i.test(m)) &&
    !x.mods.some((m) => /(Passive|Atlas|Weapon Set) .*(Skill|Respec) Points?/i.test(m)) &&
    !/DNT/.test(x.name + x.mods.join(""));
  const seen = new Set();
  const out = [];
  for (const x of en.filter(isBoon)) {
    if (seen.has(x.slug)) continue;
    seen.add(x.slug);
    const c = cnBySlug.get(x.slug) ?? null;
    // cross-reference the quests that offer this item as a reward
    const src = questEntries.filter((q) => (q.en.reward ?? "").includes(x.name));
    const srcEn = src.map((q) => q.en.name + (q.act ? ` (Act ${q.act})` : "")).join(", ");
    const srcCn = src.map((q) => q.cn?.name).filter(Boolean).join("，");
    const act = x.act || (src[0]?.act ?? "");
    out.push({
      cat: "story-reward",
      key: `story/${x.slug}`,
      icon: x.icon,
      act,
      en: { name: x.name, sub: act ? `Act ${act}` : "", desc: x.mods.join("\n"), reward: srcEn ? `Quest: ${srcEn}` : "" },
      cn: c
        ? { name: c.name, sub: act ? `第 ${act} 章` : "", desc: c.mods.join("\n"), reward: srcCn ? `任务：${srcCn}` : "" }
        : null,
    });
  }
  console.log(`  story rewards: ${out.length} (cn paired: ${out.filter((e) => e.cn).length})`);
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

// ---- Atlas maps ------------------------------------------------------------
// poe2db /us/Waystones and /cn/Waystones share unlocalized pane ids:
// #EndGameMaps (map nodes, paired by WorldAreas href slug) and
// #MapLegends (atlas markers, paired by icon filename).

const MAP_KIND = { AtlasIconContentUniqueMap: "Unique Map", AtlasIconContentTrader: "Trader", AtlasIconContentHideout: "Hideout" };

function parseMapsPage(html) {
  const $ = cheerio.load(html);
  const maps = [];
  $("#EndGameMaps div.d-flex.border-top").each((_, row) => {
    const $row = $(row);
    const $img = $row.children(".flex-shrink-0").find("img").first();
    const $body = $row.children(".flex-grow-1").first();
    const $a = $body.children("a.WorldAreas").first();
    const slug = ($a.attr("href") ?? "").split("/").pop();
    const name = $a.text().trim();
    if (!slug || !name) return;
    const info = $body.children("div:not([class])").map((_, d) => cleanText($(d))).get();
    const mods = $body.children("div.implicitMod, div.explicitMod").map((_, d) => cleanText($(d))).get();
    const flavour = cleanText($body.children("div.FlavourText").first());
    maps.push({
      slug,
      icon: $img.attr("src") ?? "",
      kind: MAP_KIND[$img.attr("alt") ?? ""] ?? "Map",
      name,
      desc: [...info, ...mods].filter(Boolean).join("\n"),
      flavour,
    });
  });
  const legends = [];
  $("#MapLegends div.d-flex.border-top").each((_, row) => {
    const $row = $(row);
    const $img = $row.children(".flex-shrink-0").find("img").first();
    const key = $img.attr("alt") ?? "";
    const name = $row.children(".flex-grow-1").first().text().replace(/\s+/g, " ").trim();
    if (!key || !name) return;
    legends.push({ key, icon: $img.attr("src") ?? "", name });
  });
  return { maps, legends };
}

// "Biomes: Forest, Swamp" property on map detail pages (label is untranslated
// on /cn pages; values are localized)
function extractBiomes(html) {
  const $ = cheerio.load(html);
  let out = "";
  $("div.property").each((_, p) => {
    const m = $(p).text().match(/Biomes:\s*(.+)/);
    if (m && !out) out = m[1].replace(/\s+/g, " ").trim();
  });
  return out;
}

async function scrapeMaps() {
  console.log("Atlas maps:");
  const en = parseMapsPage(await getPage("us", "Waystones"));
  const cn = parseMapsPage(await getPage("cn", "Waystones"));
  const cnBySlug = new Map(cn.maps.map((m) => [m.slug, m]));
  const cnLegend = new Map(cn.legends.map((l) => [l.key, l]));
  const out = [];
  let i = 0;
  for (const m of en.maps) {
    const c = cnBySlug.get(m.slug) ?? null;
    let enBiomes = "";
    let cnBiomes = "";
    try { enBiomes = extractBiomes(await getPage("us", m.slug)); } catch {}
    try { cnBiomes = extractBiomes(await getPage("cn", m.slug)); } catch {}
    out.push({
      cat: "map",
      key: `map/${m.slug}`,
      icon: m.icon,
      en: { name: m.name, sub: m.kind, desc: m.desc, flavour: m.flavour, biomes: enBiomes },
      cn: c ? { name: c.name, sub: m.kind, desc: c.desc, flavour: c.flavour, biomes: cnBiomes } : null,
    });
    if (++i % 40 === 0) console.log(`  ${i}/${en.maps.length} map detail pages...`);
  }
  for (const l of en.legends) {
    const c = cnLegend.get(l.key) ?? null;
    out.push({
      cat: "map",
      key: `map/legend/${l.key}`,
      icon: l.icon,
      en: { name: l.name, sub: "Legend" },
      cn: c ? { name: c.name, sub: "Legend" } : null,
    });
  }
  console.log(`  maps: ${en.maps.length}, legends: ${en.legends.length}, cn paired: ${out.filter((e) => e.cn).length}/${out.length}`);
  return out;
}

// ---- Classes & ascendancies ------------------------------------------------
// Class list + class->ascendancy mapping from maxroll's data.min.json
// (classes without ascendancies are unreleased stubs); localized names,
// flavour text, and icons from poe2db class/ascendancy pages.

const CHAR_DATA_URL = "https://assets-ng.maxroll.gg/poe2planner/game/data.min.json";

function parseClassPage(html) {
  const $ = cheerio.load(html);
  const name =
    $(".newItemPopup .itemName .lc").first().text().trim() ||
    $("title").text().split(" - ")[0].trim();
  const flavour = cleanText($(".FlavourText").first());
  const icon = $(".itemboximage img").first().attr("src") ?? "";
  return name ? { name, flavour, icon } : null;
}

async function scrapeClasses() {
  console.log("Classes & ascendancies:");
  const data = JSON.parse(await getUrl(CHAR_DATA_URL, "maxroll_data.min.json"));
  const out = [];
  for (const cls of Object.values(data.characters)) {
    const ascNames = Object.values(cls.ascendancies ?? {})
      .map((a) => a.name)
      .filter((n) => n && !/DNT/.test(n));
    if (/DNT/.test(cls.name) || !ascNames.length) continue; // unreleased
    const clsSlug = nameToSlug(cls.name);
    let clsEn = null;
    let clsCn = null;
    try { clsEn = parseClassPage(await getPage("us", clsSlug)); } catch {}
    try { clsCn = parseClassPage(await getPage("cn", clsSlug)); } catch {}
    if (!clsEn) {
      console.warn(`  ! no page for class ${cls.name}`);
      continue;
    }
    // poe2db styles some class names ALL-CAPS
    if (clsEn.name === clsEn.name.toUpperCase()) {
      clsEn.name = clsEn.name.replace(/\S+/g, (w) => w[0] + w.slice(1).toLowerCase());
    }
    const grp = [clsEn.name, clsCn?.name ?? ""];
    out.push({
      cat: "class",
      key: `class/${clsSlug}`,
      icon: clsEn.icon,
      grp,
      en: { name: clsEn.name, sub: "Class", desc: clsEn.flavour },
      cn: clsCn ? { name: clsCn.name, sub: "职业", desc: clsCn.flavour } : null,
    });
    for (const asc of ascNames) {
      const slug = nameToSlug(asc);
      let aEn = null;
      let aCn = null;
      try { aEn = parseClassPage(await getPage("us", slug)); } catch {}
      try { aCn = parseClassPage(await getPage("cn", slug)); } catch {}
      if (!aEn) {
        console.warn(`  ! no page for ascendancy ${asc}`);
        continue;
      }
      out.push({
        cat: "class",
        key: `class/${clsSlug}/${slug}`,
        icon: aEn.icon,
        grp,
        en: { name: aEn.name, sub: "Ascendancy", desc: aEn.flavour },
        cn: aCn ? { name: aCn.name, sub: "升华", desc: aCn.flavour } : null,
      });
    }
  }
  console.log(`  classes: ${out.length} entries (cn paired: ${out.filter((e) => e.cn).length})`);
  return out;
}

// ---- Map content icons -----------------------------------------------------
// The small per-node icons on the atlas (mechanic content, boss markers,
// towers, corruption states, ...) get their in-game tooltip text from
// poe2db's KeywordPopups. CN pages carry the same language-independent
// data-keyword attribute alongside a resolved cache2 hover URL.

const MAP_CONTENT_KEYWORDS = [
  "ContainsBreach", "ContainsRitual", "ContainsDelirium", "ContainsExpedition", "ContainsAbyss",
  "ContainsIncursion", "ContainsCorruption", "ContainsUniqueMap", "ContainsHideout", "ContainsWanderingTrader",
  "Citadel", "PrecursorTower", "CorruptedNexus", "CorruptedBoss", "DeadlyMapBoss", "PowerfulMapBoss",
  "CheckpointMaps", "EndgameHub", "NaturalSpawn", "TheBurningMonoilth", "Shrine", "Strongbox", "Essence",
  "RogueExile", "AzmeriSpirit", "StoneSummoningCircle", "SoulEaterMonster", "SpiritPossessed", "Waystone", "Tablet",
  "DeliriumGigaMirror", "FracturingMirror", "MapBoss", "Biome",
];
const CONTENT_ICON = (k) => {
  const m = k.match(/^Contains(Breach|Ritual|Delirium|Expedition|Incursion|Corruption)$/);
  if (m) return `https://cdn.poe2db.tw/image/art/2dart/uiimages/ingame/atlasscreen/atlasiconcontent/atlasiconcontent${m[1].toLowerCase()}.webp`;
  return "";
};

function parseKeywordHover(html) {
  const $ = cheerio.load(html);
  const name = $("h5.card-header").first().text().trim();
  const desc = cleanText($(".keyword-body").first());
  return name ? { name, desc } : null;
}

async function scrapeMapContents() {
  console.log("Map content icons:");
  const cnHoverByKeyword = new Map();
  for (const page of ["Waystones", "Vaal_City", "Trial_of_the_Sekhemas", "Ultimatum", "Delirium", "Breach", "Ritual", "Expedition", "Abyss"]) {
    let html = "";
    try {
      html = await getPage("cn", page);
    } catch {
      continue;
    }
    const $ = cheerio.load(html);
    $("a[data-keyword]").each((_, a) => {
      const k = $(a).attr("data-keyword");
      const h = $(a).attr("data-hover") ?? "";
      if (k && h.startsWith("http") && !cnHoverByKeyword.has(k)) cnHoverByKeyword.set(k, h);
    });
  }
  const out = [];
  const misses = [];
  for (const k of MAP_CONTENT_KEYWORDS) {
    let enP = null;
    let cnP = null;
    try {
      enP = parseKeywordHover(
        await getUrl(`https://poe2db.tw/us/hover?s=${encodeURIComponent("Data\\KeywordPopups/" + k)}`, `hover_us_kw_${k}.html`),
      );
    } catch {}
    const cnUrl = cnHoverByKeyword.get(k);
    if (cnUrl) {
      try {
        cnP = parseKeywordHover(await getUrl(cnUrl, `hover_cn_kw_${k}.html`, { fast: true, headers: { Referer: "https://poe2db.tw/" } }));
      } catch {}
    }
    if (!enP) {
      misses.push(k);
      continue;
    }
    out.push({
      cat: "map",
      key: `map/content/${k}`,
      icon: CONTENT_ICON(k),
      en: { name: enP.name, sub: "Content", desc: enP.desc },
      cn: cnP ? { name: cnP.name, sub: "Content", desc: cnP.desc } : null,
    });
  }
  if (misses.length) console.warn(`  ! no EN hover for: ${misses.join(", ")}`);
  console.log(`  content keywords: ${out.length} (cn paired: ${out.filter((e) => e.cn).length})`);
  return out;
}

// ---- Buffs & Debuffs -------------------------------------------------------
// poe2db /us/Buff and /cn/Buff "#BuffDefinitions" pane: every buff/debuff with
// its status-bar icon, frame type (Buff/Debuff/Flask/Charges) and subtype
// label (Aura, Curse, Mark, ...). Paired by the internal BuffDefinitions id.

const BUFF_TYPE_CN = { Buff: "增益", Debuff: "减益", Flask: "药剂", Charges: "充能" };

function parseBuffPage(html) {
  const $ = cheerio.load(html);
  const out = [];
  $("#BuffDefinitions div.d-flex.border-top").each((_, row) => {
    const $row = $(row);
    const type = ($row.find(".buff-icon-container").attr("class") ?? "").match(/buff-icon-type__(\w+)/)?.[1] ?? "";
    const iconUrl = $row.find(".buff-icon-container img").first().attr("src") ?? "";
    const $body = $row.children(".flex-grow-1").first();
    const $a = $body.children("a[data-hover]").first();
    // /us pages carry a readable "?s=Data\BuffDefinitions\<id>" hover; /cn
    // pages only a hashed URL, so the shared-language href slug is the key
    const id = decodeURIComponent($a.attr("data-hover") ?? "").match(/BuffDefinitions[\\/]+([^"&]+)$/)?.[1] ?? "";
    const slug = ($a.attr("href") ?? "").split("/").pop() ?? "";
    const name = $a.text().replace(/\s+/g, " ").trim();
    const tail = $body.clone().children("a").remove().end().text().replace(/\s+/g, " ").trim();
    if (!name || (!id && !slug)) return;
    if (/DNT|DoNotUse|\[/i.test(name) || /^CTF/.test(tail)) return;
    out.push({ id, slug, name, type, tail, iconUrl, hover: $a.attr("data-hover") ?? "" });
  });
  return out;
}

// buff ids listed in the /us/Buff page's "Used by monster" tab
function parseMonsterBuffIds(html) {
  const $ = cheerio.load(html);
  const ids = new Set();
  $("[id='Usedbymonster'] a[data-hover]").each((_, a) => {
    const id = decodeURIComponent($(a).attr("data-hover") ?? "").match(/BuffDefinitions[\\/]+([^"&]+)$/)?.[1];
    if (id) ids.add(id);
  });
  return ids;
}

async function scrapeBuffs() {
  console.log("Buffs & debuffs:");
  const monsterIds = parseMonsterBuffIds(await getPage("us", "Buff"));
  const en = parseBuffPage(await getPage("us", "Buff"));
  let cn = [];
  try {
    cn = parseBuffPage(await getPage("cn", "Buff"));
  } catch (err) {
    console.warn(`  ! /cn/Buff unavailable (${err.message}) — CN side empty this run`);
  }
  // guard against poe2db's CDN serving stale English content under /cn during
  // overload: a healthy CN page has mostly-CJK names for common buffs
  const cjkShare = cn.filter((b) => /[一-鿿]/.test(b.name)).length / (cn.length || 1);
  if (cn.length && cjkShare < 0.2) {
    console.warn(`  ! /cn/Buff looks like stale English content (CJK share ${(cjkShare * 100).toFixed(0)}%) — dropping cache, CN side empty this run`);
    await rm(path.join(CACHE, "cn_Buff.html"), { force: true });
    cn = [];
  }
  // both pages list the same dataset in the same order; pair by index when the
  // slug agrees, else fall back to first unused entry with the same slug
  const used = new Set();
  const findCn = (b, i) => {
    if (cn[i] && cn[i].slug === b.slug && !used.has(i)) { used.add(i); return cn[i]; }
    const j = cn.findIndex((c, k) => !used.has(k) && c.slug === b.slug);
    if (j >= 0) { used.add(j); return cn[j]; }
    return null;
  };
  // source classification: each buff's EN detail page has "<Name> Ref /N"
  // sections whose anchors carry typed data-hover ids (UniqueItems, Mods,
  // GrantedEffects, PassiveSkills, ...) — from these we tag where a buff
  // comes from (skills / gear / passives / monsters)
  const SRC_KIND = [
    [/GrantedEffects|ActiveSkills|GemEffects|SkillGems/i, "skills"],
    [/UniqueItems|BaseItemTypes|Essences|^Mods$/i, "gear"],
    [/PassiveSkills/i, "passives"],
    [/MonsterVarieties|MonsterMods/i, "monsters"],
  ];
  const classifyBuffPage = (html) => {
    const $ = cheerio.load(html);
    const src = new Set();
    const headers = $("h5.card-header").map((_, x) => $(x).text().trim()).get();
    if (headers.some((h) => /^(Supported Gem|Level Effect|From) /.test(h + " "))) src.add("skills");
    $("div.card").each((_, card) => {
      const h = $("h5.card-header", card).first().text();
      if (!/Ref \//.test(h)) return;
      $("a[data-hover]", card).each((_, a) => {
        const kind = decodeURIComponent($(a).attr("data-hover") ?? "").match(/Data[\\/]+([A-Za-z]+)/)?.[1];
        if (!kind) return;
        for (const [re, tag] of SRC_KIND) if (re.test(kind)) src.add(tag);
      });
    });
    return [...src];
  };
  const srcBySlug = new Map();
  const buffSources = async (slug) => {
    if (!slug) return [];
    if (!srcBySlug.has(slug)) {
      let src = [];
      try {
        src = classifyBuffPage(await getPage("us", slug));
      } catch {}
      srcBySlug.set(slug, src);
    }
    return srcBySlug.get(slug);
  };

  // in-game description text lives in the hover popups: EN via the site's
  // /us/hover?s= endpoint, CN via the cache2 CDN URL embedded in the page
  const hoverDesc = (html) => {
    const $ = cheerio.load(html);
    return $(".secDescrText")
      .map((_, d) => cleanText($(d)))
      .get()
      .join("\n");
  };
  const safe = (s) => s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  const out = [];
  let i = 0;
  for (const b of en) {
    const c = findCn(b, i);
    let enDesc = "";
    let cnDesc = "";
    if (b.hover.startsWith("?")) {
      try {
        enDesc = hoverDesc(await getUrl(`https://poe2db.tw/us/hover${b.hover}`, `hover_us_${safe(b.id || b.slug)}.html`));
      } catch {}
    } else if (b.hover.startsWith("http")) {
      // some /us rows embed the resolved cache2 CDN hover URL directly
      try {
        enDesc = hoverDesc(await getUrl(b.hover, `hover_us_${safe(b.hover.split("/").pop())}.html`, { fast: true, headers: { Referer: "https://poe2db.tw/" } }));
      } catch {}
    }
    if (c?.hover.startsWith("http")) {
      try {
        cnDesc = hoverDesc(await getUrl(c.hover, `hover_cn_${safe(c.hover.split("/").pop())}.html`, { fast: true, headers: { Referer: "https://poe2db.tw/" } }));
      } catch {}
    }
    out.push({
      cat: "buff",
      key: `buff/${b.id || b.slug + "#" + i}`,
      icon: b.iconUrl,
      src: [
        ...new Set([
          ...(await buffSources(b.slug)),
          // the game's own naming marks monster buffs/auras in the internal id
          ...(monsterIds.has(b.id) || /(^|_)monster/.test(b.id) ? ["monsters"] : []),
        ]),
      ],
      en: { name: b.name, sub: [b.type, b.tail].filter(Boolean).join(" · "), desc: enDesc },
      cn: c
        ? { name: c.name, sub: [BUFF_TYPE_CN[c.type] ?? c.type, c.tail].filter(Boolean).join(" · "), desc: cnDesc }
        : null,
    });
    if (++i % 100 === 0) console.log(`  ${i}/${en.length} buff hovers/pages...`);
  }
  const withDesc = out.filter((e) => e.en.desc).length;
  console.log(`  buffs: ${out.length} (cn paired: ${out.filter((e) => e.cn).length}, with description: ${withDesc})`);
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

const questEntries = await scrapeQuests();
entries.push(...questEntries);
entries.push(...(await scrapeStoryRewards(questEntries)));
entries.push(...(await scrapeClasses()));
entries.push(...(await scrapeAtlasMasters()));
entries.push(...(await scrapeMaps()));
entries.push(...(await scrapeMapContents()));
entries.push(...(await scrapeBuffs()));
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
