import { type GameMetadataPatch, playerModesFromSteamCategories } from "@hynite/core";

export type SteamMetadataProviderId = "steam-store" | "steam-appinfo" | "steam-cdn" | "steamgriddb";

export type SteamMetadataLog = {
  level: "info" | "warning" | "error";
  providerId: SteamMetadataProviderId;
  gameTitle: string;
  appid: string;
  message: string;
  details?: Record<string, unknown>;
};

export type SteamMetadataLogger = (entry: SteamMetadataLog) => void;
export type RawSteamMetadataRecorder = (raw: unknown) => void | Promise<void>;

const STEAM_REQUEST_MIN_INTERVAL_MS = 900;
const STEAM_RETRY_DELAYS_MS = [5_000, 15_000, 45_000];

let steamRequestQueue = Promise.resolve();
let lastSteamRequestStartedAt = 0;

export class SteamRateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "SteamRateLimitError";
  }
}

export function isSteamRateLimitError(error: unknown): error is SteamRateLimitError {
  return error instanceof SteamRateLimitError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(response: Response): number | undefined {
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) {
    return undefined;
  }

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const date = Date.parse(retryAfter);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

async function scheduleSteamRequest<T>(request: () => Promise<T>): Promise<T> {
  const previous = steamRequestQueue;
  let release: () => void = () => undefined;
  steamRequestQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous.catch(() => undefined);
  const waitMs = Math.max(0, STEAM_REQUEST_MIN_INTERVAL_MS - (Date.now() - lastSteamRequestStartedAt));
  if (waitMs > 0) {
    await sleep(waitMs);
  }
  lastSteamRequestStartedAt = Date.now();

  try {
    return await request();
  } finally {
    release();
  }
}

export async function steamRateLimitedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt <= STEAM_RETRY_DELAYS_MS.length; attempt += 1) {
    const response = await scheduleSteamRequest(() => fetch(input, init));
    if (response.status !== 429) {
      return response;
    }

    const delayMs = retryAfterMs(response) ?? STEAM_RETRY_DELAYS_MS[attempt];
    if (attempt >= STEAM_RETRY_DELAYS_MS.length || delayMs === undefined) {
      throw new SteamRateLimitError("Steam returned 429 Too Many Requests", delayMs);
    }

    await sleep(delayMs);
  }

  throw new SteamRateLimitError("Steam returned 429 Too Many Requests");
}

function steamFetch(fetchImpl: typeof fetch): typeof fetch {
  return fetchImpl === fetch ? (steamRateLimitedFetch as typeof fetch) : fetchImpl;
}

type SteamAppDetailsResponse = Record<
  string,
  {
    success: boolean;
    data?: {
      type?: string;
      name?: string;
      steam_appid?: number;
      required_age?: number;
      is_free?: boolean;
      detailed_description?: string;
      about_the_game?: string;
      short_description?: string;
      header_image?: string;
      capsule_image?: string;
      capsule_imagev5?: string;
      background_raw?: string;
      background?: string;
      developers?: string[];
      publishers?: string[];
      genres?: Array<{ id: string; description: string }>;
      categories?: Array<{ id: number; description: string }>;
      screenshots?: Array<{ id: number; path_thumbnail?: string; path_full?: string }>;
      movies?: Array<{
        id: number;
        name?: string;
        thumbnail?: string;
        hls_h264?: string;
        mp4?: { "480"?: string; max?: string };
        webm?: { "480"?: string; max?: string };
        highlight?: boolean;
      }>;
      recommendations?: { total?: number };
      achievements?: { total?: number };
      release_date?: { coming_soon?: boolean; date?: string };
      website?: string;
      support_info?: { url?: string };
      platforms?: { windows?: boolean; mac?: boolean; linux?: boolean };
      content_descriptors?: { notes?: string };
    };
  }
>;

type SteamMovie = NonNullable<NonNullable<SteamAppDetailsResponse[string]["data"]>["movies"]>[number];

function parseSteamDate(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const exactEnglishDate = /^(?<month>[A-Za-z]+)\s+(?<day>\d{1,2}),\s+(?<year>\d{4})$/.exec(value);
  if (exactEnglishDate?.groups?.month && exactEnglishDate.groups.day && exactEnglishDate.groups.year) {
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const monthIndex = months.indexOf(exactEnglishDate.groups.month.slice(0, 3).toLocaleLowerCase());
    if (monthIndex >= 0) {
      const day = Number(exactEnglishDate.groups.day);
      const year = Number(exactEnglishDate.groups.year);
      return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
    }
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }

  return new Date(parsed).toISOString().slice(0, 10);
}

function stripHtml(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|ul)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function movieUrl(movie: SteamMovie | undefined): string | undefined {
  return movie?.mp4?.max ?? movie?.mp4?.["480"] ?? movie?.webm?.max ?? movie?.webm?.["480"] ?? movie?.hls_h264;
}

export function metadataFromSteamAppDetailsResponse(
  appid: string,
  json: unknown,
  logger?: SteamMetadataLogger,
  gameTitle = appid
): GameMetadataPatch {
  const details = (json as SteamAppDetailsResponse | undefined)?.[appid];
  if (!details?.success || !details.data) {
    logger?.({
      level: "warning",
      providerId: "steam-store",
      gameTitle,
      appid,
      message: "Steam appdetails returned no game details",
      details: { success: details?.success, returnedKeys: details?.data ? Object.keys(details.data) : [] }
    });
    return { metadataStatus: "failed" };
  }

  const data = details.data;
  const highlightedMovie = data.movies?.find((movie) => movie.highlight && movieUrl(movie)) ?? data.movies?.find((movie) => movieUrl(movie));
  return {
    title: data.name,
    backgroundUrl: data.background_raw ?? data.background,
    headerUrl: data.header_image ?? data.capsule_imagev5 ?? data.capsule_image,
    trailerUrl: movieUrl(highlightedMovie),
    trailerPosterUrl: highlightedMovie?.thumbnail,
    screenshots:
      data.screenshots
        ?.filter((screenshot) => screenshot.path_thumbnail && screenshot.path_full)
        .map((screenshot) => ({
          thumbnailUrl: screenshot.path_thumbnail as string,
          fullUrl: screenshot.path_full as string
        })) ?? [],
    shortDescription: stripHtml(data.short_description),
    aboutText: data.about_the_game ?? data.detailed_description,
    websiteUrl: data.website,
    supportUrl: data.support_info?.url,
    platforms: data.platforms
      ? {
          windows: Boolean(data.platforms.windows),
          mac: Boolean(data.platforms.mac),
          linux: Boolean(data.platforms.linux)
        }
      : undefined,
    achievementCount: data.achievements?.total,
    recommendationCount: data.recommendations?.total,
    contentDescriptors: data.content_descriptors?.notes ? [stripHtml(data.content_descriptors.notes) ?? data.content_descriptors.notes] : [],
    genres: data.genres?.map((genre) => genre.description) ?? [],
    tags: data.categories?.map((category) => category.description) ?? [],
    playerModes: playerModesFromSteamCategories(data.categories),
    developers: data.developers ?? [],
    publishers: data.publishers ?? [],
    releaseDate: parseSteamDate(data.release_date?.date),
    metadataStatus: "complete"
  };
}

export async function fetchSteamMetadata(
  appid: string,
  fetchImpl: typeof fetch = fetch,
  logger?: SteamMetadataLogger,
  gameTitle = appid,
  rawRecorder?: RawSteamMetadataRecorder
): Promise<GameMetadataPatch> {
  const requestFetch = steamFetch(fetchImpl);
  try {
    const response = await requestFetch(`https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(appid)}&cc=us&l=english`);
    if (!response.ok) {
      logger?.({
        level: "warning",
        providerId: "steam-store",
        gameTitle,
        appid,
        message: "Steam appdetails request failed",
        details: { status: response.status, statusText: response.statusText }
      });
      return { metadataStatus: "failed" };
    }

    const json = (await response.json()) as SteamAppDetailsResponse;
    await rawRecorder?.(json);
    return metadataFromSteamAppDetailsResponse(appid, json, logger, gameTitle);
  } catch (error) {
    if (isSteamRateLimitError(error)) {
      logger?.({
        level: "warning",
        providerId: "steam-store",
        gameTitle,
        appid,
        message: "Steam appdetails is rate limited",
        details: { retryAfterMs: error.retryAfterMs }
      });
      throw error;
    }

    logger?.({
      level: "error",
      providerId: "steam-store",
      gameTitle,
      appid,
      message: "Steam appdetails metadata failed",
      details: { error: error instanceof Error ? error.message : String(error) }
    });
    return { metadataStatus: "failed" };
  }
}

type SteamAppInfoResponse = {
  data?: Record<
    string,
    {
      common?: {
        name?: string;
        type?: string;
        parent?: string;
        clienticon?: string;
        icon?: string;
        steam_release_date?: string;
        header_image?: string | Record<string, string>;
        small_capsule?: string | Record<string, string>;
        associations?: Record<string, SteamAppInfoAssociation> | SteamAppInfoAssociation[];
        library_assets_full?: {
          library_capsule?: { image?: Record<string, string>; image2x?: Record<string, string> };
          library_hero?: { image?: Record<string, string>; image2x?: Record<string, string> };
          library_logo?: { image?: Record<string, string>; image2x?: Record<string, string> };
        };
        library_assets?: Record<string, unknown>;
      };
      extended?: SteamAppInfoExtended;
    }
  >;
};

type SteamAppInfoAssociation = {
  name?: string;
  type?: string;
};

type SteamAppInfoExtended = {
  developer?: string;
  publisher?: string;
  homepage?: string;
};

export type SteamAppInfoAsset = {
  image?: Record<string, string>;
  image2x?: Record<string, string>;
};

export type SteamAppInfoCommon = {
  name?: string;
  type?: string;
  parent?: string;
  clienticon?: string;
  icon?: string;
  steam_release_date?: string;
  steamReleaseDate?: string;
  header_image?: string | Record<string, string>;
  headerImage?: string | Record<string, string>;
  small_capsule?: string | Record<string, string>;
  smallCapsule?: string | Record<string, string>;
  associations?: Record<string, SteamAppInfoAssociation> | SteamAppInfoAssociation[];
  library_assets_full?: {
    library_capsule?: SteamAppInfoAsset;
    library_hero?: SteamAppInfoAsset;
    library_logo?: SteamAppInfoAsset;
  };
  libraryAssetsFull?: {
    libraryCapsule?: SteamAppInfoAsset;
    libraryHero?: SteamAppInfoAsset;
    libraryLogo?: SteamAppInfoAsset;
  };
  library_assets?: Record<string, unknown>;
  libraryAssets?: Record<string, unknown>;
  extended?: SteamAppInfoExtended;
};

function chooseLocalizedAsset(values: string | Record<string, string> | undefined): string | undefined {
  if (typeof values === "string") {
    return values;
  }

  return values?.english ?? values?.en ?? Object.values(values ?? {})[0];
}

function assetUrl(appid: string, path: string | undefined): string | undefined {
  return path ? `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${encodeURIComponent(appid)}/${path}` : undefined;
}

function parseSteamReleaseTimestamp(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  if (/^\d+$/.test(value)) {
    const timestamp = Number(value);
    if (Number.isFinite(timestamp) && timestamp > 0) {
      return new Date(timestamp * 1000).toISOString().slice(0, 10);
    }
  }

  return parseSteamDate(value);
}

function splitAppInfoNames(value: string | undefined): string[] {
  return value
    ? value
        .split(/[;,]/)
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function appInfoAssociations(common: SteamAppInfoCommon | undefined): SteamAppInfoAssociation[] {
  if (!common?.associations) {
    return [];
  }

  return Array.isArray(common.associations) ? common.associations : Object.values(common.associations);
}

function appInfoAssociationNames(common: SteamAppInfoCommon | undefined, type: string): string[] {
  return appInfoAssociations(common)
    .filter((association) => association.type?.toLocaleLowerCase() === type)
    .map((association) => association.name?.trim())
    .filter((name): name is string => Boolean(name));
}

function summarizeAppInfoAssets(common: SteamAppInfoCommon | undefined): Record<string, unknown> {
  return {
    header_image: common?.header_image ?? common?.headerImage,
    small_capsule: common?.small_capsule ?? common?.smallCapsule,
    library_assets: common?.library_assets ?? common?.libraryAssets,
    library_assets_full: common?.library_assets_full ?? common?.libraryAssetsFull
  };
}

function appInfoLibraryAssets(common: SteamAppInfoCommon | undefined): {
  capsule?: SteamAppInfoAsset;
  hero?: SteamAppInfoAsset;
  logo?: SteamAppInfoAsset;
} {
  return {
    capsule: common?.library_assets_full?.library_capsule ?? common?.libraryAssetsFull?.libraryCapsule,
    hero: common?.library_assets_full?.library_hero ?? common?.libraryAssetsFull?.libraryHero,
    logo: common?.library_assets_full?.library_logo ?? common?.libraryAssetsFull?.libraryLogo
  };
}

export function metadataFromSteamAppInfo(
  appid: string,
  common: SteamAppInfoCommon | undefined,
  logger?: SteamMetadataLogger,
  gameTitle = appid
): GameMetadataPatch {
  if (!common) {
    logger?.({
      level: "warning",
      providerId: "steam-appinfo",
      gameTitle,
      appid,
      message: "Steam appinfo returned no common metadata"
    });
    return {};
  }

  const assets = appInfoLibraryAssets(common);
  const capsulePath = chooseLocalizedAsset(assets.capsule?.image) ?? chooseLocalizedAsset(assets.capsule?.image2x);
  const heroPath = chooseLocalizedAsset(assets.hero?.image) ?? chooseLocalizedAsset(assets.hero?.image2x);
  const logoPath = chooseLocalizedAsset(assets.logo?.image) ?? chooseLocalizedAsset(assets.logo?.image2x);
  const capsuleUrl = assetUrl(appid, capsulePath);
  const heroUrl = assetUrl(appid, heroPath);
  const logoUrl = assetUrl(appid, logoPath);
  const headerPath = chooseLocalizedAsset(common.header_image ?? common.headerImage);
  const headerUrl = assetUrl(appid, headerPath);
  const smallCapsuleUrl = assetUrl(appid, chooseLocalizedAsset(common.small_capsule ?? common.smallCapsule));
  const fallbackCoverUrl = capsuleUrl ?? headerUrl ?? smallCapsuleUrl;
  const fallbackBackgroundUrl = heroUrl ?? headerUrl;
  const developers = appInfoAssociationNames(common, "developer");
  const publishers = appInfoAssociationNames(common, "publisher");
  const extendedDevelopers = splitAppInfoNames(common.extended?.developer);
  const extendedPublishers = splitAppInfoNames(common.extended?.publisher);
  const clientIconUrl = common.clienticon
    ? `https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/${encodeURIComponent(appid)}/${common.clienticon}.ico`
    : common.icon
      ? `https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/${encodeURIComponent(appid)}/${common.icon}.jpg`
      : undefined;

  if (!capsuleUrl) {
    logger?.({
      level: "info",
      providerId: "steam-appinfo",
      gameTitle,
      appid,
      message: "Steam appinfo did not list library capsule assets",
      details: {
        availableAssets: summarizeAppInfoAssets(common)
      }
    });
  }

  return {
    title: common.name,
    coverUrl: fallbackCoverUrl,
    libraryCapsuleUrl: capsuleUrl,
    backgroundUrl: fallbackBackgroundUrl,
    logoUrl,
    headerUrl,
    communityIconUrl: clientIconUrl,
    developers: developers.length ? developers : extendedDevelopers.length ? extendedDevelopers : undefined,
    publishers: publishers.length ? publishers : extendedPublishers.length ? extendedPublishers : undefined,
    releaseDate: parseSteamReleaseTimestamp(common.steam_release_date ?? common.steamReleaseDate),
    websiteUrl: common.extended?.homepage,
    metadataStatus: fallbackCoverUrl || fallbackBackgroundUrl || logoUrl || common.name ? "partial" : undefined
  };
}

export async function fetchSteamAppInfoMetadata(
  appid: string,
  fetchImpl: typeof fetch = fetch,
  logger?: SteamMetadataLogger,
  gameTitle = appid,
  rawRecorder?: RawSteamMetadataRecorder
): Promise<GameMetadataPatch> {
  const requestFetch = steamFetch(fetchImpl);
  try {
    const response = await requestFetch(`https://api.steamcmd.net/v1/info/${encodeURIComponent(appid)}`);
    if (!response.ok) {
      logger?.({
        level: "warning",
        providerId: "steam-appinfo",
        gameTitle,
        appid,
        message: "Steam appinfo request failed",
        details: { status: response.status, statusText: response.statusText }
      });
      return {};
    }

    const json = (await response.json()) as SteamAppInfoResponse;
    await rawRecorder?.(json);
    const appInfo = json.data?.[appid];
    const common = appInfo?.common ? { ...appInfo.common, extended: appInfo.extended } : undefined;
    if (!common) {
      logger?.({
        level: "warning",
        providerId: "steam-appinfo",
        gameTitle,
        appid,
        message: "Steam appinfo returned no common metadata",
        details: { availableDataKeys: Object.keys(json.data ?? {}) }
      });
      return {};
    }

    return metadataFromSteamAppInfo(appid, common, logger, gameTitle);
  } catch (error) {
    if (isSteamRateLimitError(error)) {
      logger?.({
        level: "warning",
        providerId: "steam-appinfo",
        gameTitle,
        appid,
        message: "Steam appinfo is rate limited",
        details: { retryAfterMs: error.retryAfterMs }
      });
      throw error;
    }

    logger?.({
      level: "error",
      providerId: "steam-appinfo",
      gameTitle,
      appid,
      message: "Steam appinfo metadata failed",
      details: { error: error instanceof Error ? error.message : String(error) }
    });
    return {};
  }
}

export async function fetchSteamCdnArtworkMetadata(
  appid: string,
  fetchImpl: typeof fetch = fetch,
  logger?: SteamMetadataLogger,
  gameTitle = appid
): Promise<GameMetadataPatch> {
  const encodedAppid = encodeURIComponent(appid);
  const headerUrl = `https://cdn.akamai.steamstatic.com/steam/apps/${encodedAppid}/header.jpg`;
  logger?.({
    level: "info",
    providerId: "steam-cdn",
    gameTitle,
    appid,
    message: "Steam CDN header candidate selected without unverified library artwork",
    details: {
      candidates: [headerUrl]
    }
  });

  return {
    coverUrl: headerUrl,
    backgroundUrl: headerUrl,
    headerUrl,
    metadataStatus: "partial"
  };
}
