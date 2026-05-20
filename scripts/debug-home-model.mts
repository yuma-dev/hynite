import { buildHomeModel } from "../packages/recommendations/src/index.js";

const model = await buildHomeModel([], fetch, undefined, {
  logger: (entry) => {
    if (entry.level !== "info") console.log(`[${entry.level}] ${entry.phase}: ${entry.message}`);
  }
});
console.log("\ntrendingRows:", model.trendingRows.map(r => `${r.id}(${r.games.length})`).join(", "));
