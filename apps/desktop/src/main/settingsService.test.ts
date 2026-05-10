import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsService } from "./settingsService";

let tempDir: string | undefined;

function createService(): SettingsService {
  tempDir = mkdtempSync(join(tmpdir(), "hynite-settings-"));
  return new SettingsService(join(tempDir, "settings.json"));
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("SettingsService", () => {
  it("migrates existing settings without launch account preferences", async () => {
    const service = createService();
    writeFileSync(join(tempDir!, "settings.json"), JSON.stringify({ cacheTtlHours: 12, reduceMotion: true }));

    await expect(service.get()).resolves.toMatchObject({
      cacheTtlHours: 12,
      reduceMotion: true,
      launchAccountPreferences: {},
      gameGroups: []
    });
  });

  it("writes and clears per-game launch account preferences without dropping settings", async () => {
    const service = createService();
    await service.update({
      cacheTtlHours: 6,
      steamAccounts: [{ steamId: "owner-a", pairedAt: "2026-01-01T00:00:00.000Z" }]
    });

    await expect(service.setLaunchAccountPreference("steam:10", "owner-a")).resolves.toMatchObject({
      cacheTtlHours: 6,
      steamAccounts: [{ steamId: "owner-a", pairedAt: "2026-01-01T00:00:00.000Z" }],
      launchAccountPreferences: { "steam:10": "owner-a" }
    });

    await expect(service.setLaunchAccountPreference("steam:10", undefined)).resolves.toMatchObject({
      cacheTtlHours: 6,
      launchAccountPreferences: {}
    });
  });

  it("writes and sanitizes game groups without dropping other settings", async () => {
    const service = createService();
    await service.update({ cacheTtlHours: 6, reduceMotion: true });
    const createdAt = "2026-05-10T00:00:00.000Z";
    const updatedAt = "2026-05-10T01:00:00.000Z";

    await expect(service.setGameGroups([
      {
        id: "manual-1",
        kind: "manual",
        name: "Favorites",
        gameIds: ["steam:10"],
        createdAt,
        updatedAt
      },
      {
        id: "smart-1",
        kind: "smart",
        name: "Installed RPGs",
        search: "rpg",
        view: {
          filters: { installState: "installed", ownership: "all", sources: [], genres: ["RPG"], tags: [], playerModes: [], dateFilter: "any" },
          sort: { field: "title", direction: "asc" }
        },
        createdAt,
        updatedAt
      }
    ])).resolves.toMatchObject({
      cacheTtlHours: 6,
      reduceMotion: true,
      gameGroups: [
        { id: "manual-1", kind: "manual", name: "Favorites", gameIds: ["steam:10"] },
        { id: "smart-1", kind: "smart", name: "Installed RPGs", search: "rpg" }
      ]
    });

    await expect(service.setGameGroups([])).resolves.toMatchObject({
      cacheTtlHours: 6,
      gameGroups: []
    });
  });
});
