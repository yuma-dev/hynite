import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SteamLocalAccount } from "@hynite/core";
import { findSteamRoot } from "./localInstall";
import { objectValue, parseVdf, stringifyVdf, stringValue, type VdfObject } from "./vdf";

export type LoginUsersFile = {
  path: string;
  root: VdfObject;
};

export function parseLoginUsers(input: string): SteamLocalAccount[] {
  const parsed = parseVdf(input);
  const users = objectValue(parsed.users);
  if (!users) {
    return [];
  }

  const accounts: SteamLocalAccount[] = [];
  for (const [steamId, value] of Object.entries(users)) {
    const entry = objectValue(value);
    if (!entry) {
      continue;
    }
    const accountName = stringValue(entry.AccountName);
    if (!accountName) {
      continue;
    }
    const mostRecentRaw = stringValue(entry.MostRecent);
    const timestampRaw = stringValue(entry.Timestamp);
    accounts.push({
      steamId,
      accountName,
      personaName: stringValue(entry.PersonaName),
      mostRecent: mostRecentRaw === "1",
      timestamp: timestampRaw ? Number(timestampRaw) : undefined
    });
  }

  return accounts.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}

export function loginUsersPath(steamRoot: string): string {
  return join(steamRoot, "config", "loginusers.vdf");
}

export async function readLoginUsers(steamRoot?: string): Promise<{ accounts: SteamLocalAccount[]; path?: string }> {
  const root = steamRoot ?? findSteamRoot();
  if (!root) {
    return { accounts: [] };
  }
  const path = loginUsersPath(root);
  if (!existsSync(path)) {
    return { accounts: [], path };
  }
  const text = await readFile(path, "utf8");
  return { accounts: parseLoginUsers(text), path };
}

/**
 * Pure helper used by the switcher service. Given the parsed VDF root and a target
 * SteamID, return a new VDF tree with `MostRecent` flipped to "1" on the target user
 * (and "0" elsewhere) and the target's `Timestamp` bumped to `now`.
 */
export function computeUpdatedLoginUsers(root: VdfObject, targetSteamId: string, now: number = Math.floor(Date.now() / 1000)): VdfObject {
  const cloned = JSON.parse(JSON.stringify(root)) as VdfObject;
  const users = objectValue(cloned.users);
  if (!users) {
    return cloned;
  }

  for (const [steamId, value] of Object.entries(users)) {
    const entry = objectValue(value);
    if (!entry) {
      continue;
    }
    if (steamId === targetSteamId) {
      entry.MostRecent = "1";
      entry.Timestamp = String(now);
      entry.RememberPassword = "1";
    } else if (entry.MostRecent === "1") {
      entry.MostRecent = "0";
    }
  }

  return cloned;
}

export async function writeLoginUsers(path: string, root: VdfObject): Promise<void> {
  // Steam's loginusers.vdf has root key "users" — preserve it.
  await writeFile(path, stringifyVdf(root), "utf8");
}

export async function readLoginUsersFile(steamRoot?: string): Promise<LoginUsersFile | undefined> {
  const root = steamRoot ?? findSteamRoot();
  if (!root) {
    return undefined;
  }
  const path = loginUsersPath(root);
  if (!existsSync(path)) {
    return undefined;
  }
  const text = await readFile(path, "utf8");
  return { path, root: parseVdf(text) };
}
