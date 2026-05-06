import type { GameMetadataPatch } from "@hynite/core";

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

export async function fetchSteamMetadata(appid: string, fetchImpl: typeof fetch = fetch): Promise<GameMetadataPatch> {
  try {
    const response = await fetchImpl(`https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(appid)}&cc=us&l=english`);
    if (!response.ok) {
      return { metadataStatus: "failed" };
    }

    const json = (await response.json()) as SteamAppDetailsResponse;
    const details = json[appid];
    if (!details?.success || !details.data) {
      return { metadataStatus: "failed" };
    }

    const data = details.data;
    const highlightedMovie = data.movies?.find((movie) => movie.highlight && movie.hls_h264) ?? data.movies?.find((movie) => movie.hls_h264);
    return {
      title: data.name,
      backgroundUrl: data.background_raw ?? data.background,
      headerUrl: data.header_image ?? data.capsule_imagev5 ?? data.capsule_image,
      trailerUrl: highlightedMovie?.hls_h264,
      trailerPosterUrl: highlightedMovie?.thumbnail,
      screenshots:
        data.screenshots
          ?.filter((screenshot) => screenshot.path_thumbnail && screenshot.path_full)
          .map((screenshot) => ({
            thumbnailUrl: screenshot.path_thumbnail as string,
            fullUrl: screenshot.path_full as string
          })) ?? [],
      shortDescription: stripHtml(data.short_description),
      aboutText: stripHtml(data.about_the_game ?? data.detailed_description),
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
      developers: data.developers ?? [],
      publishers: data.publishers ?? [],
      releaseDate: parseSteamDate(data.release_date?.date),
      metadataStatus: "complete"
    };
  } catch {
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
        header_image?: string | Record<string, string>;
        library_assets_full?: {
          library_capsule?: { image?: Record<string, string>; image2x?: Record<string, string> };
          library_hero?: { image?: Record<string, string>; image2x?: Record<string, string> };
          library_logo?: { image?: Record<string, string>; image2x?: Record<string, string> };
        };
      };
    }
  >;
};

function chooseLocalizedAsset(values: string | Record<string, string> | undefined): string | undefined {
  if (typeof values === "string") {
    return values;
  }

  return values?.english ?? values?.en ?? Object.values(values ?? {})[0];
}

function assetUrl(appid: string, path: string | undefined): string | undefined {
  return path ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${encodeURIComponent(appid)}/${path}` : undefined;
}

export async function fetchSteamAppInfoMetadata(appid: string, fetchImpl: typeof fetch = fetch): Promise<GameMetadataPatch> {
  try {
    const response = await fetchImpl(`https://api.steamcmd.net/v1/info/${encodeURIComponent(appid)}`);
    if (!response.ok) {
      return {};
    }

    const json = (await response.json()) as SteamAppInfoResponse;
    const common = json.data?.[appid]?.common;
    const capsule = common?.library_assets_full?.library_capsule;
    const hero = common?.library_assets_full?.library_hero;
    const capsuleUrl = assetUrl(appid, chooseLocalizedAsset(capsule?.image2x) ?? chooseLocalizedAsset(capsule?.image));
    const heroUrl = assetUrl(appid, chooseLocalizedAsset(hero?.image2x) ?? chooseLocalizedAsset(hero?.image));
    const headerPath = chooseLocalizedAsset(common?.header_image);
    const clientIconUrl = common?.clienticon
      ? `https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/${encodeURIComponent(appid)}/${common.clienticon}.ico`
      : common?.icon
        ? `https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/${encodeURIComponent(appid)}/${common.icon}.jpg`
        : undefined;

    return {
      title: common?.name,
      coverUrl: capsuleUrl,
      libraryCapsuleUrl: capsuleUrl,
      backgroundUrl: heroUrl,
      headerUrl: assetUrl(appid, headerPath),
      communityIconUrl: clientIconUrl,
      metadataStatus: capsuleUrl || heroUrl || common?.name ? "partial" : undefined
    };
  } catch {
    return {};
  }
}
