import type { GameMetadataPatch, ImportedGame, ImporterProvider } from "@hynite/core";
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
};

export class SteamImporterProvider implements ImporterProvider {
  readonly id = "steam" as const;
  readonly label = "Steam";

  constructor(private readonly options: SteamProviderOptions = {}) {}

  async scan(): Promise<ImportedGame[]> {
    if (!this.options.account?.steamId || !this.options.account.webApiKey) {
      throw new Error("Steam sync requires a paired Steam account and Steam Web API key.");
    }

    const ownedGames = await fetchOwnedSteamGames({
      steamId: this.options.account.steamId,
      webApiKey: this.options.account.webApiKey,
      includePlayedFreeGames: this.options.includePlayedFreeGames,
      signal: this.options.signal
    });

    const familyToken = this.options.account.familyAccessToken;
    if (!familyToken) {
      this.options.familyScanResult?.({ status: "skipped" });
      return ownedGames;
    }

    const log = this.options.scanLogger;
    try {
      const familyGroupId = await fetchFamilyGroupId({
        accessToken: familyToken,
        steamId: this.options.account.steamId,
        signal: this.options.signal
      });

      if (!familyGroupId) {
        log?.("info", "Steam family group not found for paired account; skipping family-shared scan.");
        this.options.familyScanResult?.({ status: "not-member" });
        return ownedGames;
      }

      const sharedGames = await fetchFamilySharedGames({
        accessToken: familyToken,
        steamId: this.options.account.steamId,
        familyGroupId,
        signal: this.options.signal
      });

      const ownedAppIds = new Set(ownedGames.map((game) => game.externalId));
      const dedupedShared = sharedGames.filter((game) => !ownedAppIds.has(game.externalId));

      this.options.familyScanResult?.({ status: "complete" });
      return [...ownedGames, ...dedupedShared];
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
      return ownedGames;
    }
  }

  async refreshMetadata(game: ImportedGame): Promise<GameMetadataPatch> {
    return refreshFusedMetadata(game, {
      steamGridDbApiKey: this.options.steamGridDbApiKey,
      logger: this.options.metadataLogger,
      steamAppInfoProvider: this.options.steamAppInfoProvider,
      rawMetadataRecorder: this.options.rawMetadataRecorder,
      mode: this.options.metadataMode
    });
  }
}
