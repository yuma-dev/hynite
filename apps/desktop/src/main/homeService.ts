import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type Game, type HomeModel, gameActivityTime } from "@hynite/core";
import { buildHomeModel, filterHomeHeroGames, type BuildHomeOptions } from "@hynite/recommendations";
import type { DiagnosticLogService } from "./diagnosticLogService";

const HOME_LOCAL_ROW_LIMIT = 72;

export class HomeService {
  private rebuild?: Promise<void>;

  constructor(
    private readonly cachePath: string,
    private readonly diagnosticLog?: DiagnosticLogService
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
      cacheTrendingRows: previous?.trendingRows.length ?? 0,
      rebuildRunning: Boolean(this.rebuild)
    });
    const hasPreviousDiscovery = previous ? this.hasDiscovery(previous) : false;
    if (previous && this.hasUnsafeDiscoveryCache(previous)) {
      try {
        this.logDecision("home:get", "Unsafe Home cache found; rebuilding before returning", {
          games: games.length
        });
        return await this.buildAndWrite(games, previous, options);
      } catch (error) {
        this.diagnosticLog?.log({
          level: "error",
          phase: "home:discovery",
          message: "Home discovery blocking rebuild failed",
          details: { error: error instanceof Error ? error.message : String(error) }
        });
      }
    }

    if (!hasPreviousDiscovery) {
      if (this.rebuild) {
        this.logDecision("home:get", "Waiting for active Home discovery rebuild because no discovery cache exists", {
          games: games.length
        });
        await this.rebuild.catch(() => undefined);
        const rebuilt = await this.readCache();
        if (rebuilt && this.hasDiscovery(rebuilt)) {
          return this.cachedOrLocalModel(games, rebuilt, false);
        }
      }

      try {
        this.logDecision("home:get", "No Home discovery cache exists; rebuilding before returning", {
          games: games.length
        });
        return await this.buildAndWrite(games, previous, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.diagnosticLog?.log({
          level: "error",
          phase: "home:discovery",
          message: "Home discovery first build failed; returning loading model",
          details: { error: message }
        });
        return this.cachedOrLocalModel(games, undefined, true);
      }
    }

    this.startBackgroundRebuild(games, previous, options);
    return this.cachedOrLocalModel(games, previous, false);
  }

  async clearCache(): Promise<void> {
    await rm(this.cachePath, { force: true });
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
        popularNow: model.popularNow.length,
        trendingRows: model.trendingRows.length,
        trendingGames: model.trendingRows.reduce((sum, row) => sum + row.games.length, 0)
      });
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
          popularNow: model.popularNow.length,
          trendingRows: model.trendingRows.length
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
      return {
        ...previous,
        ...localRows,
        popularNow: filterHomeHeroGames(previous.popularNow),
        stale
      };
    }

    return {
      ...localRows,
      popularNow: [],
      recommended: [],
      newAndNotable: [],
      trendingRows: [],
      generatedAt: new Date().toISOString(),
      stale: true
    };
  }

  private hasDiscovery(model: HomeModel): boolean {
    return model.popularNow.length > 0 || model.trendingRows.some((row) => row.games.length > 0);
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

  private async readCache(): Promise<HomeModel | undefined> {
    try {
      return JSON.parse(await readFile(this.cachePath, "utf8")) as HomeModel;
    } catch {
      return undefined;
    }
  }

  private hasUnsafeDiscoveryCache(model: HomeModel): boolean {
    const games = [...model.popularNow, ...model.recommended, ...model.newAndNotable, ...model.trendingRows.flatMap((row) => row.games)];
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
