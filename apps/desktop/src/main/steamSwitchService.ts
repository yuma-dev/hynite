import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SteamActiveUser } from "@hynite/core";
import {
  computeUpdatedLoginUsers,
  findSteamRoot,
  readLoginUsersFile,
  writeLoginUsers
} from "@hynite/importers";

const execFileAsync = promisify(execFile);

const STEAM_REG_KEY = "HKCU\\Software\\Valve\\Steam";

async function regQuery(valueName: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("reg.exe", ["query", STEAM_REG_KEY, "/v", valueName], { windowsHide: true });
    const match = stdout.match(new RegExp(`${valueName}\\s+REG_\\w+\\s+(.+)`));
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}

async function regWriteString(valueName: string, value: string): Promise<void> {
  await execFileAsync(
    "reg.exe",
    ["add", STEAM_REG_KEY, "/v", valueName, "/t", "REG_SZ", "/d", value, "/f"],
    { windowsHide: true }
  );
}

async function regWriteDword(valueName: string, value: number): Promise<void> {
  await execFileAsync(
    "reg.exe",
    ["add", STEAM_REG_KEY, "/v", valueName, "/t", "REG_DWORD", "/d", String(value), "/f"],
    { windowsHide: true }
  );
}

async function isSteamRunning(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("tasklist.exe", ["/FI", "IMAGENAME eq steam.exe", "/FO", "CSV", "/NH"], {
      windowsHide: true
    });
    return /^"steam\.exe"/im.test(stdout.trim());
  } catch {
    return false;
  }
}

export async function getActiveSteamUser(): Promise<SteamActiveUser> {
  const [accountName, isRunning] = await Promise.all([regQuery("AutoLoginUser"), isSteamRunning()]);
  let steamId: string | undefined;
  if (accountName) {
    try {
      const file = await readLoginUsersFile();
      if (file) {
        const users = (file.root.users && typeof file.root.users === "object" ? file.root.users : {}) as Record<
          string,
          unknown
        >;
        for (const [id, value] of Object.entries(users)) {
          if (value && typeof value === "object") {
            const entry = value as Record<string, unknown>;
            if (typeof entry.AccountName === "string" && entry.AccountName.toLowerCase() === accountName.toLowerCase()) {
              steamId = id;
              break;
            }
          }
        }
      }
    } catch {
      // ignore — best effort
    }
  }
  return { accountName: accountName || undefined, steamId, isRunning };
}

async function killSteam(): Promise<void> {
  try {
    await execFileAsync("taskkill.exe", ["/IM", "steam.exe", "/F"], { windowsHide: true });
  } catch {
    // already gone
  }
  // Poll for exit (Steam writes config on shutdown).
  for (let i = 0; i < 30; i += 1) {
    if (!(await isSteamRunning())) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function startSteam(steamRoot: string): Promise<void> {
  const exe = join(steamRoot, "Steam.exe");
  if (!existsSync(exe)) {
    throw new Error(`Steam.exe not found at ${exe}`);
  }
  // Detach so the launcher doesn't keep the Steam process tied to its lifetime.
  const child = (await import("node:child_process")).spawn(exe, ["-silent"], {
    cwd: steamRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

export type SwitchSteamAccountInput = {
  steamId: string;
  accountName: string;
  /** When true, restart Steam after switching (default true). */
  restart?: boolean;
};

export async function switchSteamAccount(input: SwitchSteamAccountInput): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("Steam account switching is only supported on Windows.");
  }

  const root = findSteamRoot();
  if (!root) {
    throw new Error("Could not locate the Steam install directory.");
  }

  const file = await readLoginUsersFile(root);
  if (!file) {
    throw new Error(`loginusers.vdf was not found under ${root}.`);
  }

  // Steam holds loginusers.vdf open while running; close first.
  if (await isSteamRunning()) {
    await killSteam();
  }

  const updated = computeUpdatedLoginUsers(file.root, input.steamId);
  await writeLoginUsers(file.path, updated);
  await regWriteString("AutoLoginUser", input.accountName);
  await regWriteDword("RememberPassword", 1);

  if (input.restart !== false) {
    await startSteam(root);
  }
}
