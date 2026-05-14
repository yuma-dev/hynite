import { describe, expect, it, vi } from "vitest";
import type { HyniteRepository } from "@hynite/db";
import type { SettingsService } from "./settingsService";
import type { SourceService } from "./sourceService";
import type { SyncStatusService } from "./syncStatusService";
import { SteamWishlistService } from "./steamWishlistService";

function makeService() {
  const sourceService = {
    exactTitleMatches: vi.fn((title: string) =>
      title === "Available Game" ? [{ sourceId: "source-a", sourceName: "Source A", count: 1 }] : []
    )
  } as unknown as SourceService;
  const repository = {
    querySteamWishlist: vi.fn(() => [
      {
        appid: "1",
        title: "Available Game",
        sortTitle: "available game",
        accounts: [{ steamId: "owner-a" }],
        releasePrecision: "unknown",
        refreshedAt: "2026-05-13T00:00:00.000Z",
        metadataStatus: "partial"
      },
      {
        appid: "2",
        title: "Missing Game",
        sortTitle: "missing game",
        accounts: [{ steamId: "owner-a" }],
        releasePrecision: "unknown",
        refreshedAt: "2026-05-13T00:00:00.000Z",
        metadataStatus: "partial"
      },
      {
        appid: "3",
        title: "Future Game",
        sortTitle: "future game",
        accounts: [{ steamId: "owner-a" }],
        releaseDate: "2999-01-01",
        releasePrecision: "exact",
        refreshedAt: "2026-05-13T00:00:00.000Z",
        metadataStatus: "partial"
      }
    ]),
    querySteamWishlistCalendar: vi.fn(() => [])
  } as unknown as HyniteRepository;

  const service = new SteamWishlistService({
    repository,
    sourceService,
    settingsService: { get: vi.fn() } as unknown as SettingsService,
    syncStatusService: { progress: vi.fn(), log: vi.fn() } as unknown as SyncStatusService,
    cacheMetadataAssets: vi.fn(async (patch) => patch)
  });
  return { service, sourceService };
}

describe("SteamWishlistService", () => {
  it("attaches source matches and filters by source availability", () => {
    const { service } = makeService();

    expect(service.list({ sourceAvailability: "available" }).map((item) => item.title)).toEqual(["Available Game"]);
    expect(service.list({ sourceAvailability: "missing" }).map((item) => item.title)).toEqual(["Missing Game"]);
  });

  it("does not source-check future exact-date wishlist rows", () => {
    const { service, sourceService } = makeService();

    service.list({});

    expect(sourceService.exactTitleMatches).not.toHaveBeenCalledWith("Future Game");
  });
});
