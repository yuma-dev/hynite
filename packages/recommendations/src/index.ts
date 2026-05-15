import { type Game, type GameDiscovery, type GameMetadataPatch, type HomeModel, type HomeTrendRow, type ImportedGame, gameActivityTime, makeGameId, makeSortTitle } from "@hynite/core";
import {
  createSteamGridDbArtworkProvider,
  fetchSteamAppInfoMetadataWithNativeFallback,
  fetchSteamCdnArtworkMetadata,
  fetchSteamMetadata,
  isSteamRateLimitError,
  refreshFusedMetadata,
  steamRateLimitedFetch,
  type MetadataLogger,
  type MetadataProvider
} from "@hynite/metadata";

type SteamChartItem = {
  appid: number;
  rank?: number;
  peak_in_game?: number;
};

type SteamChartsResponse = {
  response?: {
    ranks?: SteamChartItem[];
  };
};

type FeaturedItem = {
  id?: number;
  type?: number;
  name?: string;
  discounted?: boolean;
  discount_percent?: number;
  original_price?: number;
  final_price?: number;
  currency?: string;
  url?: string;
  header_image?: string;
  large_capsule_image?: string;
  small_capsule_image?: string;
};

type FeaturedCategory = {
  id?: string;
  name?: string;
  items?: FeaturedItem[];
};

type FeaturedCategoriesResponse = Record<string, FeaturedCategory | { status?: number }>;

type FeaturedResponse = {
  large_capsules?: FeaturedItem[];
  featured_win?: FeaturedItem[];
  featured_mac?: FeaturedItem[];
  featured_linux?: FeaturedItem[];
  status?: number;
};

type SteamSpyItem = {
  appid?: number;
  name?: string;
  developer?: string;
  publisher?: string;
  positive?: number;
  negative?: number;
  owners?: string;
  ccu?: number;
};

type Candidate = {
  appid: string;
  title?: string;
  headerUrl?: string;
  sources: Set<string>;
  trendRank?: number;
  featuredWeight: number;
  chartRank?: number;
  chartCcu?: number;
  steamSpyCcu?: number;
  owners?: string;
  positive?: number;
  negative?: number;
  discountPercent?: number;
  originalPrice?: number;
  finalPrice?: number;
  currency?: string;
  storeCategory?: string;
  storeUrl?: string;
  newnessWeight: number;
};

type DiscoverySources = {
  storeFeatured: Candidate[];
  featuredCategories: Candidate[];
  steamCharts: Candidate[];
  steamSpyTop: Candidate[];
  steamSpyTrending: Candidate[];
};

export type RecommendationLog = {
  level: "info" | "warning" | "error";
  phase: string;
  message: string;
  details?: Record<string, unknown>;
};

export type RecommendationLogger = (entry: RecommendationLog) => void;

export type BuildHomeOptions = {
  steamGridDbApiKey?: string;
  logger?: RecommendationLogger;
  steamAppInfoProvider?: (game: ImportedGame) => Promise<GameMetadataPatch | undefined>;
};

const fallbackPopular = [
  { appid: "730", title: "Counter-Strike 2" },
  { appid: "570", title: "Dota 2" },
  { appid: "1172470", title: "Apex Legends" },
  { appid: "578080", title: "PUBG: BATTLEGROUNDS" },
  { appid: "271590", title: "Grand Theft Auto V Enhanced" },
  { appid: "1245620", title: "ELDEN RING" },
  { appid: "1086940", title: "Baldur's Gate 3" },
  { appid: "1091500", title: "Cyberpunk 2077" }
];
const HOME_LOCAL_ROW_LIMIT = 72;
const DISCOVERY_ENRICHMENT_CONCURRENCY = 2;
const DISCOVERY_ENRICHMENT_BUDGET_MS = 2_500;
const HOME_HERO_NSFW_PATTERN =
  /\b(?:nsfw|hentai|porn(?:ographic|ography)?|erotic|sexual(?:\s+(?:content|themes?))?|nudity|nude|adult\s+only|sex)\b/i;

function isLegacyGuessedLibraryCapsuleUrl(value: string | undefined): boolean {
  return Boolean(value && /^https:\/\/(?:cdn\.akamai\.steamstatic\.com\/steam|steamcdn-a\.akamaihd\.net\/steam)\/apps\/\d+\/library_600x900(?:_2x)?\.jpg(?:\?.*)?$/i.test(value));
}

function usableArtworkUrl(value: string | undefined): string | undefined {
  return isLegacyGuessedLibraryCapsuleUrl(value) ? undefined : value;
}

export function isHomeHeroSafe(game: Pick<Game, "title" | "genres" | "tags" | "contentDescriptors">): boolean {
  const safetyText = [game.title, ...game.genres, ...game.tags, ...game.contentDescriptors].join(" ");
  return !HOME_HERO_NSFW_PATTERN.test(safetyText);
}

export function filterHomeHeroGames(games: Game[]): Game[] {
  return games.filter(isHomeHeroSafe);
}

function steamFetch(fetchImpl: typeof fetch): typeof fetch {
  return fetchImpl === fetch ? (steamRateLimitedFetch as typeof fetch) : fetchImpl;
}

function emptyGame(appid: string, title: string): Game {
  return {
    id: makeGameId("steam", appid),
    title,
    sortTitle: makeSortTitle(title),
    sourceIds: [{ provider: "steam", externalId: appid }],
    installState: "not_installed",
    screenshots: [],
    genres: [],
    tags: [],
    playerModes: [],
    developers: [],
    publishers: [],
    contentDescriptors: [],
    metadataStatus: "none"
  };
}

function gameFromCandidate(candidate: Candidate, discovery: GameDiscovery): Game {
  const title = candidate.title?.trim() || `Steam App ${candidate.appid}`;
  return {
    ...emptyGame(candidate.appid, title),
    headerUrl: candidate.headerUrl,
    backgroundUrl: candidate.headerUrl,
    discovery,
    metadataStatus: "partial"
  };
}

function mergeCandidate(candidates: Map<string, Candidate>, appid: string, patch: Partial<Candidate>): Candidate {
  const existing =
    candidates.get(appid) ??
    ({
      appid,
      sources: new Set<string>(),
      featuredWeight: 0,
      newnessWeight: 0
    } satisfies Candidate);

  const next: Candidate = {
    ...existing,
    ...patch,
    title: existing.title ?? patch.title,
    headerUrl: existing.headerUrl ?? patch.headerUrl,
    sources: existing.sources,
    featuredWeight: Math.max(existing.featuredWeight, patch.featuredWeight ?? 0),
    newnessWeight: Math.max(existing.newnessWeight, patch.newnessWeight ?? 0),
    discountPercent: Math.max(existing.discountPercent ?? 0, patch.discountPercent ?? 0),
    originalPrice: existing.originalPrice ?? patch.originalPrice,
    finalPrice: existing.finalPrice ?? patch.finalPrice,
    currency: existing.currency ?? patch.currency,
    storeCategory: existing.storeCategory ?? patch.storeCategory,
    storeUrl: existing.storeUrl ?? patch.storeUrl
  };

  for (const source of patch.sources ?? []) {
    next.sources.add(source);
  }

  candidates.set(appid, next);
  return next;
}

function formatPrice(cents: number | undefined, currency = "USD"): string | undefined {
  if (cents === undefined) {
    return undefined;
  }

  if (cents === 0) {
    return "Free";
  }

  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

function storeUrl(appid: string, item?: FeaturedItem): string {
  return item?.url ?? `https://store.steampowered.com/app/${encodeURIComponent(appid)}`;
}

async function fetchFeaturedCategories(fetchImpl: typeof fetch): Promise<Candidate[]> {
  const response = await steamFetch(fetchImpl)("https://store.steampowered.com/api/featuredcategories/?cc=US&l=english");
  if (!response.ok) {
    throw new Error(`Steam featured categories returned ${response.status}`);
  }

  const json = (await response.json()) as FeaturedCategoriesResponse;
  const candidates = new Map<string, Candidate>();
  for (const [key, category] of Object.entries(json)) {
    if (!("items" in category) || !Array.isArray(category.items)) {
      continue;
    }

    const categoryId = /^\d+$/.test(key) ? (category.id ?? key) : key;
    const categorySignal = categoryId.replace(/^cat_/, "");
    const categoryWeight = categorySignal === "top_sellers" || categorySignal === "topsellers" ? 1 : categorySignal === "new_releases" || categorySignal === "newreleases" || categorySignal === "coming_soon" || categorySignal === "comingsoon" ? 0.85 : 0.5;
    const newnessWeight = categorySignal === "new_releases" || categorySignal === "newreleases" || categorySignal === "coming_soon" || categorySignal === "comingsoon" ? 1 : 0;
    const storeCategory = category.name ?? categorySignal.replace(/_/g, " ");
    category.items.forEach((item, index) => {
      if (item.type !== 0 || !item.id || !item.name) {
        return;
      }

      const appid = String(item.id);
      mergeCandidate(candidates, String(item.id), {
        title: item.name,
        headerUrl: item.header_image ?? item.large_capsule_image ?? item.small_capsule_image,
        featuredWeight: categoryWeight * (1 - index / 32),
        newnessWeight,
        discountPercent: item.discount_percent,
        originalPrice: item.original_price,
        finalPrice: item.final_price,
        currency: item.currency,
        storeCategory,
        storeUrl: storeUrl(appid, item),
        sources: new Set([`featured:${categorySignal || "category"}`])
      });
    });
  }

  return [...candidates.values()];
}

async function fetchStoreFeatured(fetchImpl: typeof fetch): Promise<Candidate[]> {
  const response = await steamFetch(fetchImpl)("https://store.steampowered.com/api/featured/?cc=US&l=english");
  if (!response.ok) {
    throw new Error(`Steam featured returned ${response.status}`);
  }

  const json = (await response.json()) as FeaturedResponse;
  const candidates = new Map<string, Candidate>();
  const groups: Array<[string, FeaturedItem[] | undefined]> = [
    ["large_capsules", json.large_capsules],
    ["featured_win", json.featured_win],
    ["featured_mac", json.featured_mac],
    ["featured_linux", json.featured_linux]
  ];

  for (const [group, items] of groups) {
    items?.forEach((item, index) => {
      if (item.type !== 0 || !item.id || !item.name) {
        return;
      }

      const appid = String(item.id);
      mergeCandidate(candidates, String(item.id), {
        title: item.name,
        headerUrl: item.header_image ?? item.large_capsule_image ?? item.small_capsule_image,
        featuredWeight: 0.65 * (1 - index / 40),
        newnessWeight: 0.25,
        discountPercent: item.discount_percent,
        originalPrice: item.original_price,
        finalPrice: item.final_price,
        currency: item.currency,
        storeCategory: group === "large_capsules" ? "Featured" : "Featured on Steam",
        storeUrl: storeUrl(appid, item),
        sources: new Set([`store-featured:${group}`])
      });
    });
  }

  return [...candidates.values()];
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/<[^>]+>/g, "")
    .trim();
}

async function fetchSteamSpyTrending(fetchImpl: typeof fetch): Promise<Candidate[]> {
  const response = await fetchImpl("https://steamspy.com/");
  if (!response.ok) {
    throw new Error(`SteamSpy homepage returned ${response.status}`);
  }

  const html = await response.text();
  const table = /<table[^>]+id="trendinggames"[\s\S]*?<tbody>(?<body>[\s\S]*?)<\/tbody>/i.exec(html)?.groups?.body;
  if (!table) {
    throw new Error("SteamSpy homepage did not include trending table");
  }

  const rows = [...table.matchAll(/<tr>[\s\S]*?<a href=\/app\/(?<appid>\d+)>[\s\S]*?<img[^>]+src="(?<image>[^"]+)"[^>]*>\s*(?<name>[\s\S]*?)<\/a>[\s\S]*?<td[^>]+data-order="(?<releaseDate>[^"]*)"[\s\S]*?<td[^>]+data-order="(?<price>[^"]*)"[\s\S]*?<td[^>]+data-order="(?<owners>[^"]*)"/gi)];
  return rows.map((row, index) => ({
    appid: row.groups?.appid ?? "",
    title: decodeHtml(row.groups?.name ?? ""),
    headerUrl: row.groups?.image,
    sources: new Set([`steamspy-trending:${index + 1}`]),
    trendRank: index + 1,
    featuredWeight: 0,
    newnessWeight: 0.8,
    owners: row.groups?.owners && row.groups.owners !== "0" ? `${row.groups.owners}+` : undefined,
    finalPrice: row.groups?.price ? Number(row.groups.price) : undefined,
    currency: "USD",
    storeCategory: "Trending"
  })).filter((candidate) => candidate.appid && candidate.title);
}

async function fetchSteamSpyTop(fetchImpl: typeof fetch): Promise<Candidate[]> {
  const response = await fetchImpl("https://steamspy.com/api.php?request=top100in2weeks");
  if (!response.ok) {
    throw new Error(`SteamSpy returned ${response.status}`);
  }

  const json = (await response.json()) as Record<string, SteamSpyItem>;
  return Object.values(json)
    .filter((item): item is Required<Pick<SteamSpyItem, "appid" | "name">> & SteamSpyItem => Boolean(item.appid && item.name))
    .slice(0, 100)
    .map((item, index) => ({
      appid: String(item.appid),
      title: item.name,
      sources: new Set([`steamspy-top:${index + 1}`]),
      featuredWeight: 0,
      newnessWeight: 0,
      steamSpyCcu: item.ccu,
      owners: item.owners,
      positive: item.positive,
      negative: item.negative
    }));
}

async function fetchSteamCharts(fetchImpl: typeof fetch): Promise<Candidate[]> {
  const response = await steamFetch(fetchImpl)("https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/?format=json");
  if (!response.ok) {
    throw new Error(`Steam charts returned ${response.status}`);
  }

  const json = (await response.json()) as SteamChartsResponse;
  const ranks = json.response?.ranks?.slice(0, 100) ?? [];
  if (ranks.length === 0) {
    throw new Error("Steam charts returned no ranks");
  }

  return ranks.map((item, index) => ({
    appid: String(item.appid),
    sources: new Set([`charts:${item.rank ?? index + 1}`]),
    featuredWeight: 0,
    newnessWeight: 0,
    chartRank: item.rank ?? index + 1,
    chartCcu: item.peak_in_game
  }));
}

async function fetchDiscoverySources(fetchImpl: typeof fetch, logger?: RecommendationLogger): Promise<DiscoverySources> {
  const [storeFeatured, featuredCategories, steamCharts, steamSpyTop, steamSpyTrending] = await Promise.allSettled([
    fetchStoreFeatured(fetchImpl),
    fetchFeaturedCategories(fetchImpl),
    fetchSteamCharts(fetchImpl),
    fetchSteamSpyTop(fetchImpl),
    fetchSteamSpyTrending(fetchImpl)
  ]);
  const rateLimited = [storeFeatured, featuredCategories, steamCharts].find((result) => result.status === "rejected" && isSteamRateLimitError(result.reason));
  if (rateLimited?.status === "rejected") {
    logger?.({
      level: "warning",
      phase: "home:discovery",
      message: "Steam discovery source is rate limited",
      details: { error: rateLimited.reason instanceof Error ? rateLimited.reason.message : String(rateLimited.reason) }
    });
    throw rateLimited.reason;
  }

  return {
    storeFeatured: storeFeatured.status === "fulfilled" ? storeFeatured.value : [],
    featuredCategories: featuredCategories.status === "fulfilled" ? featuredCategories.value : [],
    steamCharts: steamCharts.status === "fulfilled" ? steamCharts.value : [],
    steamSpyTop: steamSpyTop.status === "fulfilled" ? steamSpyTop.value : [],
    steamSpyTrending: steamSpyTrending.status === "fulfilled" ? steamSpyTrending.value : []
  };
}

function mergeCandidates(values: Candidate[]): Candidate[] {
  const candidates = new Map<string, Candidate>();
  for (const candidate of values) {
    mergeCandidate(candidates, candidate.appid, candidate);
  }

  return [...candidates.values()];
}

async function mapWithConcurrency<T, U>(items: T[], concurrency: number, mapper: (item: T) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(items.length);
  let index = 0;

  async function worker(): Promise<void> {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await mapper(items[currentIndex] as T);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

async function enrichWithinBudget(
  candidates: Candidate[],
  previousRanks: Map<string, number>,
  fetchImpl: typeof fetch,
  cachedGames: Map<string, Game>,
  options: BuildHomeOptions
): Promise<Game[]> {
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Game[]>((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      options.logger?.({
        level: "warning",
        phase: "home:discovery",
        message: "Home discovery enrichment exceeded budget; using feed data for banner/trending rows",
        details: { budgetMs: DISCOVERY_ENRICHMENT_BUDGET_MS, candidates: candidates.length }
      });
      resolve([]);
    }, DISCOVERY_ENRICHMENT_BUDGET_MS);
  });
  const enriched = mapWithConcurrency(
    candidates,
    DISCOVERY_ENRICHMENT_CONCURRENCY,
    (candidate) => enrichCandidate(candidate, scoreCandidate(candidate, previousRanks), fetchImpl, cachedGames, options)
  ).then((games) => timedOut ? [] : games.filter((game): game is Game => Boolean(game)));

  return Promise.race([enriched, timeout]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

function normalizedReviewScore(candidate: Candidate): number {
  const total = (candidate.positive ?? 0) + (candidate.negative ?? 0);
  if (total === 0) {
    return 0;
  }

  const ratio = (candidate.positive ?? 0) / total;
  const volume = Math.min(1, Math.log10(total) / 7);
  return ratio * volume;
}

function normalizeCcu(value: number | undefined): number {
  if (!value) {
    return 0;
  }

  return Math.min(1, Math.log10(value + 1) / 6);
}

function scoreCandidate(candidate: Candidate, previousRanks: Map<string, number>): GameDiscovery {
  const ccu = candidate.chartCcu ?? candidate.steamSpyCcu;
  const rankStrength = candidate.chartRank ? Math.max(0, 1 - (candidate.chartRank - 1) / 100) : 0;
  const populationScore = Math.max(normalizeCcu(ccu), rankStrength);
  const reviewScore = normalizedReviewScore(candidate);
  const discountScore = Math.min(1, (candidate.discountPercent ?? 0) / 80);
  const score = populationScore * 35 + reviewScore * 25 + candidate.featuredWeight * 20 + candidate.newnessWeight * 15 + discountScore * 5;
  const previousRank = previousRanks.get(makeGameId("steam", candidate.appid));
  const rankDelta = previousRank && candidate.chartRank ? previousRank - candidate.chartRank : undefined;
  const signal =
    (candidate.sources.has("featured:new_releases") || candidate.sources.has("featured:newreleases"))
      ? "New release"
      : candidate.sources.has("featured:coming_soon") || candidate.sources.has("featured:comingsoon")
        ? "Coming soon"
        : candidate.sources.has("featured:top_sellers") || candidate.sources.has("featured:topsellers")
          ? "Top seller"
          : (candidate.discountPercent ?? 0) > 0
            ? "Special"
            : rankDelta && rankDelta > 5
        ? "Rising"
        : candidate.featuredWeight > 0.8
          ? "Top seller"
          : "Featured";

  return {
    score,
    signal: candidate.trendRank ? "Trending" : signal,
    ccu,
    owners: candidate.owners,
    reviewScore,
    rankDelta,
    priceText: formatPrice(candidate.finalPrice, candidate.currency),
    originalPriceText: formatPrice(candidate.originalPrice, candidate.currency),
    discountPercent: candidate.discountPercent,
    storeCategory: candidate.storeCategory,
    storeUrl: candidate.storeUrl,
    sources: [...candidate.sources]
  };
}

function previousDiscoveryGames(previous?: HomeModel): Map<string, Game> {
  const games = new Map<string, Game>();
  const previousRows = (previous?.trendingRows ?? []).flatMap((row) => row.games);
  for (const game of [...(previous?.popularNow ?? []), ...(previous?.recommended ?? []), ...(previous?.newAndNotable ?? []), ...previousRows]) {
    if (game.metadataStatus !== "none" && !/^Steam App \d+$/i.test(game.title)) {
      games.set(game.id, game);
    }
  }

  return games;
}

function metadataLoggerForCandidate(candidate: Candidate, logger?: RecommendationLogger): MetadataLogger | undefined {
  if (!logger) {
    return undefined;
  }

  return (entry) =>
    logger({
      level: entry.level,
      phase: `metadata:${entry.providerId}`,
      message: `${entry.gameTitle}: ${entry.message}`,
      details: {
        appid: entry.appid,
        sources: [...candidate.sources],
        ...entry.details
      }
    });
}

function discoveryMetadataProviders(candidate: Candidate, fetchImpl: typeof fetch, options: BuildHomeOptions = {}): MetadataProvider[] {
  const logger = metadataLoggerForCandidate(candidate, options.logger);
  const fastProviders: MetadataProvider[] = [
    {
      id: "steam-appinfo",
      label: "Steam appinfo",
      async refresh(game) {
        return fetchSteamAppInfoMetadataWithNativeFallback(game, fetchImpl, logger, options.steamAppInfoProvider);
      }
    },
    {
      id: "steam-cdn",
      label: "Steam CDN artwork",
      refresh: (game) => fetchSteamCdnArtworkMetadata(game.externalId, fetchImpl, logger, game.title)
    },
    ...(options.steamGridDbApiKey ? [createSteamGridDbArtworkProvider(options.steamGridDbApiKey, fetchImpl, logger)] : [])
  ];

  return [
    ...fastProviders,
    {
      id: "steam-store",
      label: "Steam Store",
      refresh: (game) => fetchSteamMetadata(game.externalId, fetchImpl, logger, game.title)
    }
  ];
}

async function enrichCandidate(
  candidate: Candidate,
  discovery: GameDiscovery,
  fetchImpl: typeof fetch,
  cachedGames: Map<string, Game>,
  options: BuildHomeOptions = {}
): Promise<Game | undefined> {
  const fallbackTitle = candidate.title?.trim() || `Steam App ${candidate.appid}`;

  const base = emptyGame(candidate.appid, fallbackTitle);
  const imported = {
    provider: "steam" as const,
    externalId: candidate.appid,
    title: fallbackTitle,
    installState: "not_installed" as const
  };
  const cached = cachedGames.get(base.id);
  const cachedLibraryCapsuleUrl = usableArtworkUrl(cached?.libraryCapsuleUrl);
  if (cached && cachedLibraryCapsuleUrl) {
    const fallbackHeaderUrl = cached.headerUrl ?? candidate.headerUrl ?? cached.backgroundUrl;
    return {
      ...cached,
      discovery,
      libraryCapsuleUrl: cachedLibraryCapsuleUrl,
      coverUrl: cachedLibraryCapsuleUrl,
      headerUrl: fallbackHeaderUrl,
      backgroundUrl: cached.backgroundUrl ?? fallbackHeaderUrl,
      metadataStatus: cached.metadataStatus
    };
  }

  try {
    const metadata = await refreshFusedMetadata(imported, discoveryMetadataProviders(candidate, fetchImpl, options));
    const title = metadata.title ?? fallbackTitle;
    const fallbackCoverUrl = usableArtworkUrl(metadata.libraryCapsuleUrl);
    const fallbackHeaderUrl = metadata.headerUrl ?? candidate.headerUrl ?? metadata.backgroundUrl;

    if (!fallbackCoverUrl) {
      options.logger?.({
        level: "warning",
        phase: "metadata:discovery",
        message: `${title}: discovery metadata has no vertical capsule artwork after all providers`,
        details: {
          appid: candidate.appid,
          sources: [...candidate.sources],
          storeHeaderUrl: candidate.headerUrl,
          metadataStatus: metadata.metadataStatus
        }
      });
    }

    if (!metadata.shortDescription && !metadata.aboutText) {
      options.logger?.({
        level: "warning",
        phase: "metadata:discovery",
        message: `${title}: discovery metadata has no description after Steam appdetails`,
        details: {
          appid: candidate.appid,
          sources: [...candidate.sources],
          metadataStatus: metadata.metadataStatus
        }
      });
    }

    return {
      ...base,
      ...metadata,
      id: base.id,
      title,
      sortTitle: makeSortTitle(title),
      coverUrl: fallbackCoverUrl,
      libraryCapsuleUrl: fallbackCoverUrl,
      headerUrl: fallbackHeaderUrl,
      backgroundUrl: metadata.backgroundUrl ?? fallbackHeaderUrl,
      discovery,
      metadataStatus: metadata.metadataStatus ?? "partial",
      screenshots: metadata.screenshots ?? [],
      genres: metadata.genres ?? [],
      tags: metadata.tags ?? [],
      developers: metadata.developers ?? [],
      publishers: metadata.publishers ?? [],
      contentDescriptors: metadata.contentDescriptors ?? []
    };
  } catch (error) {
    if (isSteamRateLimitError(error)) {
      options.logger?.({
        level: "warning",
        phase: "metadata:discovery",
        message: `${fallbackTitle}: discovery metadata enrichment paused by Steam rate limiting`,
        details: {
          appid: candidate.appid,
          sources: [...candidate.sources],
          retryAfterMs: error.retryAfterMs
        }
      });
      throw error;
    }

    options.logger?.({
      level: "error",
      phase: "metadata:discovery",
      message: `${fallbackTitle}: discovery metadata enrichment failed`,
      details: {
        appid: candidate.appid,
        sources: [...candidate.sources],
        error: error instanceof Error ? error.message : String(error)
      }
    });
    return {
      ...base,
      headerUrl: candidate.headerUrl,
      backgroundUrl: candidate.headerUrl,
      discovery,
      metadataStatus: "partial"
    };
  }
}

function rankRecommended(localGames: Game[], candidates: Game[]): Game[] {
  const ownedIds = new Set(localGames.flatMap((game) => game.sourceIds.map((source) => `${source.provider}:${source.externalId}`)));
  const tasteWeights = new Map<string, number>();
  for (const game of localGames) {
    const weight = Math.max(1, Math.log10((game.playtimeMinutes ?? 0) + 10));
    for (const value of [...game.genres, ...game.tags, ...game.developers, ...game.publishers]) {
      tasteWeights.set(value, (tasteWeights.get(value) ?? 0) + weight);
    }
  }

  return candidates
    .filter((candidate) => !ownedIds.has(candidate.id))
    .map((candidate) => {
      const tasteScore = [...candidate.genres, ...candidate.tags, ...candidate.developers, ...candidate.publishers].reduce(
        (score, value) => score + (tasteWeights.get(value) ?? 0),
        0
      );
      return { candidate, score: tasteScore * 8 + (candidate.discovery?.score ?? 0) };
    })
    .sort((a, b) => b.score - a.score)
    .map((item) => ({
      ...item.candidate,
      discovery: {
        ...(item.candidate.discovery ?? { score: item.score, signal: "Popular with your library", sources: [] }),
        signal: tasteWeights.size > 0 ? "Popular with your library" : (item.candidate.discovery?.signal ?? "Trending")
      }
    }));
}

function uniqueGames(games: Game[]): Game[] {
  return games.filter((game, index, rows) => rows.findIndex((row) => row.id === game.id) === index);
}

function withoutGames(games: Game[], excluded: Set<string>): Game[] {
  return games.filter((game) => !excluded.has(game.id));
}

function hasSource(candidate: Candidate, prefix: string): boolean {
  return [...candidate.sources].some((source) => source.startsWith(prefix));
}

function discoveryHasSource(game: Game, prefix: string): boolean {
  return Boolean(game.discovery?.sources.some((source) => source.startsWith(prefix)));
}

function candidatePriority(candidate: Candidate, discovery: GameDiscovery): number {
  if (hasSource(candidate, "store-featured:large_capsules")) {
    return 4000 + discovery.score;
  }

  if (hasSource(candidate, "store-featured:featured_win")) {
    return 3500 + discovery.score;
  }

  if (hasSource(candidate, "featured:top_sellers") || hasSource(candidate, "featured:topsellers")) {
    return 3000 + discovery.score;
  }

  if (hasSource(candidate, "featured:new_releases") || hasSource(candidate, "featured:newreleases") || hasSource(candidate, "featured:coming_soon") || hasSource(candidate, "featured:comingsoon")) {
    return 2000 + discovery.score;
  }

  if (hasSource(candidate, "store-featured:")) {
    return 1500 + discovery.score;
  }

  return discovery.score;
}

function previousChartRanks(previous?: HomeModel): Map<string, number> {
  const ranks = new Map<string, number>();
  previous?.popularNow.forEach((game, index) => ranks.set(game.id, index + 1));
  (previous?.trendingRows ?? [])
    .find((row) => row.id === "most-played-now")
    ?.games.forEach((game, index) => ranks.set(game.id, index + 1));
  return ranks;
}

function candidateGameId(candidate: Candidate): string {
  return makeGameId("steam", candidate.appid);
}

function sortByChartRank(a: Candidate, b: Candidate): number {
  return (a.chartRank ?? Number.MAX_SAFE_INTEGER) - (b.chartRank ?? Number.MAX_SAFE_INTEGER);
}

function sortByCcu(a: Candidate, b: Candidate): number {
  return (b.steamSpyCcu ?? b.chartCcu ?? 0) - (a.steamSpyCcu ?? a.chartCcu ?? 0);
}

function trendingCandidatePool(sources: DiscoverySources): Candidate[] {
  return [
    ...sources.steamCharts.slice().sort(sortByChartRank),
    ...sources.steamSpyTop.slice().sort(sortByCcu),
    ...sources.steamSpyTrending,
    ...sources.storeFeatured,
    ...sources.featuredCategories.filter((candidate) => hasSource(candidate, "featured:topsellers") || hasSource(candidate, "featured:top_sellers")),
    ...sources.featuredCategories.filter((candidate) => hasSource(candidate, "featured:newreleases") || hasSource(candidate, "featured:new_releases")),
    ...sources.featuredCategories.filter((candidate) => hasSource(candidate, "featured:comingsoon") || hasSource(candidate, "featured:coming_soon")),
    ...sources.featuredCategories.filter((candidate) => hasSource(candidate, "featured:specials") || hasSource(candidate, "featured:dailydeal"))
  ];
}

function gamesForCandidates(candidates: Candidate[], enrichedById: Map<string, Game>, ownedIds: Set<string>): Game[] {
  return uniqueGames(
    candidates
      .map((candidate) => enrichedById.get(candidateGameId(candidate)))
      .filter((game): game is Game => Boolean(game))
      .filter((game) => !ownedIds.has(game.id))
  );
}

function buildTrendRows(sources: DiscoverySources, enrichedById: Map<string, Game>, ownedIds: Set<string>): HomeTrendRow[] {
  const rows: HomeTrendRow[] = [
    {
      id: "most-played-now",
      title: "Most played now",
      description: "Steam chart leaders, ordered by current rank and peak player count.",
      games: gamesForCandidates(sources.steamCharts.slice().sort(sortByChartRank), enrichedById, ownedIds)
    },
    {
      id: "top-two-weeks",
      title: "Popular this week",
      description: "SteamSpy two-week demand with owner, player, and review signals.",
      games: gamesForCandidates(sources.steamSpyTop.slice().sort(sortByCcu), enrichedById, ownedIds)
    },
    {
      id: "rising-recently",
      title: "Rising recently",
      description: "Fresh SteamSpy movement, useful for catching smaller games early.",
      games: gamesForCandidates(sources.steamSpyTrending, enrichedById, ownedIds)
    },
    {
      id: "top-sellers",
      title: "Top sellers",
      description: "Store category leaders with price and discount metadata.",
      games: gamesForCandidates(
        sources.featuredCategories.filter((candidate) => hasSource(candidate, "featured:topsellers") || hasSource(candidate, "featured:top_sellers")),
        enrichedById,
        ownedIds
      )
    },
    {
      id: "new-releases",
      title: "New releases",
      description: "New Steam releases currently receiving front-page placement.",
      games: gamesForCandidates(
        sources.featuredCategories.filter((candidate) => hasSource(candidate, "featured:newreleases") || hasSource(candidate, "featured:new_releases")),
        enrichedById,
        ownedIds
      )
    },
    {
      id: "coming-soon",
      title: "Coming soon",
      description: "Upcoming titles Steam is already promoting.",
      games: gamesForCandidates(
        sources.featuredCategories.filter((candidate) => hasSource(candidate, "featured:comingsoon") || hasSource(candidate, "featured:coming_soon")),
        enrichedById,
        ownedIds
      )
    },
    {
      id: "specials",
      title: "Specials",
      description: "Discounted games and daily deals from the Store front page.",
      games: gamesForCandidates(
        sources.featuredCategories.filter((candidate) => hasSource(candidate, "featured:specials") || hasSource(candidate, "featured:dailydeal")),
        enrichedById,
        ownedIds
      )
    },
    {
      id: "featured",
      title: "Featured",
      description: "Platform front-page picks from the Steam Store featured feed.",
      games: gamesForCandidates(sources.storeFeatured, enrichedById, ownedIds)
    }
  ];

  return rows.filter((row) => row.games.length > 0);
}

export async function buildHomeModel(localGames: Game[], fetchImpl: typeof fetch = fetch, previous?: HomeModel, options: BuildHomeOptions = {}): Promise<HomeModel> {
  const previousRanks = previousChartRanks(previous);
  const cachedGames = previousDiscoveryGames(previous);
  const sources = await fetchDiscoverySources(fetchImpl, options.logger);
  let heroCandidates = mergeCandidates([...sources.storeFeatured, ...sources.featuredCategories]);
  if (heroCandidates.length === 0) {
    heroCandidates = fallbackPopular.map((item) => ({
      appid: item.appid,
      title: item.title,
      sources: new Set(["fallback"]),
      featuredWeight: 0.4,
      newnessWeight: 0
    }));
  }

  const prioritized = heroCandidates
    .map((candidate) => ({ candidate, discovery: scoreCandidate(candidate, previousRanks) }))
    .sort((a, b) => candidatePriority(b.candidate, b.discovery) - candidatePriority(a.candidate, a.discovery))
    .slice(0, 72);
  const enrichmentCandidates = mergeCandidates([...prioritized.map((item) => item.candidate), ...trendingCandidatePool(sources)]);
  const feedGames = enrichmentCandidates.map((candidate) => gameFromCandidate(candidate, scoreCandidate(candidate, previousRanks)));
  const enriched = [
    ...feedGames,
    ...(await enrichWithinBudget(enrichmentCandidates, previousRanks, fetchImpl, cachedGames, options))
  ]
    .filter((game): game is Game => Boolean(game))
    .filter((game) => !/^Steam App \d+$/i.test(game.title));

  const ownedIds = new Set(localGames.flatMap((game) => game.sourceIds.map((source) => `${source.provider}:${source.externalId}`)));
  const enrichedById = new Map(enriched.map((game) => [game.id, game]));
  const popularNow = uniqueGames(
    prioritized
      .map((item) => enrichedById.get(candidateGameId(item.candidate)))
      .filter((game): game is Game => Boolean(game))
      .filter((game) => !ownedIds.has(game.id))
      .filter(isHomeHeroSafe)
  ).slice(0, 20);
  const trendingRows = buildTrendRows(sources, enrichedById, ownedIds);
  const recentActivity = [...localGames]
    .filter((game) => gameActivityTime(game) > 0)
    .sort((a, b) => gameActivityTime(b) - gameActivityTime(a))
    .slice(0, 10);
  const continuePlaying = [...localGames]
    .filter((game) => game.lastPlayedAt)
    .sort((a, b) => (Date.parse(b.lastPlayedAt ?? "") || 0) - (Date.parse(a.lastPlayedAt ?? "") || 0))
    .slice(0, HOME_LOCAL_ROW_LIMIT);
  const mostPlayed = [...localGames].sort((a, b) => (b.playtimeMinutes ?? 0) - (a.playtimeMinutes ?? 0)).slice(0, HOME_LOCAL_ROW_LIMIT);

  return {
    recentActivity,
    continuePlaying,
    mostPlayed,
    popularNow,
    recommended: [],
    newAndNotable: [],
    trendingRows,
    generatedAt: new Date().toISOString(),
    stale: false
  };
}
