import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

function candidatePaths() {
  const paths = [];
  if (process.env.HYNITE_PROFILE_RUNS_DIR) {
    paths.push(join(resolve(process.env.HYNITE_PROFILE_RUNS_DIR), "latest-report.json"));
  }
  if (process.env.HYNITE_USER_DATA) {
    paths.push(join(resolve(process.env.HYNITE_USER_DATA), "profile-runs", "latest-report.json"));
  }
  if (process.env.APPDATA) {
    paths.push(join(process.env.APPDATA, "Hynite", "profile-runs", "latest-report.json"));
    paths.push(join(process.env.APPDATA, "hynite", "profile-runs", "latest-report.json"));
  }
  if (process.env.LOCALAPPDATA) {
    paths.push(join(process.env.LOCALAPPDATA, "Hynite", "profile-runs", "latest-report.json"));
    paths.push(join(process.env.LOCALAPPDATA, "hynite", "profile-runs", "latest-report.json"));
  }
  paths.push(join(process.cwd(), "profile-runs", "latest-report.json"));
  return [...new Set(paths)];
}

function readReport() {
  for (const path of candidatePaths()) {
    if (!existsSync(path)) continue;
    return { path, report: JSON.parse(readFileSync(path, "utf8")) };
  }
  return undefined;
}

function line(label, value) {
  console.log(`${label}: ${value}`);
}

const found = readReport();
if (!found) {
  console.error("No latest profile report found. Run `npm run dev:profile` first, or set HYNITE_USER_DATA / HYNITE_PROFILE_RUNS_DIR.");
  process.exitCode = 1;
} else {
  const { path, report } = found;
  const summary = report.summary ?? {};
  line("Report", path);
  line("Session", report.session?.id ?? "unknown");
  line("Duration", `${summary.durationMs ?? 0}ms`);
  line("Main freezes", `${summary.totalMainFreezeMs ?? 0}ms total, max ${summary.maxMainFreezeMs ?? 0}ms`);
  line("Renderer freezes", `${summary.totalRendererFreezeMs ?? 0}ms total, max ${summary.maxRendererFreezeMs ?? 0}ms`);
  line("Dropped frames", `${summary.totalDroppedFrames ?? 0} total, worst ${summary.worstFrameMs ?? 0}ms`);
  line("Dropped events", report.raw?.droppedEventCount ?? 0);

  const topCategories = summary.topCategories ?? [];
  if (topCategories.length) {
    console.log("\nTop categories:");
    for (const entry of topCategories.slice(0, 8)) {
      console.log(`- ${entry.category}: ${entry.durationMs}ms, count ${entry.count}, p95 ${entry.p95Ms}ms`);
    }
  }

  const slowest = summary.slowestSpans ?? [];
  if (slowest.length) {
    console.log("\nSlowest spans:");
    for (const span of slowest.slice(0, 10)) {
      console.log(`- ${span.category}/${span.name}: ${span.durationMs}ms (${span.process})`);
    }
  }

  const detailOpen = report.detailOpen;
  if (detailOpen?.opens?.count) {
    console.log("\nDetail opens:");
    console.log(`- Opens: count ${detailOpen.opens.count}, p95 ${detailOpen.opens.p95Ms}ms, max ${detailOpen.opens.maxMs}ms`);
    console.log(`- games:get IPC: count ${detailOpen.ipcGamesGet?.count ?? 0}, p95 ${detailOpen.ipcGamesGet?.p95Ms ?? 0}ms, max ${detailOpen.ipcGamesGet?.maxMs ?? 0}ms`);
    console.log(`- DB read: p95 ${detailOpen.dbRead?.p95Ms ?? 0}ms, max ${detailOpen.dbRead?.maxMs ?? 0}ms`);
    console.log(`- Source matches: p95 ${detailOpen.sourceMatches?.p95Ms ?? 0}ms, max ${detailOpen.sourceMatches?.maxMs ?? 0}ms`);
    console.log(`- Raw cache lookup: p95 ${detailOpen.rawCacheLookup?.p95Ms ?? 0}ms, max ${detailOpen.rawCacheLookup?.maxMs ?? 0}ms`);
    console.log(`- Steam detail fetch: count ${detailOpen.steamFetch?.count ?? 0}, p95 ${detailOpen.steamFetch?.p95Ms ?? 0}ms, max ${detailOpen.steamFetch?.maxMs ?? 0}ms`);
    console.log(`- Metadata asset cache: p95 ${detailOpen.metadataAssetCache?.p95Ms ?? 0}ms, max ${detailOpen.metadataAssetCache?.maxMs ?? 0}ms`);
    const slowestGames = detailOpen.slowestGames ?? [];
    if (slowestGames.length) {
      console.log("- Slowest games:");
      for (const game of slowestGames.slice(0, 5)) {
        console.log(`  - ${game.title ?? game.gameId}: ${game.totalMs}ms (${game.source ?? "unknown"})`);
      }
    }
  }

  const runtimeFrames = report.runtimeFrames;
  if (runtimeFrames?.frameDrops?.totalEvents) {
    console.log("\nRuntime frames:");
    console.log(`- Frame-drop events: ${runtimeFrames.frameDrops.totalEvents}, dropped ${runtimeFrames.frameDrops.totalDroppedFrames}, worst ${runtimeFrames.frameDrops.worstFrameMs}ms`);
    const byInteraction = runtimeFrames.frameDrops.byInteraction ?? {};
    const interactionRows = Object.entries(byInteraction)
      .map(([name, stats]) => ({ name, droppedFrames: stats.droppedFrames ?? 0, p95Ms: stats.p95Ms ?? 0, maxMs: stats.maxMs ?? 0 }))
      .sort((a, b) => b.droppedFrames - a.droppedFrames)
      .slice(0, 6);
    if (interactionRows.length) {
      console.log("- By interaction:");
      for (const row of interactionRows) {
        console.log(`  - ${row.name}: dropped ${row.droppedFrames}, p95 ${row.p95Ms}ms, max ${row.maxMs}ms`);
      }
    }
    const reactRows = runtimeFrames.reactCommits?.slowest ?? [];
    if (reactRows.length) {
      console.log("- Slow React commits:");
      for (const row of reactRows.slice(0, 5)) {
        console.log(`  - ${row.label}: ${row.durationMs}ms`);
      }
    }
  }

  const freezes = report.freezes ?? [];
  if (freezes.length) {
    console.log("\nFreezes:");
    for (const freeze of freezes.slice(-10)) {
      console.log(`- ${freeze.process}: ${freeze.durationMs}ms at +${freeze.startedAtElapsedMs}ms, likely ${freeze.likelyCause?.category ?? "unknown"}`);
    }
  }
}
