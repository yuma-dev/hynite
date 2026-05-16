import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_METADATA_VERSION, HyniteRepository } from "../src/repository";
import { normalizeTitle } from "@hynite/source-search";

let tempDir: string | undefined;

function createRepository(): HyniteRepository {
  tempDir = mkdtempSync(join(tmpdir(), "hynite-db-"));
  return new HyniteRepository(join(tempDir, "hynite.db"));
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("HyniteRepository", () => {
  it("clears library games without removing imported download sources", () => {
    const repository = createRepository();
    repository.upsertImportedGame({
      provider: "steam",
      externalId: "1086940",
      title: "Baldur's Gate 3",
      installState: "unknown"
    });
    repository.saveDownloadSource({
      id: "source-1",
      name: "Source",
      rawHash: "hash",
      entries: [
        {
          id: "entry-1",
          title: "Baldur's Gate 3",
          normalizedTitle: "baldurs gate 3",
          uris: ["magnet:?xt=urn:btih:test"]
        }
      ]
    });

    expect(repository.clearLibrary()).toBe(1);
    expect(repository.listGames()).toEqual([]);
    expect(repository.listDownloadEntries()).toHaveLength(1);

    repository.close();
  });

  it("preserves import time separately from provider added time", () => {
    const repository = createRepository();
    repository.upsertImportedGame({
      provider: "steam",
      externalId: "730",
      title: "Counter-Strike 2",
      installState: "unknown"
    });
    const firstImportAt = repository.getGame("steam:730")?.importedAt;

    repository.upsertImportedGame({
      provider: "steam",
      externalId: "730",
      title: "Counter-Strike 2",
      installState: "unknown",
      playtimeMinutes: 60,
      addedAt: "2024-02-01T00:00:00.000Z"
    });

    expect(repository.getGame("steam:730")?.importedAt).toBe(firstImportAt);
    expect(repository.getGame("steam:730")?.addedAt).toBe("2024-02-01T00:00:00.000Z");
    expect(repository.getGame("steam:730")?.playtimeMinutes).toBe(60);

    repository.close();
  });

  it("preserves edited local display names across local rescans", () => {
    const repository = createRepository();
    repository.upsertImportedGame({
      provider: "local",
      externalId: "folder-a",
      title: "Detected Title",
      installState: "installed",
      addedAt: "2024-01-01T00:00:00.000Z"
    });
    repository.applyMetadata("local:folder-a", { title: "My Display Name" });

    repository.upsertImportedGame({
      provider: "local",
      externalId: "folder-a",
      title: "Detected Title After Rescan",
      installState: "installed",
      addedAt: "2024-02-01T00:00:00.000Z",
      executablePath: "G:\\Games\\FolderA\\game.exe"
    });

    const game = repository.getGame("local:folder-a");
    expect(game?.title).toBe("My Display Name");
    expect(game?.sortTitle).toBe("my display name");
    expect(game?.addedAt).toBe("2024-02-01T00:00:00.000Z");
    expect(game?.executablePath).toBe("G:\\Games\\FolderA\\game.exe");

    repository.close();
  });

  it("updates a moved local game without creating a duplicate on rescan", () => {
    const repository = createRepository();
    repository.upsertImportedGame({
      provider: "local",
      externalId: "old-folder",
      title: "Moved Game",
      installState: "installed",
      installDirectory: "G:\\Games\\Old",
      executablePath: "G:\\Games\\Old\\game.exe",
      addedAt: "2024-01-01T00:00:00.000Z"
    });

    repository.updateLocalGameLocation({
      gameId: "local:old-folder",
      externalId: "new-folder",
      installDirectory: "G:\\Games\\New",
      executablePath: "G:\\Games\\New\\game.exe"
    });
    repository.upsertImportedGame({
      provider: "local",
      externalId: "new-folder",
      title: "Detected After Move",
      installState: "installed",
      installDirectory: "G:\\Games\\New",
      executablePath: "G:\\Games\\New\\game.exe"
    });

    const games = repository.listLocalGames();
    expect(games).toHaveLength(1);
    expect(games[0]?.id).toBe("local:old-folder");
    expect(games[0]?.title).toBe("Moved Game");
    expect(games[0]?.installDirectory).toBe("G:\\Games\\New");
    expect(games[0]?.sourceIds).toEqual([
      expect.objectContaining({ provider: "local", externalId: "new-folder" })
    ]);

    repository.close();
  });

  it("groups exact normalized download title matches by source", () => {
    const repository = createRepository();
    repository.saveDownloadSource({
      id: "source-1",
      name: "Source A",
      rawHash: "hash-a",
      entries: [
        {
          id: "entry-1",
          title: "Baldur's Gate 3",
          normalizedTitle: normalizeTitle("Baldur's Gate 3"),
          uris: ["magnet:?xt=urn:btih:a"]
        },
        {
          id: "entry-2",
          title: "BALDURS GATE 3 Deluxe Edition [P] [RUS + ENG + 9] (2026, TBS) (1.0) [Portable]",
          normalizedTitle: normalizeTitle("BALDURS GATE 3 Deluxe Edition [P] [RUS + ENG + 9] (2026, TBS) (1.0) [Portable]"),
          uris: ["magnet:?xt=urn:btih:b"]
        }
      ]
    });
    repository.saveDownloadSource({
      id: "source-2",
      name: "Source B",
      rawHash: "hash-b",
      entries: [
        {
          id: "entry-3",
          title: "Baldurs Gate 3 - PC",
          normalizedTitle: normalizeTitle("Baldurs Gate 3 - PC"),
          uris: ["magnet:?xt=urn:btih:c"]
        },
        {
          id: "entry-4",
          title: "Baldurs Gate 30",
          normalizedTitle: normalizeTitle("Baldurs Gate 30"),
          uris: ["magnet:?xt=urn:btih:d"]
        }
      ]
    });

    expect(repository.exactDownloadTitleMatches(normalizeTitle("baldurs gate 3"))).toEqual([
      { sourceId: "source-1", sourceName: "Source A", count: 2 },
      { sourceId: "source-2", sourceName: "Source B", count: 1 }
    ]);
    expect(repository.exactDownloadTitleMatchesBatch([
      normalizeTitle("baldurs gate 3"),
      normalizeTitle("missing game")
    ])).toEqual(new Map([
      [normalizeTitle("baldurs gate 3"), [
        { sourceId: "source-1", sourceName: "Source A", count: 2 },
        { sourceId: "source-2", sourceName: "Source B", count: 1 }
      ]],
      [normalizeTitle("missing game"), []]
    ]));

    repository.close();
  });

  it("prunes provider source rows that disappeared from a synced account", () => {
    const repository = createRepository();
    repository.upsertImportedGame({ provider: "steam", externalId: "1", title: "Still Owned", installState: "unknown", ownerSteamid: "owner-a" });
    repository.upsertImportedGame({ provider: "steam", externalId: "2", title: "Old Playtest", installState: "unknown", ownerSteamid: "owner-a" });
    repository.upsertImportedGame({ provider: "steam", externalId: "3", title: "Other Account", installState: "unknown", ownerSteamid: "owner-b" });

    const result = repository.pruneProviderSources("steam", ["owner-a"], [{ externalId: "1", ownerSteamid: "owner-a" }]);

    expect(result).toEqual({ sourcesRemoved: 1, gamesRemoved: 1 });
    expect(repository.getGame("steam:1")?.title).toBe("Still Owned");
    expect(repository.getGame("steam:2")).toBeUndefined();
    expect(repository.getGame("steam:3")?.title).toBe("Other Account");

    repository.close();
  });

  it("sorts recent games by latest provider added or played activity, not import time", () => {
    const repository = createRepository();
    repository.upsertImportedGame({ provider: "steam", externalId: "1", title: "Imported Only", installState: "unknown" });
    repository.upsertImportedGame({ provider: "steam", externalId: "2", title: "Played", installState: "unknown", lastPlayedAt: "2026-05-05T10:00:00.000Z" });
    repository.upsertImportedGame({ provider: "steam", externalId: "3", title: "Provider Added", installState: "unknown", addedAt: "2026-05-06T10:00:00.000Z" });
    repository.db.prepare("UPDATE games SET imported_at = ? WHERE id = ?").run("2026-05-07T10:00:00.000Z", "steam:1");

    expect(repository.queryGames({ sort: "recent" }).map((game) => game.id)).toEqual(["steam:3", "steam:2", "steam:1"]);

    repository.close();
  });

  it("lists local executables and only advances last played timestamps", () => {
    const repository = createRepository();
    repository.upsertImportedGame({
      provider: "local",
      externalId: "alpha",
      title: "Alpha",
      installState: "installed",
      executablePath: "C:\\Games\\Alpha\\alpha.exe",
      lastPlayedAt: "2026-05-05T10:00:00.000Z"
    });
    repository.upsertImportedGame({
      provider: "local",
      externalId: "beta",
      title: "Beta",
      installState: "installed"
    });
    repository.upsertImportedGame({
      provider: "steam",
      externalId: "3",
      title: "Steam",
      installState: "installed",
      executablePath: "C:\\Games\\Steam\\steam.exe"
    });

    expect(repository.getLocalGameExecutables()).toEqual([
      {
        id: "local:alpha",
        executablePath: "C:\\Games\\Alpha\\alpha.exe",
        lastPlayedAt: "2026-05-05T10:00:00.000Z"
      }
    ]);

    expect(repository.updateLastPlayedAtIfNewer("local:alpha", "2026-05-04T10:00:00.000Z")).toBe(false);
    expect(repository.getGame("local:alpha")?.lastPlayedAt).toBe("2026-05-05T10:00:00.000Z");
    expect(repository.updateLastPlayedAtIfNewer("local:alpha", "2026-05-06T10:00:00.000Z")).toBe(true);
    expect(repository.getGame("local:alpha")?.lastPlayedAt).toBe("2026-05-06T10:00:00.000Z");

    repository.close();
  });

  it("filters library queries by an explicit game id set", () => {
    const repository = createRepository();
    repository.upsertImportedGame({ provider: "steam", externalId: "1", title: "Alpha", installState: "unknown" });
    repository.upsertImportedGame({ provider: "steam", externalId: "2", title: "Beta", installState: "unknown" });
    repository.upsertImportedGame({ provider: "steam", externalId: "3", title: "Gamma", installState: "unknown" });

    expect(repository.queryGames({ gameIds: ["steam:1", "steam:3"] }).map((game) => game.id)).toEqual(["steam:1", "steam:3"]);

    repository.close();
  });

  it("composes explicit game id filtering with search, filters, and sorting", () => {
    const repository = createRepository();
    repository.upsertImportedGame({ provider: "steam", externalId: "1", title: "Alpha Quest", installState: "installed", playtimeMinutes: 10 });
    repository.upsertImportedGame({ provider: "steam", externalId: "2", title: "Beta Quest", installState: "installed", playtimeMinutes: 50 });
    repository.upsertImportedGame({ provider: "steam", externalId: "3", title: "Alpha Demo", installState: "not_installed", playtimeMinutes: 100 });

    expect(repository.queryGames({
      gameIds: ["steam:1", "steam:2", "steam:3"],
      search: "alpha",
      installState: "installed",
      sort: "playtime",
      sortDirection: "desc"
    }).map((game) => game.id)).toEqual(["steam:1"]);

    repository.close();
  });

  it("returns no library rows for an empty explicit game id set", () => {
    const repository = createRepository();
    repository.upsertImportedGame({ provider: "steam", externalId: "1", title: "Alpha", installState: "unknown" });

    expect(repository.queryGames({ gameIds: [] })).toEqual([]);

    repository.close();
  });

  it("lists compact Spotlight games from library rows only", () => {
    const repository = createRepository();
    repository.upsertImportedGame({
      provider: "steam",
      externalId: "1",
      title: "Steam Installed",
      installState: "installed",
      communityIconUrl: "icon-a.png"
    });
    repository.upsertImportedGame({
      provider: "steam",
      externalId: "2",
      title: "Steam Not Installed",
      installState: "not_installed"
    });
    repository.upsertImportedGame({
      provider: "local",
      externalId: "with-exe",
      title: "Local With Exe",
      installState: "installed",
      executablePath: "C:\\Games\\Local\\local.exe"
    });
    repository.upsertImportedGame({
      provider: "local",
      externalId: "no-exe",
      title: "Local Without Exe",
      installState: "installed"
    });
    repository.applyMetadata("steam:2", { libraryCapsuleUrl: "capsule-b.jpg" });
    repository.replaceSteamWishlistForAccount("owner-a", [{
      appid: "wishlist-only",
      title: "Wishlist Only",
      sortTitle: "wishlist only",
      accounts: [{ steamId: "owner-a" }],
      releasePrecision: "unknown",
      refreshedAt: "2026-05-16T00:00:00.000Z",
      metadataStatus: "none"
    }]);

    expect(repository.listSpotlightGames()).toEqual([
      expect.objectContaining({
        id: "local:with-exe",
        title: "Local With Exe",
        launchable: true,
        sourceLabels: ["local"]
      }),
      expect.objectContaining({
        id: "local:no-exe",
        title: "Local Without Exe",
        launchable: false,
        sourceLabels: ["local"]
      }),
      expect.objectContaining({
        id: "steam:1",
        title: "Steam Installed",
        launchable: true,
        iconUrl: "icon-a.png",
        sourceLabels: ["steam"]
      }),
      expect.objectContaining({
        id: "steam:2",
        title: "Steam Not Installed",
        launchable: true,
        iconUrl: "capsule-b.jpg",
        sourceLabels: ["steam"]
      })
    ]);

    repository.close();
  });

  it("persists rich metadata fields", () => {
    const repository = createRepository();
    repository.upsertImportedGame({ provider: "steam", externalId: "1086940", title: "Baldur's Gate 3", installState: "unknown" });
    repository.applyMetadata("steam:1086940", {
      libraryCapsuleUrl: "library.jpg",
      coverUrl: "library.jpg",
      logoUrl: "logo.png",
      trailerUrl: "trailer.m3u8",
      screenshots: [{ thumbnailUrl: "thumb.jpg", fullUrl: "full.jpg" }],
      platforms: { windows: true, mac: true, linux: false },
      contentDescriptors: ["Violence"],
      discovery: { score: 42, signal: "Trending", sources: ["test"] },
      metadataStatus: "complete"
    });

    expect(repository.getGame("steam:1086940")).toMatchObject({
      libraryCapsuleUrl: "library.jpg",
      coverUrl: "library.jpg",
      logoUrl: "logo.png",
      trailerUrl: "trailer.m3u8",
      screenshots: [{ thumbnailUrl: "thumb.jpg", fullUrl: "full.jpg" }],
      platforms: { windows: true, mac: true, linux: false },
      contentDescriptors: ["Violence"],
      discovery: { score: 42, signal: "Trending", sources: ["test"] }
    });
    expect(repository.getMetadataVersion("steam:1086940")).toBe(CURRENT_METADATA_VERSION);

    repository.close();
  });

  it("persists raw provider metadata separately from normalized game fields", () => {
    const repository = createRepository();
    repository.upsertImportedGame({ provider: "steam", externalId: "1086940", title: "Baldur's Gate 3", installState: "unknown" });

    repository.saveRawGameMetadata({
      gameId: "steam:1086940",
      provider: "steam",
      externalId: "1086940",
      source: "steam_appinfo",
      raw: { common: { name: "Baldur's Gate 3", store_tags: { "0": "122" } } },
      fetchedAt: "2026-05-08T00:00:00.000Z"
    });

    expect(repository.getRawGameMetadata("steam", "1086940", "steam_appinfo")).toEqual({
      gameId: "steam:1086940",
      provider: "steam",
      externalId: "1086940",
      source: "steam_appinfo",
      raw: { common: { name: "Baldur's Gate 3", store_tags: { "0": "122" } } },
      fetchedAt: "2026-05-08T00:00:00.000Z"
    });

    repository.close();
  });

  it("persists family-shared source rows with owner steamids", () => {
    const repository = createRepository();
    repository.upsertImportedGame({
      provider: "steam",
      externalId: "1086940",
      title: "Baldur's Gate 3",
      installState: "unknown",
      shareType: "family",
      familyOwnerSteamIds: ["76561198000000001", "76561198000000002"]
    });

    const persisted = repository.getGame("steam:1086940");
    expect(persisted?.sourceIds).toEqual([
      {
        provider: "steam",
        externalId: "1086940",
        shareType: "family",
        familyOwnerSteamIds: ["76561198000000001", "76561198000000002"]
      }
    ]);

    repository.close();
  });

  it("maps source rows consistently for full, filtered, and local library reads", () => {
    const repository = createRepository();
    repository.upsertImportedGame({
      provider: "local",
      externalId: "local-alpha",
      title: "Alpha Local",
      installState: "installed",
      installDirectory: "C:\\Games\\Alpha"
    });
    repository.attachSecondarySource({
      gameId: "local:local-alpha",
      provider: "steam",
      externalId: "123"
    });
    repository.upsertImportedGame({
      provider: "steam",
      externalId: "456",
      title: "Shared Beta",
      installState: "unknown",
      shareType: "family",
      familyOwnerSteamIds: ["76561198000000001"],
      ownerSteamid: "76561198000000002"
    });

    const fullLocal = repository.listGames().find((game) => game.id === "local:local-alpha");
    const filteredLocal = repository.queryGames({ sources: ["steam"] }).find((game) => game.id === "local:local-alpha");
    const localScreenGame = repository.listLocalGames().find((game) => game.id === "local:local-alpha");
    const shared = repository.queryGames({ ownership: "family" })[0];

    expect(fullLocal?.sourceIds.map((source) => `${source.provider}:${source.externalId}`).sort()).toEqual([
      "local:local-alpha",
      "steam:123"
    ]);
    expect(filteredLocal?.sourceIds).toEqual(fullLocal?.sourceIds);
    expect(localScreenGame?.sourceIds).toEqual(fullLocal?.sourceIds);
    expect(shared?.sourceIds[0]).toMatchObject({
      provider: "steam",
      externalId: "456",
      shareType: "family",
      familyOwnerSteamIds: ["76561198000000001"],
      ownerSteamid: "76561198000000002"
    });

    repository.close();
  });

  it("does not downgrade an owned source row to family on subsequent imports", () => {
    const repository = createRepository();
    repository.upsertImportedGame({
      provider: "steam",
      externalId: "730",
      title: "Counter-Strike 2",
      installState: "unknown"
    });
    repository.upsertImportedGame({
      provider: "steam",
      externalId: "730",
      title: "Counter-Strike 2",
      installState: "unknown",
      shareType: "family",
      familyOwnerSteamIds: ["76561198000000001"]
    });

    const persisted = repository.getGame("steam:730");
    expect(persisted?.sourceIds[0]?.shareType).toBe("owned");

    repository.close();
  });

  it("upgrades a family source row to owned when the user later owns the game", () => {
    const repository = createRepository();
    repository.upsertImportedGame({
      provider: "steam",
      externalId: "440",
      title: "Team Fortress 2",
      installState: "unknown",
      shareType: "family",
      familyOwnerSteamIds: ["76561198000000001"]
    });
    repository.upsertImportedGame({
      provider: "steam",
      externalId: "440",
      title: "Team Fortress 2",
      installState: "unknown"
    });

    const persisted = repository.getGame("steam:440");
    expect(persisted?.sourceIds[0]?.shareType).toBe("owned");
    expect(persisted?.sourceIds[0]?.familyOwnerSteamIds).toBeUndefined();

    repository.close();
  });

  it("hides legacy guessed library capsule urls from mapped games", () => {
    const repository = createRepository();
    repository.upsertImportedGame({ provider: "steam", externalId: "3405690", title: "EA SPORTS FC™ 26", installState: "unknown" });
    repository.applyMetadata("steam:3405690", {
      libraryCapsuleUrl: "https://cdn.akamai.steamstatic.com/steam/apps/3405690/library_600x900.jpg",
      coverUrl: "https://cdn.akamai.steamstatic.com/steam/apps/3405690/library_600x900.jpg",
      headerUrl: "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3405690/hash/header.jpg",
      metadataStatus: "partial"
    });

    expect(repository.getGame("steam:3405690")).toMatchObject({
      libraryCapsuleUrl: undefined,
      coverUrl: undefined,
      headerUrl: "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3405690/hash/header.jpg"
    });

    repository.close();
  });

  it("dedupes Steam wishlist appids across accounts", () => {
    const repository = createRepository();
    repository.replaceSteamWishlistForAccount("owner-a", [
      {
        appid: "100",
        title: "Shared Wish",
        sortTitle: "shared wish",
        accounts: [{ steamId: "owner-a", personaName: "Owner A", priority: 1, addedAt: "2026-01-01T00:00:00.000Z" }],
        releaseDate: "2026-06-01",
        releaseDateText: "Jun 1, 2026",
        releasePrecision: "exact",
        refreshedAt: "2026-05-13T00:00:00.000Z",
        metadataStatus: "partial"
      }
    ]);
    repository.replaceSteamWishlistForAccount("owner-b", [
      {
        appid: "100",
        title: "Shared Wish",
        sortTitle: "shared wish",
        accounts: [{ steamId: "owner-b", personaName: "Owner B" }],
        releaseDate: "2026-06-01",
        releaseDateText: "Jun 1, 2026",
        releasePrecision: "exact",
        refreshedAt: "2026-05-13T00:00:00.000Z",
        metadataStatus: "partial"
      }
    ]);

    const items = repository.querySteamWishlist({});
    expect(items).toHaveLength(1);
    expect(items[0]?.accounts.map((account) => account.steamId)).toEqual(["owner-a", "owner-b"]);

    repository.close();
  });

  it("replaces one account wishlist without pruning another account", () => {
    const repository = createRepository();
    const base = {
      title: "Wish",
      sortTitle: "wish",
      releasePrecision: "unknown" as const,
      refreshedAt: "2026-05-13T00:00:00.000Z",
      metadataStatus: "none" as const
    };
    repository.replaceSteamWishlistForAccount("owner-a", [
      { ...base, appid: "100", accounts: [{ steamId: "owner-a" }] },
      { ...base, appid: "200", accounts: [{ steamId: "owner-a" }] }
    ]);
    repository.replaceSteamWishlistForAccount("owner-b", [
      { ...base, appid: "200", accounts: [{ steamId: "owner-b" }] }
    ]);

    repository.replaceSteamWishlistForAccount("owner-a", [
      { ...base, appid: "300", accounts: [{ steamId: "owner-a" }] }
    ]);

    expect(repository.querySteamWishlist({}).map((item) => item.appid).sort()).toEqual(["200", "300"]);
    expect(repository.querySteamWishlist({ accountSteamIds: ["owner-b"] }).map((item) => item.appid)).toEqual(["200"]);

    repository.close();
  });

  it("keeps cached wishlist rows when no replacement is performed after a failed refresh", () => {
    const repository = createRepository();
    repository.replaceSteamWishlistForAccount("owner-a", [
      {
        appid: "100",
        title: "Cached Wish",
        sortTitle: "cached wish",
        accounts: [{ steamId: "owner-a" }],
        releasePrecision: "unknown",
        refreshedAt: "2026-05-13T00:00:00.000Z",
        metadataStatus: "partial"
      }
    ]);

    expect(repository.querySteamWishlist({ accountSteamIds: ["owner-a"] }).map((item) => item.title)).toEqual(["Cached Wish"]);

    repository.close();
  });

  it("returns exact upcoming wishlist releases for calendar queries", () => {
    const repository = createRepository();
    const base = {
      title: "Wish",
      sortTitle: "wish",
      refreshedAt: "2026-05-13T00:00:00.000Z",
      metadataStatus: "partial" as const,
      accounts: [{ steamId: "owner-a" }]
    };
    repository.replaceSteamWishlistForAccount("owner-a", [
      { ...base, appid: "1", releaseDate: "2026-05-20", releaseDateText: "May 20, 2026", releasePrecision: "exact" },
      { ...base, appid: "2", releaseDate: "2026-09-01", releaseDateText: "Sep 1, 2026", releasePrecision: "exact" },
      { ...base, appid: "3", releaseDateText: "Coming soon", releasePrecision: "unknown" },
      { ...base, appid: "4", releaseDate: "2026-05-01", releaseDateText: "May 1, 2026", releasePrecision: "exact" }
    ]);

    expect(repository.querySteamWishlistCalendar({ startDate: "2026-05-13", months: 3 }).map((item) => item.appid)).toEqual(["1"]);

    repository.close();
  });
});
