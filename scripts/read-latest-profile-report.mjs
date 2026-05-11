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

  const freezes = report.freezes ?? [];
  if (freezes.length) {
    console.log("\nFreezes:");
    for (const freeze of freezes.slice(-10)) {
      console.log(`- ${freeze.process}: ${freeze.durationMs}ms at +${freeze.startedAtElapsedMs}ms, likely ${freeze.likelyCause?.category ?? "unknown"}`);
    }
  }
}
