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
          title: "BALDURS GATE 3 Deluxe Edition",
          normalizedTitle: normalizeTitle("BALDURS GATE 3 Deluxe Edition"),
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
          title: "Baldurs Gate 2",
          normalizedTitle: normalizeTitle("Baldurs Gate 2"),
          uris: ["magnet:?xt=urn:btih:d"]
        }
      ]
    });

    expect(repository.exactDownloadTitleMatches(normalizeTitle("baldurs gate 3"))).toEqual([
      { sourceId: "source-1", sourceName: "Source A", count: 2 },
      { sourceId: "source-2", sourceName: "Source B", count: 1 }
    ]);

    repository.close();
  });

  it("sorts recent games by latest provider added or played activity, not import time", () => {
    const repository = createRepository();
    repository.upsertImportedGame({ provider: "steam", externalId: "1", title: "Imported Only", installState: "unknown" });
    repository.upsertImportedGame({ provider: "steam", externalId: "2", title: "Played", installState: "unknown", lastPlayedAt: "2026-05-05T10:00:00.000Z" });
    repository.upsertImportedGame({ provider: "steam", externalId: "3", title: "Provider Added", installState: "unknown", addedAt: "2026-05-06T10:00:00.000Z" });
    repository.db.prepare("UPDATE games SET imported_at = ? WHERE id = ?").run("2026-05-07T10:00:00.000Z", "steam:1");

    expect(repository.queryGames("", "all", "recent").map((game) => game.id)).toEqual(["steam:3", "steam:2", "steam:1"]);

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
});
