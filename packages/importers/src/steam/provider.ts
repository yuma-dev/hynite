import type { GameMetadataPatch, ImportedGame, ImporterProvider, ProfileSink } from "@hynite/core";
import { refreshFusedMetadata, type MetadataFusionOptions, type MetadataLogger } from "@hynite/metadata";
import { fetchOwnedSteamGames } from "./webApi";
import { fetchFamilyGroupId, fetchFamilySharedGames, SteamFamilyAuthError } from "./familyApi";

export type SteamScanLogger = (
  level: "info" | "warning" | "error",
  message: string,
  details?: Record<string, unknown>
) => void;

export type SteamFamilyScanStatus = "complete" | "skipped" | "not-member" | "auth-error" | "error";

export type SteamProviderOptions = {
  account?: {
    steamId: string;
    webApiKey: string;
    familyAccessToken?: string;
  };
  includePlayedFreeGames?: boolean;
  steamGridDbApiKey?: string;
  metadataLogger?: MetadataLogger;
  scanLogger?: SteamScanLogger;
  steamAppInfoProvider?: (game: ImportedGame) => Promise<GameMetadataPatch | undefined>;
  rawMetadataRecorder?: MetadataFusionOptions["rawMetadataRecorder"];
  metadataMode?: MetadataFusionOptions["mode"];
  signal?: AbortSignal;
  familyScanResult?: (result: { status: SteamFamilyScanStatus; error?: string }) => void;
  profiler?: ProfileSink;
};

export class SteamImporterProvider implements ImporterProvider {
  readonly id = "steam" as const;
  readonly label = "Steam";

  constructor(private readonly options: SteamProviderOptions = {}) {}

  async scan(): Promise<ImportedGame[]> {
    if (!this.options.account?.steamId || !this.options.account.webApiKey) {
      throw new Error("Steam sync requires a paired Steam account and Steam Web API key.");
    }

    const ownedSpan = this.options.profiler?.startSpan("steam-sync", "steam-sync:owned-games-api", {
      account: this.options.account.steamId
    });
    let ownedGames: ImportedGame[];
    try {
      ownedGames = await fetchOwnedSteamGames({
        steamId: this.options.account.steamId,
        webApiKey: this.options.account.webApiKey,
        includePlayedFreeGames: this.options.includePlayedFreeGames,
        signal: this.options.signal
      });
      ownedSpan?.end("ok", { account: this.options.account.steamId, count: ownedGames.length });
    } catch (error) {
      ownedSpan?.end("error", { account: this.options.account.steamId, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }

    const familyToken = this.options.account.familyAccessToken;
    if (!familyToken) {
      this.options.familyScanResult?.({ status: "skipped" });
      return filterSteamLibraryVariants(ownedGames);
    }

    const log = this.options.scanLogger;
    try {
      const groupSpan = this.options.profiler?.startSpan("steam-sync", "steam-sync:family-group-fetch", {
        account: this.options.account.steamId
      });
      let familyGroupId: string | undefined;
      try {
        familyGroupId = await fetchFamilyGroupId({
          accessToken: familyToken,
          steamId: this.options.account.steamId,
          signal: this.options.signal
        });
        groupSpan?.end("ok", { account: this.options.account.steamId, found: Boolean(familyGroupId) });
      } catch (error) {
        groupSpan?.end("error", { account: this.options.account.steamId, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }

      if (!familyGroupId) {
        log?.("info", "Steam family group not found for paired account; skipping family-shared scan.");
        this.options.familyScanResult?.({ status: "not-member" });
        return filterSteamLibraryVariants(ownedGames);
      }

      const sharedSpan = this.options.profiler?.startSpan("steam-sync", "steam-sync:family-shared-fetch", {
        account: this.options.account.steamId,
        familyGroupId
      });
      let sharedGames: ImportedGame[];
      try {
        sharedGames = await fetchFamilySharedGames({
          accessToken: familyToken,
          steamId: this.options.account.steamId,
          familyGroupId,
          signal: this.options.signal
        });
        sharedSpan?.end("ok", { account: this.options.account.steamId, familyGroupId, count: sharedGames.length });
      } catch (error) {
        sharedSpan?.end("error", { account: this.options.account.steamId, familyGroupId, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }

      const ownedAppIds = new Set(ownedGames.map((game) => game.externalId));
      const dedupedShared = sharedGames.filter((game) => !ownedAppIds.has(game.externalId));

      this.options.familyScanResult?.({ status: "complete" });
      return filterSteamLibraryVariants([...ownedGames, ...dedupedShared]);
    } catch (error) {
      if (error instanceof SteamFamilyAuthError) {
        log?.("warning", error.message, { code: error.code });
        this.options.familyScanResult?.({ status: "auth-error", error: error.message });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        log?.("warning", "Steam family-shared games scan failed; continuing with owned library only.", {
          error: message
        });
        this.options.familyScanResult?.({ status: "error", error: message });
      }
      return filterSteamLibraryVariants(ownedGames);
    }
  }

  async refreshMetadata(game: ImportedGame): Promise<GameMetadataPatch> {
    return refreshFusedMetadata(game, {
      steamGridDbApiKey: this.options.steamGridDbApiKey,
      logger: this.options.metadataLogger,
      steamAppInfoProvider: this.options.steamAppInfoProvider,
      rawMetadataRecorder: this.options.rawMetadataRecorder,
      mode: this.options.metadataMode,
      profiler: this.options.profiler
    });
  }
}

type SteamLibraryVariant = "demo" | "playtest";

function steamLibraryVariant(title: string): { baseTitle: string; variant?: SteamLibraryVariant } {
  const compact = title.replace(/\s+/g, " ").trim();
  const patterns: Array<[RegExp, SteamLibraryVariant]> = [
    [/\s*[-:–—]\s*(?:demo|playtest)\s*$/i, "demo"],
    [/\s*\((?:demo|playtest)\)\s*$/i, "demo"],
    [/\s*\[(?:demo|playtest)\]\s*$/i, "demo"],
    [/\s+(?:demo|playtest)\s*$/i, "demo"]
  ];

  for (const [pattern, fallbackVariant] of patterns) {
    const match = pattern.exec(compact);
    if (!match) continue;
    const variant = /playtest/i.test(match[0]) ? "playtest" : fallbackVariant;
    return { baseTitle: compact.slice(0, match.index).trim(), variant };
  }

  return { baseTitle: compact };
}

function normalizedSteamTitle(title: string): string {
  return title
    .toLocaleLowerCase()
    .replace(/['’]/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function filterSteamLibraryVariants(games: ImportedGame[]): ImportedGame[] {
  const parsed = games.map((game) => ({ game, ...steamLibraryVariant(game.title) }));
  const fullTitles = new Set(
    parsed
      .filter((entry) => !entry.variant)
      .map((entry) => normalizedSteamTitle(entry.baseTitle))
      .filter(Boolean)
  );

  return parsed
    .filter((entry) => !entry.variant || !fullTitles.has(normalizedSteamTitle(entry.baseTitle)))
    .map((entry) => entry.game);
}
