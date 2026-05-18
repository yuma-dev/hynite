import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  buildSingleCandidate,
  buildSingleCandidateForFile,
  identifyCandidate,
  LocalImporterProvider,
  selectExe,
  type ExeFileInfo,
  type IdentifyCandidate,
  type IdentifyResult,
  type LocalGameCandidate,
  type LocalScanCache,
  type LocalScanCacheEntry,
  type LocalScanIssue,
  type SteamSearchProvider,
  type IgdbSearchProvider,
  type IgdbExternalLookup
} from "@hynite/importers";
import {
  IGDB_EXTERNAL_CATEGORY,
  buildIgdbImageUrl,
  IgdbClient,
  mapIgdbGameToPatch,
  refreshFusedMetadata,
  type IgdbGame,
  type MetadataLogger
} from "@hynite/metadata";
import type { GameMetadataPatch, ImportedGame } from "@hynite/core";
import type { HyniteRepository } from "@hynite/db";
import type { NativeBridge } from "./nativeBridge";

export type LocalImportLogger = (level: "info" | "warning" | "error", message: string, details?: Record<string, unknown>) => void;

const LOCAL_IMPORT_YIELD_INTERVAL = 10;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function localMetadataPatch(patch: GameMetadataPatch): GameMetadataPatch {
  const { title: _title, sortTitle: _sortTitle, ...rest } = patch;
  return rest;
}

function normalizePathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function trimPathSeparators(path: string): string {
  return normalizePathKey(path.replace(/[\\/]+$/, ""));
}

function isPathUnderFolder(path: string, folder: string): boolean {
  const normalizedPath = trimPathSeparators(path);
  const normalizedFolder = trimPathSeparators(folder);
  return normalizedPath === normalizedFolder || normalizedPath.startsWith(`${normalizedFolder}\\`) || normalizedPath.startsWith(`${normalizedFolder}/`);
}

async function existingRootPaths(roots: Array<{ path: string }>): Promise<string[]> {
  const checked = await Promise.all(
    roots.map(async (root) => {
      try {
        const stats = await stat(root.path);
        return stats.isDirectory() ? root.path : undefined;
      } catch {
        return undefined;
      }
    })
  );
  return checked.filter((path): path is string => Boolean(path));
}

function exeSignature(candidate: Pick<LocalGameCandidate, "exeFiles">): string {
  return candidate.exeFiles
    .map((path) => normalizePathKey(path))
    .sort()
    .join("\n");
}

function cacheEntryForCandidate(candidate: LocalGameCandidate): LocalScanCacheEntry {
  return {
    folderPath: candidate.folderPath,
    mtimeMs: candidate.mtimeMs,
    candidateId: candidate.id,
    exeSignature: exeSignature(candidate)
  };
}

function cacheEntryMatchesCandidate(entry: LocalScanCacheEntry | undefined, candidate: LocalGameCandidate): boolean {
  if (!entry?.exeSignature) {
    return false;
  }
  return entry.candidateId === candidate.id &&
    normalizePathKey(entry.folderPath) === normalizePathKey(candidate.folderPath) &&
    Math.abs(entry.mtimeMs - candidate.mtimeMs) < 1 &&
    entry.exeSignature === exeSignature(candidate);
}

function summarizeIssues(issues: LocalScanIssue[]): Record<string, unknown> {
  const byReason = issues.reduce<Record<string, number>>((counts, issue) => {
    counts[issue.reason] = (counts[issue.reason] ?? 0) + 1;
    return counts;
  }, {});
  return {
    total: issues.length,
    byReason,
    sample: issues.slice(0, 20).map((issue) => ({
      candidateId: issue.candidateId,
      reason: issue.reason,
      folderPath: issue.folderPath,
      folderName: issue.folderName
    }))
  };
}

export type LocalImportRunOptions = {
  roots: Array<{ path: string; depth: number }>;
  excludePatterns: string[];
  ignoredPaths?: string[];
  igdbAuth?: { clientId: string; clientSecret: string };
  steamGridDbApiKey?: string;
  steamAppInfoProvider?: (game: ImportedGame) => Promise<GameMetadataPatch | undefined>;
  metadataLogger?: MetadataLogger;
  signal?: AbortSignal;
  /** Forces metadata refresh even when the cache is hit. */
  refreshMetadata?: boolean;
  /** Skip unchanged cached candidates before PE metadata, identification, DB writes, and metadata refresh. */
  skipUnchanged?: boolean;
  log?: LocalImportLogger;
  searchSteamStore?: (query: string) => Promise<IdentifyCandidate[]>;
};

export type LocalImportResult = {
  scanned: number;
  skipped: number;
  imported: number;
  matched: number;
  ambiguous: number;
  unmatched: number;
  issues: LocalScanIssue[];
};

type PersistentLocalScanCache = LocalScanCache & {
  issues?: Record<string, LocalScanIssue>;
};

export class LocalImportService {
  private cache?: PersistentLocalScanCache;

  constructor(
    private readonly cachePath: string,
    private readonly repository: HyniteRepository,
    private readonly nativeBridge: NativeBridge,
    private readonly logger?: LocalImportLogger
  ) {}

  private log(level: "info" | "warning" | "error", message: string, details?: Record<string, unknown>): void {
    this.logger?.(level, message, details);
  }

  async loadCache(): Promise<PersistentLocalScanCache> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.cachePath, "utf8");
      const parsed = JSON.parse(raw) as PersistentLocalScanCache;
      this.cache = {
        entries: parsed.entries && typeof parsed.entries === "object" ? parsed.entries : {},
        issues: parsed.issues && typeof parsed.issues === "object" ? parsed.issues : {}
      };
      this.log("info", "Local scan cache loaded", {
        entryCount: Object.keys(this.cache.entries).length,
        issues: summarizeIssues(Object.values(this.cache.issues ?? {}))
      });
    } catch (error) {
      this.cache = { entries: {}, issues: {} };
      const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined;
      this.log(
        code === "ENOENT" ? "info" : "warning",
        code === "ENOENT" ? "Local scan cache missing; initialized empty" : "Local scan cache failed to load; initialized empty",
        {
          code,
          error: errorMessage(error)
        }
      );
    }
    return this.cache;
  }

  private async saveCache(): Promise<void> {
    if (!this.cache) return;
    await mkdir(dirname(this.cachePath), { recursive: true });
    await writeFile(this.cachePath, JSON.stringify(this.cache, null, 2));
    this.log("info", "Local scan cache saved", {
      entryCount: Object.keys(this.cache.entries).length,
      issues: summarizeIssues(Object.values(this.cache.issues ?? {}))
    });
  }

  /** Last completed scan report (issues, ambiguous candidates, matches). */
  lastReport?: LocalImporterProvider["lastReport"];

  async getIssues(ignoredPaths: string[] = []): Promise<LocalScanIssue[]> {
    const issues = Object.values((await this.loadCache()).issues ?? {});
    const ignored = new Set(ignoredPaths.map((path) => normalizePathKey(path)));
    const returned = issues.filter((issue) => !ignored.has(normalizePathKey(issue.folderPath)));
    this.log("info", "Local scan issues read", {
      ignoredPathCount: ignoredPaths.length,
      cached: summarizeIssues(issues),
      returned: summarizeIssues(returned)
    });
    return returned;
  }

  async clearIssue(candidateId: string, folderPath?: string): Promise<void> {
    const cache = await this.loadCache();
    const before = Object.values(cache.issues ?? {});
    delete cache.issues?.[candidateId];
    if (folderPath) {
      const normalizedFolderPath = normalizePathKey(folderPath);
      for (const [key, issue] of Object.entries(cache.issues ?? {})) {
        if (normalizePathKey(issue.folderPath) === normalizedFolderPath) {
          delete cache.issues?.[key];
        }
      }
    }
    if (this.lastReport) {
      this.lastReport.issues = this.lastReport.issues.filter((issue) => {
        if (issue.candidateId === candidateId) return false;
        return folderPath ? normalizePathKey(issue.folderPath) !== normalizePathKey(folderPath) : true;
      });
    }
    const after = Object.values(cache.issues ?? {});
    const removed = before.filter((issue) => {
      if (issue.candidateId === candidateId) return true;
      return folderPath ? normalizePathKey(issue.folderPath) === normalizePathKey(folderPath) : false;
    });
    this.log("info", "Local scan issue clear requested", {
      candidateId,
      folderPath,
      beforeCount: before.length,
      removed: summarizeIssues(removed),
      afterCount: after.length
    });
    await this.saveCache();
  }

  async run(options: LocalImportRunOptions): Promise<LocalImportResult> {
    const cache = await this.loadCache();

    const igdbClient = options.igdbAuth ? new IgdbClient(options.igdbAuth) : undefined;

    const peMetadataLookup = async (paths: string[]): Promise<ExeFileInfo[]> => {
      const infos = await this.nativeBridge.getFileVersionInfo(paths);
      return infos.map((info) => ({
        path: info.path,
        size: info.size ?? 0,
        productName: info.productName ?? undefined,
        fileDescription: info.fileDescription ?? undefined,
        companyName: info.companyName ?? undefined
      }));
    };

    const steamSearch: SteamSearchProvider | undefined = options.searchSteamStore;

    const igdbSearch: IgdbSearchProvider | undefined = igdbClient
      ? async (query) => {
          try {
            const results = await igdbClient.searchGames(query, 6);
            return results.map(igdbGameToCandidate);
          } catch (error) {
            options.log?.("warning", "IGDB search failed", { query, error: errorMessage(error) });
            return [];
          }
        }
      : undefined;

    const igdbExternalLookup: IgdbExternalLookup | undefined = igdbClient
      ? async (externalId, category) => {
          try {
            const game = await igdbClient.lookupByExternal(externalId, IGDB_EXTERNAL_CATEGORY[category]);
            return game ? igdbGameToCandidate(game) : undefined;
          } catch (error) {
            options.log?.("warning", "IGDB external lookup failed", {
              externalId,
              category,
              error: errorMessage(error)
            });
            return undefined;
          }
        }
      : undefined;

    const provider = new LocalImporterProvider({
      scanConfig: {
        roots: options.roots,
        excludePatterns: options.excludePatterns,
        ignoredPaths: options.ignoredPaths
      },
      peMetadataLookup,
      identify: { steamSearch, igdbSearch, igdbExternalLookup },
      shouldSkipCandidate: options.skipUnchanged
        ? (candidate) => cacheEntryMatchesCandidate(cache.entries[candidate.id], candidate)
        : undefined,
      refreshMetadata: async (game) => {
        const match = provider.lastReport?.matches.get(game.externalId);
        if (match?.provider === "steam") {
          // Use full metadata mode so descriptions, genres, and tags are pulled from Steam Store.
          const fusionGame: ImportedGame = { ...game, provider: "steam", externalId: match.externalId };
          return refreshFusedMetadata(fusionGame, {
            steamGridDbApiKey: options.steamGridDbApiKey,
            logger: options.metadataLogger,
            steamAppInfoProvider: options.steamAppInfoProvider,
            mode: "full"
          });
        }
        if (match?.provider === "igdb" && igdbClient) {
          const igdbGame = await igdbClient.getGame(Number(match.externalId));
          if (igdbGame) return mapIgdbGameToPatch(igdbGame);
        }
        return { metadataStatus: "partial" };
      }
    });

    options.log?.("info", "Local scan starting", {
      rootCount: options.roots.length,
      roots: options.roots.map((root) => root.path),
      ignoredPathCount: options.ignoredPaths?.length ?? 0,
      hasIgdb: Boolean(igdbClient),
      skipUnchanged: Boolean(options.skipUnchanged),
      refreshMetadata: options.refreshMetadata !== false
    });

    const imported = await provider.scan();
    options.signal?.throwIfAborted();
    this.lastReport = provider.lastReport;

    let matched = 0;
    let upserted = 0;
    for (let index = 0; index < imported.length; index += 1) {
      const game = imported[index]!;
      if (index > 0 && index % LOCAL_IMPORT_YIELD_INTERVAL === 0) {
        await yieldToEventLoop();
      }
      options.signal?.throwIfAborted();
      const persisted = this.repository.upsertImportedGame(game);
      upserted += 1;
      const candidateId = game.externalId;
      const match = provider.lastReport?.matches.get(candidateId);
      if (match) matched += 1;

      // If we matched against Steam/IGDB, attach the secondary source ONLY (no duplicate game row).
      if (match) {
        try {
          this.repository.attachSecondarySource({
            gameId: persisted.id,
            provider: match.provider,
            externalId: match.externalId
          });
        } catch (error) {
          options.log?.("warning", "Failed to attach matched source", {
            candidateId,
            match,
            error: errorMessage(error)
          });
        }
      }

      // Refresh metadata for the local entry using the matched provider.
      if (options.refreshMetadata !== false) {
        try {
          const patch = await provider.refreshMetadata(game);
          if (patch && Object.keys(patch).length > 0) {
            this.repository.applyMetadata(persisted.id, localMetadataPatch(patch));
          }
        } catch (error) {
          options.log?.("warning", "Local metadata refresh failed", {
            candidateId,
            match,
            error: errorMessage(error)
          });
        }
      }

      const candidate = provider.lastReport?.candidates.get(candidateId);
      if (candidate) {
        cache.entries[candidateId] = cacheEntryForCandidate(candidate);
      }
    }

    const issues = provider.lastReport?.issues ?? [];
    const availableRoots = await existingRootPaths(options.roots);
    const previousIssues = Object.values(cache.issues ?? {});
    const retainedOutsideAvailableRoots = previousIssues.filter((issue) => !availableRoots.some((root) => isPathUnderFolder(issue.folderPath, root)));
    const skippedCandidates = provider.lastReport?.skippedCandidates ?? new Map<string, LocalGameCandidate>();
    const retainedSkippedIssues = options.skipUnchanged
      ? previousIssues.filter((issue) => skippedCandidates.has(issue.candidateId))
      : [];
    const retainedIssueKeys = new Set<string>();
    const retainedIssues = [...retainedOutsideAvailableRoots, ...retainedSkippedIssues].filter((issue) => {
      const key = `${issue.candidateId}\u0000${issue.reason}\u0000${normalizePathKey(issue.folderPath)}`;
      if (retainedIssueKeys.has(key)) return false;
      retainedIssueKeys.add(key);
      return true;
    });
    cache.issues = Object.fromEntries([...retainedIssues, ...issues].map((issue) => [issue.candidateId, issue]));
    options.log?.("info", "Local scan issue cache updated", {
      requestedRootCount: options.roots.length,
      availableRootCount: availableRoots.length,
      availableRoots,
      previous: summarizeIssues(previousIssues),
      retainedOutsideAvailableRoots: summarizeIssues(retainedOutsideAvailableRoots),
      retainedSkipped: summarizeIssues(retainedSkippedIssues),
      retained: summarizeIssues(retainedIssues),
      scanIssues: summarizeIssues(issues),
      persisted: summarizeIssues(Object.values(cache.issues ?? {}))
    });
    await this.saveCache();
    const skipped = provider.lastReport?.skipped ?? 0;
    const ambiguous = issues.filter((issue) => issue.reason === "ambiguous_match" || issue.reason === "ambiguous_exe").length;
    const unmatched = issues.filter((issue) => issue.reason === "unmatched").length;

    options.log?.("info", "Local scan complete", {
      scanned: imported.length + skipped,
      skipped,
      matched,
      ambiguous,
      unmatched,
      upserted
    });

    return {
      scanned: imported.length + skipped,
      skipped,
      imported: upserted,
      matched,
      ambiguous,
      unmatched,
      issues
    };
  }

  /**
   * Probe a folder or exe — returns candidate info, top exe candidates with PE metadata,
   * and combined Steam + IGDB search candidates. Performs NO upsert; used by the multi-step
   * Add Game modal to show the user what will happen before they confirm.
   */
  async probe(
    args: { folderPath?: string; executablePath?: string },
    options: Pick<LocalImportRunOptions, "igdbAuth" | "searchSteamStore" | "log">
  ): Promise<{
    folderPath: string;
    folderName: string;
    candidateId: string;
    exeOptions: Array<ExeFileInfo & { score: number; reasons: string[]; chosen: boolean }>;
    chosenExe: string;
    identification: IdentifyResult;
  }> {
    const folderPath = args.folderPath ?? (args.executablePath ? dirname(args.executablePath) : undefined);
    if (!folderPath) throw new Error("probe requires folderPath or executablePath.");
    const candidate = args.executablePath
      ? await buildSingleCandidateForFile(args.executablePath)
      : (await buildSingleCandidate(folderPath)) ??
        (() => { throw new Error(`No executables found under ${folderPath}.`); })();

    const peInfos = await this.nativeBridge.getFileVersionInfo(candidate.exeFiles);
    const exeInfos: ExeFileInfo[] = candidate.exeFiles.map((path) => {
      const info = peInfos.find((entry) => entry.path === path);
      return {
        path,
        size: info?.size ?? 0,
        productName: info?.productName ?? undefined,
        fileDescription: info?.fileDescription ?? undefined,
        companyName: info?.companyName ?? undefined
      };
    });

    let chosenExe: ExeFileInfo;
    let scoredOptions: Array<ExeFileInfo & { score: number; reasons: string[]; chosen: boolean }>;
    if (args.executablePath) {
      const matched = exeInfos.find((info) => info.path.toLowerCase() === args.executablePath!.toLowerCase());
      chosenExe = matched ?? {
        path: args.executablePath,
        size: 0,
        productName: undefined,
        fileDescription: undefined,
        companyName: undefined
      };
      scoredOptions = exeInfos.map((info) => ({ ...info, score: 0, reasons: [], chosen: info.path === chosenExe.path }));
    } else {
      const selection = selectExe(candidate, exeInfos);
      if (!selection) throw new Error(`Could not pick an executable in ${folderPath}.`);
      chosenExe = selection.chosen;
      scoredOptions = selection.scored.map((entry) => ({
        ...entry.exe,
        score: entry.score,
        reasons: entry.reasons,
        chosen: entry.exe.path === selection.chosen.path
      }));
    }

    const igdbClient = options.igdbAuth ? new IgdbClient(options.igdbAuth) : undefined;
    const igdbSearch: IgdbSearchProvider | undefined = igdbClient
      ? async (query) => {
          try {
            const results = await igdbClient.searchGames(query, 6);
            return results.map(igdbGameToCandidate);
          } catch (error) {
            options.log?.("warning", "IGDB search failed", { query, error: errorMessage(error) });
            return [];
          }
        }
      : undefined;
    const igdbExternalLookup: IgdbExternalLookup | undefined = igdbClient
      ? async (externalId, category) => {
          try {
            const game = await igdbClient.lookupByExternal(externalId, IGDB_EXTERNAL_CATEGORY[category]);
            return game ? igdbGameToCandidate(game) : undefined;
          } catch (error) {
            options.log?.("warning", "IGDB external lookup failed", { externalId, category, error: errorMessage(error) });
            return undefined;
          }
        }
      : undefined;

    const identification = await identifyCandidate(candidate, chosenExe, {
      steamSearch: options.searchSteamStore,
      igdbSearch,
      igdbExternalLookup
    });

    return {
      folderPath: candidate.folderPath,
      folderName: candidate.folderName,
      candidateId: candidate.id,
      exeOptions: scoredOptions,
      chosenExe: chosenExe.path,
      identification
    };
  }

  /** Manual search across Steam Store and (optionally) IGDB. Used by the Add Game modal. */
  async searchMetadata(
    query: string,
    options: Pick<LocalImportRunOptions, "igdbAuth" | "searchSteamStore">
  ): Promise<{ steam: IdentifyCandidate[]; igdb: IdentifyCandidate[] }> {
    const trimmed = query.trim();
    if (!trimmed) return { steam: [], igdb: [] };
    const steam = options.searchSteamStore ? await options.searchSteamStore(trimmed).catch(() => []) : [];
    let igdb: IdentifyCandidate[] = [];
    if (options.igdbAuth) {
      try {
        const client = new IgdbClient(options.igdbAuth);
        const results = await client.searchGames(trimmed, 8);
        igdb = results.map(igdbGameToCandidate);
      } catch {
        igdb = [];
      }
    }
    return { steam, igdb };
  }

  /**
   * Add a single local game by folder or by specific exe — bypasses the root scan.
   * If `executablePath` is provided, that exe is used directly (no auto-selection);
   * the install directory defaults to its parent folder unless `folderPath` is given.
   * If `match` is provided, identification is skipped and that match is used directly
   * (used after the user picks one in the multi-step modal).
   */
  async addSingle(
    args: {
      folderPath?: string;
      executablePath?: string;
      titleOverride?: string;
      match?: { provider: "steam" | "igdb"; externalId: string; title: string };
    },
    options: Omit<LocalImportRunOptions, "roots" | "excludePatterns">
  ): Promise<{
    gameId: string;
    candidateId: string;
    title: string;
    chosenExe: string;
    identification: IdentifyResult;
  }> {
    const folderPath = args.folderPath ?? (args.executablePath ? dirname(args.executablePath) : undefined);
    if (!folderPath) {
      throw new Error("addSingle requires either folderPath or executablePath.");
    }

    // Use folder-based candidate when folderPath is available so the candidateId
    // matches what the scanner stored (hashFolderPath(folder)), keeping issue clearing correct.
    // When only an executablePath was provided (user picked a bare .exe), fall back to file-based.
    const candidate = args.folderPath
      ? await buildSingleCandidate(args.folderPath)
      : await buildSingleCandidateForFile(args.executablePath!);
    if (!candidate) {
      throw new Error(`No executables found under ${folderPath}.`);
    }

    const peInfos = await this.nativeBridge.getFileVersionInfo(candidate.exeFiles);
    const exeInfos: ExeFileInfo[] = candidate.exeFiles.map((path) => {
      const info = peInfos.find((entry) => entry.path === path);
      return {
        path,
        size: info?.size ?? 0,
        productName: info?.productName ?? undefined,
        fileDescription: info?.fileDescription ?? undefined,
        companyName: info?.companyName ?? undefined
      };
    });

    let chosenExe: ExeFileInfo;
    if (args.executablePath) {
      const matched = exeInfos.find((info) => info.path.toLowerCase() === args.executablePath!.toLowerCase());
      if (matched) {
        chosenExe = matched;
      } else {
        // User picked an exe outside the auto-discovered list (e.g. inside an excluded helper folder).
        // Fetch PE info for it directly and use it.
        const direct = await this.nativeBridge.getFileVersionInfo([args.executablePath]);
        const info = direct[0];
        chosenExe = {
          path: args.executablePath,
          size: info?.size ?? 0,
          productName: info?.productName ?? undefined,
          fileDescription: info?.fileDescription ?? undefined,
          companyName: info?.companyName ?? undefined
        };
      }
    } else {
      const selection = selectExe(candidate, exeInfos);
      if (!selection) throw new Error(`Could not pick an executable in ${folderPath}.`);
      chosenExe = selection.chosen;
    }

    const igdbClient = options.igdbAuth ? new IgdbClient(options.igdbAuth) : undefined;
    const igdbSearch: IgdbSearchProvider | undefined = igdbClient
      ? async (query) => {
          try {
            const results = await igdbClient.searchGames(query, 6);
            return results.map(igdbGameToCandidate);
          } catch (error) {
            options.log?.("warning", "IGDB search failed", { query, error: errorMessage(error) });
            return [];
          }
        }
      : undefined;
    const igdbExternalLookup: IgdbExternalLookup | undefined = igdbClient
      ? async (externalId, category) => {
          try {
            const game = await igdbClient.lookupByExternal(externalId, IGDB_EXTERNAL_CATEGORY[category]);
            return game ? igdbGameToCandidate(game) : undefined;
          } catch (error) {
            options.log?.("warning", "IGDB external lookup failed", { externalId, category, error: errorMessage(error) });
            return undefined;
          }
        }
      : undefined;

    const identification: IdentifyResult = args.match
      ? {
          kind: "match",
          match: {
            provider: args.match.provider,
            externalId: args.match.externalId,
            title: args.match.title,
            confidence: 1,
            reason: "search"
          }
        }
      : await identifyCandidate(candidate, chosenExe, {
          steamSearch: options.searchSteamStore,
          igdbSearch,
          igdbExternalLookup
        });

    let title = args.titleOverride ?? (identification.kind === "match" ? identification.match.title : undefined) ?? chosenExe.productName ?? candidate.folderName;

    const game: ImportedGame = {
      provider: "local",
      externalId: candidate.id,
      title,
      installState: "installed",
      installDirectory: candidate.folderPath,
      executablePath: chosenExe.path,
      addedAt: candidate.addedAtMs ? new Date(candidate.addedAtMs).toISOString() : undefined
    };
    const persisted = this.repository.upsertImportedGame(game);

    if (identification.kind === "match") {
      try {
        this.repository.attachSecondarySource({
          gameId: persisted.id,
          provider: identification.match.provider,
          externalId: identification.match.externalId
        });
      } catch (error) {
        options.log?.("warning", "Failed to attach matched source on single-add", {
          candidateId: candidate.id,
          error: errorMessage(error)
        });
      }

      try {
        let patch: GameMetadataPatch | undefined;
        if (identification.match.provider === "steam") {
          const fusionGame: ImportedGame = { ...game, provider: "steam", externalId: identification.match.externalId };
          patch = await refreshFusedMetadata(fusionGame, {
            steamGridDbApiKey: options.steamGridDbApiKey,
            logger: options.metadataLogger,
            steamAppInfoProvider: options.steamAppInfoProvider,
            mode: "full"
          });
        } else if (identification.match.provider === "igdb" && igdbClient) {
          const igdbGame = await igdbClient.getGame(Number(identification.match.externalId));
          if (igdbGame) patch = mapIgdbGameToPatch(igdbGame);
        }
        if (patch && Object.keys(patch).length > 0) {
          this.repository.applyMetadata(persisted.id, localMetadataPatch(patch));
        }
      } catch (error) {
        options.log?.("warning", "Single-add metadata refresh failed", {
          candidateId: candidate.id,
          error: errorMessage(error)
        });
      }
    }

    return {
      gameId: persisted.id,
      candidateId: candidate.id,
      title,
      chosenExe: chosenExe.path,
      identification
    };
  }
}

function igdbGameToCandidate(game: IgdbGame): IdentifyCandidate {
  return {
    provider: "igdb",
    externalId: String(game.id),
    title: game.name ?? "",
    confidence: 0,
    reason: "search",
    releaseDate: game.first_release_date ? new Date(game.first_release_date * 1000).toISOString() : undefined,
    coverUrl: game.cover?.image_id ? buildIgdbImageUrl(game.cover.image_id, "cover_big") : undefined,
    developer: game.involved_companies?.find((entry) => entry.developer)?.company?.name
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
