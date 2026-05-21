import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type Game, type HomeModel, gameActivityTime } from "@hynite/core";
import { buildHomeModel, filterHomeHeroGames, homeHeroSafetyReason, type BuildHomeOptions } from "@hynite/recommendations";
import type { DiagnosticLogService } from "./diagnosticLogService";

const HOME_LOCAL_ROW_LIMIT = 72;

export class HomeService {
  private rebuild?: Promise<void>;
  private discoveryRefreshAttemptedThisRun = false;

  constructor(
    private readonly cachePath: string,
    private readonly diagnosticLog?: DiagnosticLogService,
    private readonly onRebuilt?: (model: HomeModel) => void
  ) {}

  async get(
    games: Game[],
    options: {
      steamGridDbApiKey?: string;
      steamAppInfoProvider?: BuildHomeOptions["steamAppInfoProvider"];
    } = {}
  ): Promise<HomeModel> {
    const previous = await this.readCache();
    this.logDecision("home:get", "Home model requested", {
      games: games.length,
      hasCache: Boolean(previous),
      cacheStale: previous?.stale,
      cachePopularNow: previous?.popularNow.length ?? 0,
      rebuildRunning: Boolean(this.rebuild)
    });
    const hasPreviousDiscovery = previous ? this.hasDiscovery(previous) : false;
    if (previous && this.hasUnsafeDiscoveryCache(previous)) {
      this.logDecision("home:get", "Unsafe Home cache found; scheduling rebuild and returning local model", {
        games: games.length
      });
      this.startBackgroundRebuild(games, previous, options);
      return this.cachedOrLocalModel(games, undefined, true);
    }

    if (!previous || !hasPreviousDiscovery) {
      this.logDecision("home:get", "No usable Home discovery cache exists; scheduling rebuild and returning local model", {
        games: games.length
      });
      this.startBackgroundRebuild(games, previous, options);
      return this.cachedOrLocalModel(games, previous, true);
    }

    if (!this.discoveryRefreshAttemptedThisRun) {
      this.startBackgroundRebuild(games, previous, options);
    } else {
      this.logDecision("home:get", "Returning cached Home model without another discovery rebuild", {
        generatedAt: previous.generatedAt,
        popularNow: previous.popularNow.length
      });
    }
    return this.cachedOrLocalModel(games, previous, false);
  }

  async clearCache(): Promise<void> {
    await rm(this.cachePath, { force: true });
    this.discoveryRefreshAttemptedThisRun = false;
  }

  private startBackgroundRebuild(
    games: Game[],
    previous: HomeModel | undefined,
    options: {
      steamGridDbApiKey?: string;
      steamAppInfoProvider?: BuildHomeOptions["steamAppInfoProvider"];
    }
  ): void {
    if (this.rebuild) {
      this.logDecision("home:discovery", "Home rebuild already running; returning cached/local model");
      return;
    }

    this.discoveryRefreshAttemptedThisRun = true;
    this.logDecision("home:discovery", "Home background rebuild scheduled", {
      games: games.length,
      hasPrevious: Boolean(previous)
    });
    this.rebuild = this.rebuildNow(games, previous, options).finally(() => {
      this.rebuild = undefined;
    });
  }

  private async rebuildNow(
    games: Game[],
    previous: HomeModel | undefined,
    options: {
      steamGridDbApiKey?: string;
      steamAppInfoProvider?: BuildHomeOptions["steamAppInfoProvider"];
    }
  ): Promise<void> {
    try {
      this.logDecision("home:discovery", "Home background rebuild started", { games: games.length });
      const model = await this.buildAndWrite(games, previous, options);
      this.logDecision("home:discovery", "Home background rebuild finished", {
        generatedAt: model.generatedAt,
        popularNow: model.popularNow.length,
        heroTitles: model.popularNow.slice(0, 5).map((game) => game.title)
      });
      this.onRebuilt?.(model);
    } catch (error) {
      this.diagnosticLog?.log({
        level: "error",
        phase: "home:discovery",
        message: "Home discovery rebuild failed",
        details: { error: error instanceof Error ? error.message : String(error) }
      });
    }
  }

  private async buildAndWrite(
    games: Game[],
    previous: HomeModel | undefined,
    options: {
      steamGridDbApiKey?: string;
      steamAppInfoProvider?: BuildHomeOptions["steamAppInfoProvider"];
    }
  ): Promise<HomeModel> {
    const model = await buildHomeModel(games, fetch, previous, {
      steamGridDbApiKey: options.steamGridDbApiKey,
      steamAppInfoProvider: options.steamAppInfoProvider,
      logger: (entry) => this.diagnosticLog?.log(entry)
    });
    if (!this.hasDiscovery(model)) {
      this.diagnosticLog?.log({
        level: "warning",
        phase: "home:discovery",
        message: "Home discovery rebuild produced no discovery rows",
        details: {
          localGames: games.length,
          popularNow: model.popularNow.length
        }
      });
    }
    await this.writeModel(model);
    return model;
  }

  private async writeModel(model: HomeModel): Promise<void> {
    await mkdir(dirname(this.cachePath), { recursive: true });
    await writeFile(this.cachePath, JSON.stringify(model, null, 2));
  }

  private cachedOrLocalModel(games: Game[], previous: HomeModel | undefined, stale: boolean): HomeModel {
    const localRows = this.localRows(games);
    if (previous) {
      const cached = this.withDiscoveryHeaderFallbacks(previous);
      const ownedIds = this.ownedSourceIds(games);
      const filteredPopularNow = filterHomeHeroGames(cached.popularNow)
        .filter((game) => !this.isOwnedDiscoveryGame(game, ownedIds));
      const excluded = cached.popularNow
        .map((game) => ({ game, reason: homeHeroSafetyReason(game) }))
        .filter((item): item is { game: Game; reason: string } => Boolean(item.reason));
      this.logDecision("home:get", "Returning cached Home model", {
        generatedAt: cached.generatedAt,
        stale,
        cachedPopularNow: cached.popularNow.length,
        filteredPopularNow: filteredPopularNow.length,
        filteredHeroTitles: filteredPopularNow.slice(0, 5).map((game) => game.title),
        excludedHeroGames: excluded.slice(0, 20).map(({ game, reason }) => ({
          id: game.id,
          title: game.title,
          reason,
          genres: game.genres,
          tags: game.tags,
          contentDescriptors: game.contentDescriptors
        })),
        totalExcludedHeroGames: excluded.length
      });
      return {
        ...cached,
        ...localRows,
        popularNow: filteredPopularNow,
        stale
      };
    }

    return {
      ...localRows,
      popularNow: [],
      recommended: [],
      newAndNotable: [],
      generatedAt: new Date().toISOString(),
      stale: true
    };
  }

  private withDiscoveryHeaderFallbacks(model: HomeModel): HomeModel {
    const apply = (game: Game): Game => {
      if (game.headerUrl || game.backgroundUrl) {
        return game;
      }

      const steamAppId = game.sourceIds.find((source) => source.provider === "steam")?.externalId;
      if (!steamAppId) {
        return game;
      }

      const headerUrl = `https://cdn.akamai.steamstatic.com/steam/apps/${encodeURIComponent(steamAppId)}/header.jpg`;
      return {
        ...game,
        headerUrl,
        backgroundUrl: headerUrl
      };
    };

    return {
      ...model,
      popularNow: model.popularNow.map(apply),
      recommended: model.recommended.map(apply),
      newAndNotable: model.newAndNotable.map(apply)
    };
  }

  private hasDiscovery(model: HomeModel): boolean {
    return model.popularNow.length > 0;
  }

  private logDecision(phase: string, message: string, details?: Record<string, unknown>): void {
    if (process.env.HYNITE_HOME_DEBUG === "1" || process.env.HYNITE_HOME_DEBUG === "true") {
      console.info(`[home] ${message}`, details ?? {});
    }
    this.diagnosticLog?.log({ level: "info", phase, message, details });
  }

  private localRows(games: Game[]): Pick<HomeModel, "recentActivity" | "continuePlaying" | "mostPlayed"> {
    return {
      recentActivity: games
        .slice()
        .filter((game) => gameActivityTime(game) > 0)
        .sort((a, b) => gameActivityTime(b) - gameActivityTime(a))
        .slice(0, 10),
      continuePlaying: games
        .filter((game) => game.lastPlayedAt)
        .sort((a, b) => (Date.parse(b.lastPlayedAt ?? "") || 0) - (Date.parse(a.lastPlayedAt ?? "") || 0))
        .slice(0, HOME_LOCAL_ROW_LIMIT),
      mostPlayed: games
        .slice()
        .sort((a, b) => (b.playtimeMinutes ?? 0) - (a.playtimeMinutes ?? 0))
        .slice(0, HOME_LOCAL_ROW_LIMIT)
    };
  }

  private ownedSourceIds(games: Game[]): Set<string> {
    return new Set(games.flatMap((game) => game.sourceIds.map((source) => `${source.provider}:${source.externalId}`)));
  }

  private isOwnedDiscoveryGame(game: Game, ownedIds: Set<string>): boolean {
    if (ownedIds.has(game.id)) {
      return true;
    }

    return game.sourceIds.some((source) => ownedIds.has(`${source.provider}:${source.externalId}`));
  }

  private async readCache(): Promise<HomeModel | undefined> {
    try {
      return JSON.parse(await readFile(this.cachePath, "utf8")) as HomeModel;
    } catch {
      return undefined;
    }
  }

  private hasUnsafeDiscoveryCache(model: HomeModel): boolean {
    const games = [...model.popularNow, ...model.recommended, ...model.newAndNotable];
    return games.some((game) => {
      if (this.isLegacyGuessedLibraryCapsuleUrl(game.libraryCapsuleUrl) || this.isLegacyGuessedLibraryCapsuleUrl(game.coverUrl)) {
        return true;
      }

      return Boolean(!game.libraryCapsuleUrl && game.coverUrl && !this.isVerifiedVerticalCoverUrl(game.coverUrl));
    });
  }

  private isLegacyGuessedLibraryCapsuleUrl(value: string | undefined): boolean {
    return Boolean(value && /^https:\/\/(?:cdn\.akamai\.steamstatic\.com\/steam|steamcdn-a\.akamaihd\.net\/steam)\/apps\/\d+\/library_600x900(?:_2x)?\.jpg(?:\?.*)?$/i.test(value));
  }

  private isVerifiedVerticalCoverUrl(value: string | undefined): boolean {
    return Boolean(value && (/(?:\/|%2f)library_(?:600x900|capsule)(?:_2x)?\.(?:jpg|png|webp)(?:\?|$)/i.test(value) || /steamgriddb\.com\/grid\//i.test(value)));
  }
}
