import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Game, HomeModel } from "@hynite/core";
import { buildHomeModel } from "@hynite/recommendations";

export class HomeService {
  constructor(private readonly cachePath: string) {}

  async get(games: Game[]): Promise<HomeModel> {
    try {
      const model = await buildHomeModel(games);
      await mkdir(dirname(this.cachePath), { recursive: true });
      await writeFile(this.cachePath, JSON.stringify(model, null, 2));
      return model;
    } catch {
      const cached = await this.readCache();
      if (cached) {
        return { ...cached, stale: true };
      }

      return {
        continuePlaying: games.slice(0, 8),
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

