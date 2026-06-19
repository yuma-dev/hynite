import type { GameMetadataPatch, ImportedGame, ProfileSink } from "@hynite/core";
import { fetchSteamAppInfoMetadata, fetchSteamCdnArtworkMetadata, fetchSteamMetadata, isSteamRateLimitError } from "./steam";

export type MetadataProviderId = "steam-store" | "steam-appinfo" | "steam-cdn" | "steamgriddb";

export type MetadataProvider = {
  id: MetadataProviderId;
  label: string;
  refresh(game: ImportedGame): Promise<GameMetadataPatch>;
};

export type MetadataLog = {
  level: "info" | "warning" | "error";
  providerId: MetadataProviderId;
  gameTitle: string;
  appid: string;
  message: string;
  details?: Record<string, unknown>;
};

export type MetadataLogger = (entry: MetadataLog) => void;

function mergePatch(base: GameMetadataPatch, next: GameMetadataPatch): GameMetadataPatch {
  const merged: GameMetadataPatch = {
    title: base.title ?? next.title,
    sortTitle: base.sortTitle ?? next.sortTitle,
    coverUrl: base.coverUrl ?? next.coverUrl,
    backgroundUrl: base.backgroundUrl ?? next.backgroundUrl,
    logoUrl: base.logoUrl ?? next.logoUrl,
    communityIconUrl: base.communityIconUrl ?? next.communityIconUrl,
    libraryCapsuleUrl: base.libraryCapsuleUrl ?? next.libraryCapsuleUrl,
    headerUrl: base.headerUrl ?? next.headerUrl,
    trailerUrl: base.trailerUrl ?? next.trailerUrl,
    trailerPosterUrl: base.trailerPosterUrl ?? next.trailerPosterUrl,
    screenshots: base.screenshots?.length ? base.screenshots : next.screenshots,
    shortDescription: base.shortDescription ?? next.shortDescription,
    aboutText: base.aboutText ?? next.aboutText,
    websiteUrl: base.websiteUrl ?? next.websiteUrl,
    supportUrl: base.supportUrl ?? next.supportUrl,
    platforms: base.platforms ?? next.platforms,
    achievementCount: base.achievementCount ?? next.achievementCount,
    recommendationCount: base.recommendationCount ?? next.recommendationCount,
    contentDescriptors: base.contentDescriptors?.length ? base.contentDescriptors : next.contentDescriptors,
    discovery: base.discovery ?? next.discovery,
    genres: base.genres?.length ? base.genres : next.genres,
    tags: base.tags?.length ? base.tags : next.tags,
    playerModes: base.playerModes?.length ? base.playerModes : next.playerModes,
    developers: base.developers?.length ? base.developers : next.developers,
    publishers: base.publishers?.length ? base.publishers : next.publishers,
    releaseDate: base.releaseDate ?? next.releaseDate,
    releaseDateText: base.releaseDate || base.releaseDateText ? base.releaseDateText : next.releaseDateText,
    releasePrecision: base.releaseDate || base.releasePrecision ? base.releasePrecision : next.releasePrecision,
    metadataStatus: base.metadataStatus === "complete" || next.metadataStatus === "complete" ? "complete" : (base.metadataStatus ?? next.metadataStatus)
  };

  return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined)) as GameMetadataPatch;
}

export async function fetchSteamAppInfoMetadataWithNativeFallback(
  game: ImportedGame,
  fetchImpl: typeof fetch,
  logger?: MetadataLogger,
  nativeProvider?: (game: ImportedGame) => Promise<GameMetadataPatch | undefined>,
  rawMetadataRecorder?: (game: ImportedGame, source: string, raw: unknown) => void | Promise<void>
): Promise<GameMetadataPatch> {
  const nativePatch = await nativeProvider?.(game);
  if (nativePatch && Object.keys(nativePatch).length > 0) {
    logger?.({
      level: "info",
      providerId: "steam-appinfo",
      gameTitle: game.title,
      appid: game.externalId,
      message: "Steam appinfo loaded through native SteamKit"
    });

    if (nativePatch.libraryCapsuleUrl) {
      return nativePatch;
    }

    const httpPatch = await fetchSteamAppInfoMetadata(game.externalId, fetchImpl, logger, game.title, (raw) =>
      rawMetadataRecorder?.(game, "steam_appinfo", raw)
    );
    return Object.keys(httpPatch).length > 0 ? mergePatch(nativePatch, httpPatch) : nativePatch;
  }

  return fetchSteamAppInfoMetadata(game.externalId, fetchImpl, logger, game.title, (raw) => rawMetadataRecorder?.(game, "steam_appinfo", raw));
}

function providerSkipReason(provider: MetadataProvider, fused: GameMetadataPatch): string | undefined {
  if (provider.id === "steam-cdn") {
    return !fused.coverUrl || !fused.backgroundUrl || !fused.headerUrl ? undefined : "art fields already filled";
  }

  if (provider.id === "steamgriddb") {
    return !fused.libraryCapsuleUrl ? undefined : "library capsule already filled";
  }

  return undefined;
}

function shouldRunProvider(provider: MetadataProvider, fused: GameMetadataPatch): boolean {
  return !providerSkipReason(provider, fused);
}

export const steamStoreMetadataProvider: MetadataProvider = {
  id: "steam-store",
  label: "Steam Store",
  refresh: (game) => fetchSteamMetadata(game.externalId, fetch, undefined, game.title)
};

function createSteamStoreMetadataProvider(
  logger?: MetadataLogger,
  rawMetadataRecorder?: (game: ImportedGame, source: string, raw: unknown) => void | Promise<void>
): MetadataProvider {
  return {
    id: "steam-store",
    label: "Steam Store",
    refresh: (game) => fetchSteamMetadata(game.externalId, fetch, logger, game.title, (raw) => rawMetadataRecorder?.(game, "steam_appdetails", raw))
  };
}

export const steamAppInfoMetadataProvider: MetadataProvider = {
  id: "steam-appinfo",
  label: "Steam appinfo",
  refresh: (game) => fetchSteamAppInfoMetadata(game.externalId, fetch, undefined, game.title)
};

function createSteamAppInfoMetadataProvider(
  logger?: MetadataLogger,
  nativeProvider?: (game: ImportedGame) => Promise<GameMetadataPatch | undefined>,
  rawMetadataRecorder?: (game: ImportedGame, source: string, raw: unknown) => void | Promise<void>
): MetadataProvider {
  return {
    id: "steam-appinfo",
    label: "Steam appinfo",
    async refresh(game) {
      return fetchSteamAppInfoMetadataWithNativeFallback(game, fetch, logger, nativeProvider, rawMetadataRecorder);
    }
  };
}

function createSteamCdnArtworkProvider(logger?: MetadataLogger): MetadataProvider {
  return {
    id: "steam-cdn",
    label: "Steam CDN artwork",
    async refresh(game) {
      return fetchSteamCdnArtworkMetadata(game.externalId, fetch, logger, game.title);
    }
  };
}

export const steamCdnArtworkProvider: MetadataProvider = createSteamCdnArtworkProvider();

type SteamGridDbGrid = {
  id?: number;
  score?: number;
  url?: string;
  thumb?: string;
  width?: number;
  height?: number;
  nsfw?: boolean;
  humor?: boolean;
  style?: string;
  mime?: string;
  types?: string[];
};

type SteamGridDbResponse = {
  success?: boolean;
  data?: SteamGridDbGrid[];
};

function chooseSteamGridDbGrid(grids: SteamGridDbGrid[]): SteamGridDbGrid | undefined {
  const usable = grids.filter((grid) => grid.url && !grid.nsfw && !grid.humor);
  const exact = usable.filter((grid) => (grid.width === 600 && grid.height === 900) || (grid.width === 300 && grid.height === 450));
  const vertical = usable.filter((grid) => (grid.height ?? 0) > (grid.width ?? Number.MAX_SAFE_INTEGER));
  return [...(exact.length ? exact : vertical)].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
}

type SteamGridDbGame = {
  id?: number;
  name?: string;
  types?: string[];
  verified?: boolean;
};

type SteamGridDbSearchResponse = {
  success?: boolean;
  data?: SteamGridDbGame[];
};

function chooseSteamGridDbGame(games: SteamGridDbGame[], title: string): SteamGridDbGame | undefined {
  const normalizedTitle = title.trim().toLocaleLowerCase();
  return games.find((game) => game.name?.trim().toLocaleLowerCase() === normalizedTitle) ?? games[0];
}

export function createSteamGridDbArtworkProvider(apiKey: string, fetchImpl: typeof fetch = fetch, logger?: MetadataLogger): MetadataProvider {
  return {
    id: "steamgriddb",
    label: "SteamGridDB artwork",
    async refresh(game) {
      const appid = encodeURIComponent(game.externalId);
      const encodedTitle = encodeURIComponent(game.title);
      const headers = { Authorization: `Bearer ${apiKey}` };
      const appidRequests = [
        `https://www.steamgriddb.com/api/v2/grids/steam/${appid}?dimensions=600x900&types=static`,
        `https://www.steamgriddb.com/api/v2/grids/steam/${appid}?types=static`
      ];

      for (const url of appidRequests) {
        const response = await fetchImpl(url, { headers });
        if (!response.ok) {
          logger?.({
            level: "warning",
            providerId: "steamgriddb",
            gameTitle: game.title,
            appid: game.externalId,
            message: "SteamGridDB artwork request failed",
            details: { requested: url, status: response.status, statusText: response.statusText }
          });
          continue;
        }

        const json = (await response.json()) as SteamGridDbResponse;
        const grid = chooseSteamGridDbGrid(json.data ?? []);
        if (grid?.url) {
          return {
            coverUrl: grid.url,
            libraryCapsuleUrl: grid.url,
            metadataStatus: "partial"
          };
        }
        logger?.({
          level: "warning",
          providerId: "steamgriddb",
          gameTitle: game.title,
          appid: game.externalId,
          message: "SteamGridDB returned no usable vertical static artwork",
          details: {
            requested: url,
            returned: json.data?.map((item) => ({
              url: item.url,
              width: item.width,
              height: item.height,
              score: item.score,
              nsfw: item.nsfw,
              humor: item.humor
            }))
          }
        });
      }

      const searchUrl = `https://www.steamgriddb.com/api/v2/search/autocomplete/${encodedTitle}`;
      const searchResponse = await fetchImpl(searchUrl, { headers });
      if (!searchResponse.ok) {
        logger?.({
          level: "warning",
          providerId: "steamgriddb",
          gameTitle: game.title,
          appid: game.externalId,
          message: "SteamGridDB title search failed",
          details: { requested: searchUrl, status: searchResponse.status, statusText: searchResponse.statusText }
        });
        return {};
      }

      const searchJson = (await searchResponse.json()) as SteamGridDbSearchResponse;
      const foundGame = chooseSteamGridDbGame(searchJson.data ?? [], game.title);
      if (!foundGame?.id) {
        logger?.({
          level: "warning",
          providerId: "steamgriddb",
          gameTitle: game.title,
          appid: game.externalId,
          message: "SteamGridDB title search returned no game match",
          details: {
            requested: searchUrl,
            returned: searchJson.data?.map((item) => ({ id: item.id, name: item.name, verified: item.verified, types: item.types }))
          }
        });
        return {};
      }

      const gameRequests = [
        `https://www.steamgriddb.com/api/v2/grids/game/${foundGame.id}?dimensions=600x900&types=static`,
        `https://www.steamgriddb.com/api/v2/grids/game/${foundGame.id}?types=static`
      ];

      for (const url of gameRequests) {
        const response = await fetchImpl(url, { headers });
        if (!response.ok) {
          logger?.({
            level: "warning",
            providerId: "steamgriddb",
            gameTitle: game.title,
            appid: game.externalId,
            message: "SteamGridDB artwork request failed",
            details: { requested: url, status: response.status, statusText: response.statusText, gameId: foundGame.id, gameName: foundGame.name }
          });
          continue;
        }

        const json = (await response.json()) as SteamGridDbResponse;
        const grid = chooseSteamGridDbGrid(json.data ?? []);
        if (grid?.url) {
          return {
            coverUrl: grid.url,
            libraryCapsuleUrl: grid.url,
            metadataStatus: "partial"
          };
        }
        logger?.({
          level: "warning",
          providerId: "steamgriddb",
          gameTitle: game.title,
          appid: game.externalId,
          message: "SteamGridDB returned no usable vertical static artwork",
          details: {
            requested: url,
            gameId: foundGame.id,
            gameName: foundGame.name,
            returned: json.data?.map((item) => ({
              url: item.url,
              width: item.width,
              height: item.height,
              score: item.score,
              nsfw: item.nsfw,
              humor: item.humor
            }))
          }
        });
      }

      return {};
    }
  };
}

export type MetadataFusionOptions = {
  steamGridDbApiKey?: string;
  logger?: MetadataLogger;
  steamAppInfoProvider?: (game: ImportedGame) => Promise<GameMetadataPatch | undefined>;
  rawMetadataRecorder?: (game: ImportedGame, source: string, raw: unknown) => void | Promise<void>;
  mode?: "fast" | "full";
  profiler?: ProfileSink;
};

export function defaultMetadataProviders(options: MetadataFusionOptions = {}): MetadataProvider[] {
  const fastProviders = [
    createSteamAppInfoMetadataProvider(options.logger, options.steamAppInfoProvider, options.rawMetadataRecorder),
    createSteamCdnArtworkProvider(options.logger),
    ...(options.steamGridDbApiKey ? [createSteamGridDbArtworkProvider(options.steamGridDbApiKey, fetch, options.logger)] : [])
  ];

  if (options.mode === "fast") {
    return fastProviders;
  }

  return [createSteamStoreMetadataProvider(options.logger, options.rawMetadataRecorder), ...fastProviders];
}

export async function refreshFusedMetadata(
  game: ImportedGame,
  providersOrOptions: MetadataProvider[] | MetadataFusionOptions = defaultMetadataProviders()
): Promise<GameMetadataPatch> {
  const providers = Array.isArray(providersOrOptions) ? providersOrOptions : defaultMetadataProviders(providersOrOptions);
  let fused: GameMetadataPatch = {};

  for (const provider of providers) {
    if (!shouldRunProvider(provider, fused)) {
      if (!Array.isArray(providersOrOptions)) {
        providersOrOptions.profiler?.point("metadata", "metadata:provider-skipped", {
          provider: provider.id,
          providerId: provider.id,
          appid: game.externalId,
          title: game.title,
          reason: providerSkipReason(provider, fused)
        });
      }
      continue;
    }

    const span = !Array.isArray(providersOrOptions)
      ? providersOrOptions.profiler?.startSpan("metadata", "metadata:provider", {
          provider: provider.id,
          providerId: provider.id,
          appid: game.externalId,
          title: game.title
        })
      : undefined;
    try {
      const patch = await provider.refresh(game);
      if (patch.metadataStatus === "failed") {
        span?.end("ok", {
          provider: provider.id,
          providerId: provider.id,
          appid: game.externalId,
          title: game.title,
          status: "failed",
          fields: Object.keys(patch)
        });
        continue;
      }

      fused = mergePatch(fused, patch);
      span?.end("ok", {
        provider: provider.id,
        providerId: provider.id,
        appid: game.externalId,
        title: game.title,
        status: Object.keys(patch).length > 0 ? "ok" : "empty",
        fields: Object.keys(patch),
        suppliedLibraryCapsuleUrl: Boolean(patch.libraryCapsuleUrl),
        suppliedLogoUrl: Boolean(patch.logoUrl),
        suppliedBackgroundUrl: Boolean(patch.backgroundUrl),
        suppliedHeaderUrl: Boolean(patch.headerUrl)
      });
    } catch (error) {
      if (isSteamRateLimitError(error)) {
        span?.end("error", {
          provider: provider.id,
          providerId: provider.id,
          appid: game.externalId,
          title: game.title,
          status: "rate-limited",
          retryAfterMs: error.retryAfterMs
        });
        if (!Array.isArray(providersOrOptions)) {
          providersOrOptions.logger?.({
            level: "warning",
            providerId: provider.id,
            gameTitle: game.title,
            appid: game.externalId,
            message: `${provider.label} is rate limited`,
            details: { retryAfterMs: error.retryAfterMs }
          });
        }
        throw error;
      }

      span?.end("error", {
        provider: provider.id,
        providerId: provider.id,
        appid: game.externalId,
        title: game.title,
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      });
      if (!Array.isArray(providersOrOptions)) {
        providersOrOptions.logger?.({
          level: "error",
          providerId: provider.id,
          gameTitle: game.title,
          appid: game.externalId,
          message: `${provider.label} failed`,
          details: { error: error instanceof Error ? error.message : String(error) }
        });
      }
      continue;
    }
  }

  return Object.keys(fused).length > 0 ? fused : { metadataStatus: "failed" };
}
