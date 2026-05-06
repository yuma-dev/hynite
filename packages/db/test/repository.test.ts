import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HyniteRepository } from "../src/repository";

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

  it("preserves added time across Steam upserts", () => {
    const repository = createRepository();
    repository.upsertImportedGame({
      provider: "steam",
      externalId: "730",
      title: "Counter-Strike 2",
      installState: "unknown"
    });
    const firstAddedAt = repository.getGame("steam:730")?.addedAt;

    repository.upsertImportedGame({
      provider: "steam",
      externalId: "730",
      title: "Counter-Strike 2",
      installState: "unknown",
      playtimeMinutes: 60
    });

    expect(repository.getGame("steam:730")?.addedAt).toBe(firstAddedAt);
    expect(repository.getGame("steam:730")?.playtimeMinutes).toBe(60);

    repository.close();
  });

  it("sorts recent games by latest played or added activity", () => {
    const repository = createRepository();
    repository.upsertImportedGame({ provider: "steam", externalId: "1", title: "Old", installState: "unknown" });
    repository.upsertImportedGame({ provider: "steam", externalId: "2", title: "Played", installState: "unknown", lastPlayedAt: "2026-05-05T10:00:00.000Z" });
    repository.upsertImportedGame({ provider: "steam", externalId: "3", title: "Added", installState: "unknown" });
    repository.db.prepare("UPDATE games SET added_at = ? WHERE id = ?").run("2026-05-06T10:00:00.000Z", "steam:3");
    repository.db.prepare("UPDATE games SET added_at = ? WHERE id = ?").run("2026-05-01T10:00:00.000Z", "steam:2");
    repository.db.prepare("UPDATE games SET added_at = ? WHERE id = ?").run("2026-05-01T10:00:00.000Z", "steam:1");

    expect(repository.queryGames("", "all", "recent").map((game) => game.id)).toEqual(["steam:3", "steam:2", "steam:1"]);

    repository.close();
  });

  it("persists rich metadata fields", () => {
    const repository = createRepository();
    repository.upsertImportedGame({ provider: "steam", externalId: "1086940", title: "Baldur's Gate 3", installState: "unknown" });
    repository.applyMetadata("steam:1086940", {
      libraryCapsuleUrl: "library.jpg",
      coverUrl: "library.jpg",
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
      trailerUrl: "trailer.m3u8",
      screenshots: [{ thumbnailUrl: "thumb.jpg", fullUrl: "full.jpg" }],
      platforms: { windows: true, mac: true, linux: false },
      contentDescriptors: ["Violence"],
      discovery: { score: 42, signal: "Trending", sources: ["test"] }
    });

    repository.close();
  });
});
