# PoE2 Codex · 中英对照

**Live site: <https://addohm.github.io/poe2-en-cn/>**

Chinese ⇄ English reference for Path of Exile 2, for playing on the CN
(Tencent) client without reading Chinese. Every entry pairs the *official*
localized text from both game clients — no machine translation.

## Contents

| Category | Source of node/entry list |
| --- | --- |
| Quests 任务 — all quests with step-by-step objectives, areas, rewards, by act | poe2db |
| Sekhemas Boons 恩赐 / Afflictions 厄难 / Pledges 誓约 / Rooms 房间 | poe2db |
| Chaos Trial 混沌试炼 — Trial of Chaos round modifiers | poe2db |
| Atlas Maps 异界地图 — all endgame map nodes with bosses, area modifiers, flavour text; plus unique maps, traders, hideouts, and atlas legend markers | poe2db `Waystones` page |
| Atlas Maps 舆图地图 — all endgame map nodes with bosses, modifiers, biomes, flavour text; unique maps, traders, hideouts, and legend markers | poe2db `Waystones` + per-map pages |
| Atlas Tree 舆图天赋 — core tree, plus each league mechanic sub-tree (Breach 裂隙, Delirium 惊悸迷雾, Ritual 驱灵祭坛, Expedition 先祖秘藏, Abyss 深渊, Incursion 穿越) as its own category | maxroll planner data |
| Atlas Tree Masters 异界大师 — Doryani's Science, Hilda's Hunting, Jado's Spycraft specialization nodes | poe2db `Atlas_Masters` page |
| Genesis Tree 创世天赋 | maxroll planner data |
| Passive Tree 天赋树 — keystones, notables, ascendancies (travel/attribute nodes excluded) | maxroll planner data |
| Buffs & Debuffs 增益减益 — every player/monster buff, debuff, flask effect, and charge with its status-bar icon and subtype (Aura, Curse, Mark, …) | poe2db `Buff` page |

Localized text and icons all come from [poe2db.tw](https://poe2db.tw)'s `/us`
and `/cn` pages, paired by language-independent keys (URL slugs, icon
filenames, step numbers). Icons are stored locally in the repo.

## Using the site

- Search accepts Chinese **or** English, matching names, descriptions, and
  quest steps. Press `/` to focus search.
- Grid view (icon gallery) is available for boons, afflictions, chaos
  modifiers, and tree categories — click a tile for full detail.
- The CN client runs an older patch than international; entries missing on the
  CN side are marked "国服暂无".

## Rebuilding data (after a patch)

```
npm install
npm run build
```

- `scrape.mjs` downloads poe2db pages (throttled, cached in `cache/`) plus
  maxroll's tree data, and writes `docs/data/reference.{js,json}`.
  Use `npm run scrape:fresh` to ignore the cache after a game patch.
- `icons.mjs` downloads all icons into `docs/assets/icons/` and rewrites the
  data to use local paths.
- The site itself is static: `docs/` is served by GitHub Pages, no framework,
  no build step.

## Adding a category

Most poe2db list pages share the same card markup. Add a `pairSections(...)`
call in [scrape.mjs](scrape.mjs) with the page slug and section header prefix,
then register the category in `NAV` in [docs/index.html](docs/index.html).
