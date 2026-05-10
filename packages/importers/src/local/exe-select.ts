import { basename, dirname, sep } from "node:path";
import type { ExeFileInfo, ExeSelection, LocalGameCandidate, SiblingMarkers } from "./types";

const PREFERRED_PATH_SEGMENTS = [/\\bin\\x64\\?/i, /\\bin\\?/i, /\\binaries\\win64\\?/i, /\\binaries\\?/i, /\\x64\\?/i];
const LAUNCHER_HINT_PATTERNS = [/launcher/i, /^start[_-]?/i];

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/\.exe$/i, "")
    .split(/[\s\-_.()]+/)
    .filter((token) => token.length > 0);
}

function tokenSimilarity(a: string, b: string): number {
  const aTokens = new Set(tokenize(a));
  const bTokens = new Set(tokenize(b));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) intersection += 1;
  }
  return intersection / Math.max(aTokens.size, bTokens.size);
}

export function scoreExe(
  exe: ExeFileInfo,
  candidate: LocalGameCandidate
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  const exeName = basename(exe.path);
  const filenameSim = tokenSimilarity(exeName, candidate.folderName);
  if (filenameSim > 0) {
    const points = Math.round(filenameSim * 40);
    score += points;
    reasons.push(`folder-name match: +${points} (sim=${filenameSim.toFixed(2)})`);
  }

  if (exe.productName) {
    const productSim = tokenSimilarity(exe.productName, candidate.folderName);
    if (productSim > 0) {
      const points = Math.round(productSim * 25);
      score += points;
      reasons.push(`PE ProductName match: +${points} (sim=${productSim.toFixed(2)})`);
    } else {
      score += 5;
      reasons.push("has PE ProductName: +5");
    }
  }

  // Size: 5MB → +5, 50MB+ → +15. Tiny exes penalised.
  const sizeMb = exe.size / (1024 * 1024);
  if (sizeMb >= 50) {
    score += 15;
    reasons.push(`size ${sizeMb.toFixed(0)}MB: +15`);
  } else if (sizeMb >= 5) {
    score += 8;
    reasons.push(`size ${sizeMb.toFixed(0)}MB: +8`);
  } else if (sizeMb < 1) {
    score -= 10;
    reasons.push(`tiny exe ${sizeMb.toFixed(2)}MB: -10`);
  }

  // Path location preference.
  const relativeDir = dirname(exe.path).slice(candidate.folderPath.length).toLowerCase();
  const isInRoot = relativeDir === "" || relativeDir === sep.toLowerCase();
  if (isInRoot) {
    score += 10;
    reasons.push("in root folder: +10");
  } else if (PREFERRED_PATH_SEGMENTS.some((pattern) => pattern.test(relativeDir))) {
    score += 8;
    reasons.push("in Bin/x64 path: +8");
  } else {
    // Deep nesting penalty.
    const depth = relativeDir.split(sep).filter(Boolean).length;
    if (depth >= 3) {
      score -= 5;
      reasons.push(`deeply nested (${depth}): -5`);
    }
  }

  // Steam appid.txt sibling: very strong signal if it's right next to this exe.
  if (candidate.siblingMarkers.steamAppidTxt) {
    const appidDir = dirname(candidate.siblingMarkers.steamAppidTxt.path);
    if (appidDir.toLowerCase() === dirname(exe.path).toLowerCase()) {
      score += 30;
      reasons.push("steam_appid.txt sibling: +30");
    }
  }

  // steam_api(64).dll sibling: confirms a Steam-built game exe.
  if (candidate.siblingMarkers.steamApi64Dll) {
    const dllDir = dirname(candidate.siblingMarkers.steamApi64Dll);
    if (dllDir.toLowerCase() === dirname(exe.path).toLowerCase()) {
      score += 15;
      reasons.push("steam_api dll sibling: +15");
    }
  }

  // Launcher hint — small bump (we'd often prefer the launcher when present).
  if (LAUNCHER_HINT_PATTERNS.some((pattern) => pattern.test(exeName))) {
    score += 3;
    reasons.push("launcher-name hint: +3");
  }

  return { score, reasons };
}

export function selectExe(
  candidate: LocalGameCandidate,
  exeInfos: ExeFileInfo[]
): ExeSelection | undefined {
  if (exeInfos.length === 0) return undefined;

  const scored = exeInfos
    .map((exe) => ({ exe, ...scoreExe(exe, candidate) }))
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top) return undefined;
  const runnerUp = scored[1];

  let ambiguous = false;
  if (runnerUp && top.score > 0) {
    const gapPct = (top.score - runnerUp.score) / top.score;
    if (gapPct < 0.15 || top.score - runnerUp.score < 8) {
      ambiguous = true;
    }
  }

  return {
    chosen: top.exe,
    score: top.score,
    ambiguous,
    runnerUp: runnerUp ? { exe: runnerUp.exe, score: runnerUp.score } : undefined,
    scored
  };
}

export type { SiblingMarkers };
