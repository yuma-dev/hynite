// Quick debug: run just the data fetching + row building without full enrichment
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// Replicate key logic from recommendations/src/index.ts inline
const TIMEOUT = 10_000;

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" } });
    return r;
  } finally {
    clearTimeout(t);
  }
}

console.log("\n=== storeFeatured ===");
try {
  const r = await fetchWithTimeout("https://store.steampowered.com/api/featured/?cc=DE&l=english", TIMEOUT);
  const j = await r.json();
  console.log("Status:", r.status);
  console.log("large_capsules:", j.large_capsules?.length ?? 0, "items");
  console.log("featured_win:", j.featured_win?.length ?? 0, "items");
  const withType0 = (j.featured_win ?? []).filter(i => i.type === 0 && i.id && i.name);
  console.log("featured_win type=0 with id+name:", withType0.length);
  if (withType0[0]) console.log("  first:", withType0[0].id, withType0[0].name);
} catch(e) { console.log("ERROR:", e.message); }

console.log("\n=== featuredCategories ===");
try {
  const r = await fetchWithTimeout("https://store.steampowered.com/api/featuredcategories/?cc=DE&l=english", TIMEOUT);
  const j = await r.json();
  console.log("Status:", r.status, "  top-level keys:", Object.keys(j).join(", "));

  for (const [key, cat] of Object.entries(j)) {
    if (!cat || typeof cat !== "object" || !("items" in cat) || !Array.isArray(cat.items)) continue;
    const catId = /^\d+$/.test(key) ? (cat.id ?? key) : key;
    const signal = catId.replace(/^cat_/, "");
    const validItems = cat.items.filter(i => i.type === 0 && i.id && i.name);
    console.log(`  key="${key}" → signal="${signal}"  total=${cat.items.length}  valid(type=0,id,name)=${validItems.length}`);
    if (validItems[0]) console.log(`    first: id=${validItems[0].id}, name=${validItems[0].name}, type=${validItems[0].type}`);
  }

  // Simulate what buildTrendRows does
  console.log("\n=== Simulated buildTrendRows filter ===");
  const candidates = [];
  for (const [key, cat] of Object.entries(j)) {
    if (!cat || typeof cat !== "object" || !("items" in cat) || !Array.isArray(cat.items)) continue;
    const catId = /^\d+$/.test(key) ? (cat.id ?? key) : key;
    const signal = catId.replace(/^cat_/, "");
    for (const item of cat.items) {
      if (item.type !== 0 || !item.id || !item.name) continue;
      candidates.push({ appid: String(item.id), title: item.name, sources: new Set([`featured:${signal}`]) });
    }
  }
  const checkRow = (label, ...sources) => {
    const matches = candidates.filter(c => sources.some(s => [...c.sources].some(src => src === s)));
    console.log(`  ${label}: ${matches.length} candidates  (sources checked: ${sources.join(", ")})`);
    if (matches[0]) console.log(`    first: ${matches[0].appid} "${matches[0].title}"  sources: ${[...matches[0].sources].join(",")}`);
  };
  checkRow("new-releases", "featured:new_releases", "featured:newreleases");
  checkRow("coming-soon", "featured:coming_soon", "featured:comingsoon");
  checkRow("top-sellers", "featured:top_sellers", "featured:topsellers");
  checkRow("specials", "featured:specials", "featured:dailydeal");
  checkRow("featured(storeFeat)", "store-featured:featured_win", "store-featured:large_capsules");
} catch(e) { console.log("ERROR:", e.message); }
