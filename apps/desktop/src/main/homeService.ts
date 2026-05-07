import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type Game, type HomeModel, gameActivityTime } from "@hynite/core";
import { buildHomeModel, type BuildHomeOptions } from "@hynite/recommendations";
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
    if (previous && this.hasUnsafeDiscoveryCache(previous)) {
      try {
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

    this.startBackgroundRebuild(games, previous, options);
    return this.cachedOrLocalModel(games, previous);
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
      return;
    }

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
      await this.buildAndWrite(games, previous, options);
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
    await mkdir(dirname(this.cachePath), { recursive: true });
    await writeFile(this.cachePath, JSON.stringify(model, null, 2));
    return model;
  }

  private cachedOrLocalModel(games: Game[], previous: HomeModel | undefined): HomeModel {
    const localRows = this.localRows(games);
    if (previous) {
      return {
        ...previous,
        ...localRows,
        stale: true
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
