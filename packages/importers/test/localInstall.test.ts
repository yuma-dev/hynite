import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSteamInstalledApps } from "../src/steam/localInstall";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("local Steam install discovery", () => {
  it("reads installed apps from Steam app manifests", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "hynite-steam-"));
    const steamAppsPath = join(tempDir, "steamapps");
    mkdirSync(steamAppsPath, { recursive: true });
    writeFileSync(
      join(steamAppsPath, "appmanifest_730.acf"),
      `"AppState"
{
  "appid" "730"
  "name" "Counter-Strike 2"
  "installdir" "Counter-Strike Global Offensive"
}`
    );

    await expect(readSteamInstalledApps({ path: tempDir, steamAppsPath })).resolves.toEqual([
      {
        appid: "730",
        name: "Counter-Strike 2",
        installDirectory: join(steamAppsPath, "common", "Counter-Strike Global Offensive")
      }
    ]);
  });
});
