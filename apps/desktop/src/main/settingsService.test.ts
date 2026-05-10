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
      launchAccountPreferences: {}
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
});
