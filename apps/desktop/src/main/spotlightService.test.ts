import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HyniteRepository } from "@hynite/db";
import { SpotlightService, normalizeSpotlightText } from "./spotlightService";

let tempDir: string | undefined;

function createRepository(): HyniteRepository {
  tempDir = mkdtempSync(join(tmpdir(), "hynite-spotlight-"));
  return new HyniteRepository(join(tempDir, "hynite.db"));
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("SpotlightService", () => {
  it("normalizes case, accents, and punctuation", () => {
    expect(normalizeSpotlightText("  Café-Racer: Deluxe!! ")).toBe("cafe racer deluxe");
  });

  it("returns empty query results sorted by recent activity and capped", () => {
    const repository = createRepository();
    for (let index = 0; index < 35; index += 1) {
      repository.upsertImportedGame({
        provider: "steam",
        externalId: String(index),
        title: `Game ${String(index).padStart(2, "0")}`,
        installState: "unknown",
        lastPlayedAt: index === 4 ? "2026-05-14T00:00:00.000Z" : index === 2 ? "2026-05-13T00:00:00.000Z" : undefined
      });
    }
    repository.db.prepare("UPDATE games SET imported_at = ?").run("2026-05-01T00:00:00.000Z");
    repository.db.prepare("UPDATE games SET imported_at = ? WHERE id = ?").run("2026-05-15T00:00:00.000Z", "steam:1");
    const service = new SpotlightService(repository);

    const results = service.search("");
    repository.close();

    expect(results).toHaveLength(30);
    expect(results[0]?.title).toBe("Game 01");
    expect(results[1]?.title).toBe("Game 04");
    expect(results[2]?.title).toBe("Game 02");
  });

  it("ranks exact, prefix, token-prefix, and substring matches", () => {
    const repository = createRepository();
    repository.upsertImportedGame({ provider: "steam", externalId: "1", title: "Ring", installState: "unknown" });
    repository.upsertImportedGame({ provider: "steam", externalId: "2", title: "Ringworld", installState: "unknown" });
    repository.upsertImportedGame({ provider: "steam", externalId: "3", title: "Elden Ring", installState: "unknown" });
    repository.upsertImportedGame({ provider: "steam", externalId: "4", title: "Boxing Ringmaster", installState: "unknown" });
    const service = new SpotlightService(repository);
    const titles = service.search("ring").map((result) => result.title);
    repository.close();

    expect(titles).toEqual([
      "Ring",
      "Ringworld",
      "Elden Ring",
      "Boxing Ringmaster"
    ]);
  });

  it("refreshes the in-memory index", () => {
    const repository = createRepository();
    const service = new SpotlightService(repository);
    expect(service.search("alpha")).toEqual([]);

    repository.upsertImportedGame({ provider: "steam", externalId: "1", title: "Alpha", installState: "unknown" });
    expect(service.search("alpha")).toEqual([]);

    service.refresh();
    expect(service.search("alpha")[0]?.title).toBe("Alpha");
    repository.close();
  });

  it("preserves family ownership in search results", () => {
    const repository = createRepository();
    repository.upsertImportedGame({
      provider: "steam",
      externalId: "1",
      title: "Shared Alpha",
      installState: "unknown",
      shareType: "family",
      familyOwnerSteamIds: ["owner-b"],
      ownerSteamid: "owner-a"
    });
    const service = new SpotlightService(repository);
    const result = service.search("shared")[0];
    repository.close();

    expect(result).toMatchObject({
      title: "Shared Alpha",
      ownership: "family"
    });
  });

});
