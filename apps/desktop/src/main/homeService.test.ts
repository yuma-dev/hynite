import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Game, HomeModel } from "@hynite/core";
import { buildHomeModel } from "@hynite/recommendations";
import { HomeService } from "./homeService";

vi.mock("@hynite/recommendations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hynite/recommendations")>();
  return {
    ...actual,
    buildHomeModel: vi.fn()
  };
});

const buildHomeModelMock = vi.mocked(buildHomeModel);

function game(id: string, title: string, patch: Partial<Game> = {}): Game {
  return {
    id,
    title,
    sortTitle: title.toLocaleLowerCase(),
    sourceIds: [{ provider: "steam", externalId: id.replace("steam:", "") }],
    installState: "installed",
    screenshots: [],
    genres: [],
    tags: [],
    playerModes: [],
    developers: [],
    publishers: [],
    contentDescriptors: [],
    metadataStatus: "complete",
    ...patch
  };
}

function homeModel(patch: Partial<HomeModel> = {}): HomeModel {
  return {
    recentActivity: [],
    continuePlaying: [],
    mostPlayed: [],
    popularNow: [],
    recommended: [],
    newAndNotable: [],
    trendingRows: [],
    generatedAt: "2026-05-15T00:00:00.000Z",
    stale: false,
    ...patch
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("HomeService", () => {
  let tempDir: string;
  let cachePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hynite-home-service-"));
    cachePath = join(tempDir, "home-cache.json");
    buildHomeModelMock.mockReset();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns a stale local model immediately and starts one background rebuild when no cache exists", async () => {
    const rebuild = deferred<HomeModel>();
    buildHomeModelMock.mockReturnValue(rebuild.promise);
    const rebuilt = homeModel({ popularNow: [game("steam:10", "Rebuilt")] });
    const onRebuilt = vi.fn();
    const service = new HomeService(cachePath, undefined, onRebuilt);
    const localGame = game("steam:1", "Local Game", {
      lastPlayedAt: "2026-05-15T12:00:00.000Z",
      playtimeMinutes: 30
    });

    const result = await service.get([localGame]);

    expect(result.stale).toBe(true);
    expect(result.popularNow).toEqual([]);
    expect(result.continuePlaying).toHaveLength(1);
    expect(buildHomeModelMock).toHaveBeenCalledTimes(1);

    const second = await service.get([localGame]);
    expect(second.stale).toBe(true);
    expect(second.popularNow).toEqual([]);
    expect(buildHomeModelMock).toHaveBeenCalledTimes(1);

    rebuild.resolve(rebuilt);
    await vi.waitFor(() => expect(onRebuilt).toHaveBeenCalledWith(rebuilt));
    await expect(readFile(cachePath, "utf8").then(JSON.parse)).resolves.toMatchObject({
      popularNow: [{ id: "steam:10" }]
    });
  });

  it("returns valid cached discovery immediately and schedules a rebuild", async () => {
    const cachedGame = game("steam:2", "Cached Game", {
      libraryCapsuleUrl: "cached-library-capsule.jpg"
    });
    await writeFile(cachePath, JSON.stringify(homeModel({ popularNow: [cachedGame] })));
    const rebuild = deferred<HomeModel>();
    buildHomeModelMock.mockReturnValue(rebuild.promise);
    const service = new HomeService(cachePath);

    const result = await service.get([game("steam:1", "Local Game")]);

    expect(result.stale).toBe(false);
    expect(result.popularNow[0]?.title).toBe("Cached Game");
    expect(buildHomeModelMock).toHaveBeenCalledTimes(1);
    rebuild.resolve(homeModel({ popularNow: [cachedGame] }));
  });

  it("does not return unsafe discovery cache and rebuilds in the background", async () => {
    const unsafeGame = game("steam:3", "Unsafe Game", {
      coverUrl: "https://cdn.akamai.steamstatic.com/steam/apps/3/library_600x900.jpg",
      libraryCapsuleUrl: "https://cdn.akamai.steamstatic.com/steam/apps/3/library_600x900.jpg"
    });
    await writeFile(cachePath, JSON.stringify(homeModel({ popularNow: [unsafeGame] })));
    const rebuild = deferred<HomeModel>();
    buildHomeModelMock.mockReturnValue(rebuild.promise);
    const service = new HomeService(cachePath);

    const result = await service.get([game("steam:1", "Local Game")]);

    expect(result.stale).toBe(true);
    expect(result.popularNow).toEqual([]);
    expect(buildHomeModelMock).toHaveBeenCalledTimes(1);
    rebuild.resolve(homeModel({ popularNow: [game("steam:4", "Safe Game")] }));
  });

  it("keeps returning stale local data when a background rebuild fails", async () => {
    buildHomeModelMock.mockRejectedValue(new Error("offline"));
    const service = new HomeService(cachePath);

    const result = await service.get([game("steam:1", "Local Game")]);

    expect(result.stale).toBe(true);
    expect(result.popularNow).toEqual([]);
    await vi.waitFor(() => expect(buildHomeModelMock).toHaveBeenCalledTimes(1));
    await expect(service.get([game("steam:1", "Local Game")])).resolves.toMatchObject({
      stale: true,
      popularNow: []
    });
  });
});
