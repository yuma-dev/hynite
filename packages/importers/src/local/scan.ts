import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { LocalGameCandidate, LocalRootConfig, LocalScanConfig, SiblingMarkers } from "./types";

const HARD_EXCLUDED_EXE_PATTERNS: RegExp[] = [
  /^unins/i,
  /uninstall/i,
  /^setup/i,
  /^install/i,
  /redist/i,
  /^vcredist/i,
  /^dotnetfx/i,
  /^dxsetup/i,
  /^oalinst/i,
  /crashhandler/i,
  /crashreport/i,
  /^unitycrashhandler/i,
  /^eaanticheat/i,
  /^easyanticheat/i,
  /^beservice/i,
  /^battleye/i,
  /_be\.exe$/i,
  /^dxwebsetup/i,
  /^nvngx/i,
  /^amdrsserv/i,
  /datareporter/i,
  /^profilemanager/i
];

const MAX_EXES_PER_CANDIDATE = 64;
const MAX_RECURSE_DEPTH = 4;
const LAUNCHABLE_EXTENSIONS = [".exe", ".com", ".bat", ".cmd", ".lnk", ".url"];

export function hashFolderPath(folderPath: string): string {
  return createHash("sha1").update(folderPath.toLowerCase()).digest("hex").slice(0, 16);
}

export function shouldSkipFolder(folderName: string, excludePatterns: string[]): boolean {
  if (folderName.startsWith(".")) return true;
  for (const pattern of excludePatterns) {
    try {
      if (new RegExp(pattern, "i").test(folderName)) return true;
    } catch {
      // ignore invalid user patterns
    }
  }
  return false;
}

function isExcludedExeName(name: string): boolean {
  return HARD_EXCLUDED_EXE_PATTERNS.some((pattern) => pattern.test(name));
}

async function listExesRecursive(dir: string, depthLeft: number, out: string[]): Promise<void> {
  if (depthLeft < 0 || out.length >= MAX_EXES_PER_CANDIDATE) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_EXES_PER_CANDIDATE) return;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await listExesRecursive(full, depthLeft - 1, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".exe")) {
      if (!isExcludedExeName(entry.name)) {
        out.push(full);
      }
    }
  }
}

async function detectSiblingMarkers(folderPath: string): Promise<SiblingMarkers> {
  const markers: SiblingMarkers = {};
  const seen = new Set<string>();

  async function walk(dir: string, depthLeft: number): Promise<void> {
    if (depthLeft < 0) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const lower = entry.name.toLowerCase();
      const full = join(dir, entry.name);
      if (entry.isFile()) {
        if (lower === "steam_appid.txt" && !markers.steamAppidTxt) {
          try {
            const content = (await readFile(full, "utf8")).trim();
            const appid = content.match(/^\d+/)?.[0];
            if (appid) markers.steamAppidTxt = { path: full, appid };
          } catch {
            // ignore
          }
        } else if (lower.startsWith("goggame-") && lower.endsWith(".info")) {
          try {
            const json = JSON.parse(await readFile(full, "utf8")) as { gameId?: string | number };
            const gameId = json.gameId ? String(json.gameId) : undefined;
            if (gameId) {
              markers.gogManifests = markers.gogManifests ?? [];
              markers.gogManifests.push({ path: full, gameId });
            }
          } catch {
            // ignore
          }
        } else if (lower === "steam_api64.dll" || lower === "steam_api.dll") {
          markers.steamApi64Dll = full;
        } else if (lower === "steam_emu.ini") {
          markers.steamEmuIni = full;
        } else if (/^appmanifest_(\d+)\.acf$/i.test(entry.name)) {
          const m = entry.name.match(/^appmanifest_(\d+)\.acf$/i);
          if (m && !markers.steamAppManifestAppid) {
            markers.steamAppManifestAppid = m[1];
          }
        }
      } else if (entry.isDirectory()) {
        if (seen.has(full)) continue;
        seen.add(full);
        // Only descend a couple levels for marker detection
        await walk(full, depthLeft - 1);
      }
    }
  }

  await walk(folderPath, 2);
  return markers;
}

/**
 * Build a LocalGameCandidate for a single folder (treating that folder itself as the game).
 * Used by the "add a single game" flow — bypasses the root/subfolder enumeration.
 */
export async function buildSingleCandidate(folderPath: string): Promise<LocalGameCandidate | undefined> {
  const resolved = resolve(folderPath);
  const exes: string[] = [];
  await listExesRecursive(resolved, MAX_RECURSE_DEPTH, exes);
  if (exes.length === 0) return undefined;
  const stats = await stat(resolved).catch(() => undefined);
  const markers = await detectSiblingMarkers(resolved);
  return {
    id: hashFolderPath(resolved),
    folderPath: resolved,
    folderName: basename(resolved),
    exeFiles: exes,
    siblingMarkers: markers,
    mtimeMs: stats?.mtimeMs ?? 0
  };
}

/**
 * Build a candidate around a specific user-picked launcher file (.exe, .lnk, .url, .bat, .cmd).
 * Used when the user picks an exact file in the Add Game dialog — bypasses scanning so
 * shortcuts on Desktop / one-off launchers work even when the parent folder has no other exes.
 */
export async function buildSingleCandidateForFile(filePath: string): Promise<LocalGameCandidate> {
  const resolved = resolve(filePath);
  const folderPath = resolve(resolved, "..");
  const stats = await stat(folderPath).catch(() => undefined);
  // Best-effort sibling-marker detection in the parent dir (steam_appid.txt etc.)
  const markers = await detectSiblingMarkers(folderPath).catch(() => ({}));
  // Use the file's basename (without extension) as the candidate's folder name so
  // identification gets a useful query when picking a Desktop shortcut.
  const fileBase = basename(resolved).replace(/\.(exe|com|bat|cmd|lnk|url)$/i, "");
  return {
    id: hashFolderPath(resolved),
    folderPath,
    folderName: fileBase || basename(folderPath),
    exeFiles: [resolved],
    siblingMarkers: markers,
    mtimeMs: stats?.mtimeMs ?? 0
  };
}

export async function scanLocalRoots(config: LocalScanConfig): Promise<LocalGameCandidate[]> {
  const candidates: LocalGameCandidate[] = [];
  const visited = new Set<string>();
  const ignored = new Set((config.ignoredPaths ?? []).map((path) => resolve(path).toLowerCase()));

  for (const root of config.roots) {
    await scanRoot(root, config.excludePatterns, candidates, visited, ignored);
  }

  return candidates;
}

async function scanRoot(
  root: LocalRootConfig,
  excludePatterns: string[],
  out: LocalGameCandidate[],
  visited: Set<string>,
  ignored: Set<string>
): Promise<void> {
  const rootPath = resolve(root.path);
  // Honour explicit depth if set (1-3), else default to 3.
  const depth = Math.min(Math.max(root.depth ?? 3, 1), 3);
  await enumerateCandidates(rootPath, depth, excludePatterns, out, visited, ignored);
}

async function enumerateCandidates(
  dir: string,
  depthLeft: number,
  excludePatterns: string[],
  out: LocalGameCandidate[],
  visited: Set<string>,
  ignored: Set<string>
): Promise<void> {
  if (depthLeft <= 0) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (shouldSkipFolder(entry.name, excludePatterns)) continue;
    const folderPath = join(dir, entry.name);
    const key = folderPath.toLowerCase();
    if (visited.has(key)) continue;
    if (ignored.has(key)) continue;

    const exes: string[] = [];
    await listExesRecursive(folderPath, MAX_RECURSE_DEPTH, exes);

    if (exes.length === 0) {
      // No exes here — descend if we still have depth budget.
      if (depthLeft > 1) {
        await enumerateCandidates(folderPath, depthLeft - 1, excludePatterns, out, visited, ignored);
      }
      continue;
    }

    visited.add(key);
    const stats = await stat(folderPath).catch(() => undefined);
    const markers = await detectSiblingMarkers(folderPath);

    out.push({
      id: hashFolderPath(folderPath),
      folderPath,
      folderName: basename(folderPath),
      exeFiles: exes,
      siblingMarkers: markers,
      mtimeMs: stats?.mtimeMs ?? 0
    });
  }
}
