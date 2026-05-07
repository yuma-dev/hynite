import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Game, HomeModel } from "@hynite/core";
import { buildHomeModel } from "@hynite/recommendations";

const HOME_LOCAL_ROW_LIMIT = 72;

export class HomeService {
  constructor(private readonly cachePath: string) {}

  async get(games: Game[]): Promise<HomeModel> {
    const previous = await this.readCache();
    try {
      const model = await buildHomeModel(games, fetch, previous);
      await mkdir(dirname(this.cachePath), { recursive: true });
      await writeFile(this.cachePath, JSON.stringify(model, null, 2));
      return model;
    } catch {
      if (previous) {
        return { ...previous, stale: true };
      }

      return {
        recentActivity: games
          .slice()
          .sort((a, b) => Math.max(Date.parse(b.lastPlayedAt ?? "") || 0, Date.parse(b.addedAt ?? "") || 0) - Math.max(Date.parse(a.lastPlayedAt ?? "") || 0, Date.parse(a.addedAt ?? "") || 0))
          .slice(0, 10),
        continuePlaying: games
          .filter((game) => game.lastPlayedAt)
          .sort((a, b) => (Date.parse(b.lastPlayedAt ?? "") || 0) - (Date.parse(a.lastPlayedAt ?? "") || 0))
          .slice(0, HOME_LOCAL_ROW_LIMIT),
        mostPlayed: games
          .slice()
          .sort((a, b) => (b.playtimeMinutes ?? 0) - (a.playtimeMinutes ?? 0))
          .slice(0, HOME_LOCAL_ROW_LIMIT),
        popularNow: [],
        recommended: [],
        newAndNotable: [],
        generatedAt: new Date().toISOString(),
        stale: true
      };
    }
  }

  private async readCache(): Promise<HomeModel | undefined> {
    try {
      return JSON.parse(await readFile(this.cachePath, "utf8")) as HomeModel;
    } catch {
      return undefined;
    }
  }
}
