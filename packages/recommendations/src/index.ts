import { type Game, type GameDiscovery, type GameMetadataPatch, type HomeModel, type ImportedGame, gameActivityTime, makeGameId, makeSortTitle } from "@hynite/core";
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

type Candidate = {
  appid: string;
  title?: string;
  headerUrl?: string;
  sources: Set<string>;
  featuredWeight: number;
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
  discoverySourceFetchTimeoutMs?: number;
  /**
   * Personalised Steam appids for the "Recommended for you" row, pulled from the
   * logged-in store session's dynamicstore/userdata. Ordering is Steam's own.
   */
  recommendedAppIds?: string[];
  /** Personalised Steam appids for the "Discovery queue" row (generatenewdiscoveryqueue). */
  discoveryQueueAppIds?: string[];
  /** Curated Steam appids for the "Top new releases" row (ISteamChartsService/GetTopReleasesPages). */
  topReleaseAppIds?: string[];
};

/** A supplemental discovery row driven by an externally supplied appid list. */
type AppIdRowSpec = {
  row: "recommended" | "newAndNotable" | "discoveryQueue";
  appIds: string[];
  sourceTag: string;
  signal: string;
};

// Resolve metadata for at most this many appids per supplemental row; the visible row is a subset.
const APPID_ROW_FETCH_LIMIT = 50;
const APPID_ROW_VISIBLE_LIMIT = 20;
const STORE_ITEM_ASSET_BASE = "https://shared.cloudflare.steamstatic.com/store_item_assets/";
const STORE_ITEMS_BATCH_SIZE = 100;

// Compact view of an IStoreBrowseService/GetItems store item — everything the supplemental
// Home rows need (title, correct vertical capsule, review quality) in a single batched call,
// so these rows never touch the per-appid, rate-limited enrichment pipeline.
type StoreItemInfo = {
  appid: string;
  name: string;
  type?: number;
  visible?: boolean;
  coverUrl?: string;
  headerUrl?: string;
  backgroundUrl?: string;
  shortDescription?: string;
  reviewScore?: number;
  reviewCount?: number;
  percentPositive?: number;
  reviewLabel?: string;
  priceText?: string;
  originalPriceText?: string;
  discountPercent?: number;
  releaseDate?: string;
  storeUrl?: string;
};

function storeAssetUrl(assetUrlFormat: string | undefined, filename: string | undefined): string | undefined {
  if (!assetUrlFormat || !filename) {
    return undefined;
  }
  return STORE_ITEM_ASSET_BASE + assetUrlFormat.replace("${FILENAME}", filename);
}

function storeItemFromResponse(raw: Record<string, any>): StoreItemInfo | undefined {
  const appid = raw.appid ? String(raw.appid) : undefined;
  const name = typeof raw.name === "string" ? raw.name.trim() : undefined;
  if (!appid || !name) {
    return undefined;
  }
  const assets = (raw.assets ?? {}) as Record<string, string>;
  const fmt = assets.asset_url_format;
  const reviews = (raw.reviews?.summary_filtered ?? {}) as Record<string, unknown>;
  const purchase = (raw.best_purchase_option ?? {}) as Record<string, unknown>;
  const releaseDateSeconds = raw.release?.steam_release_date;
  const discountRaw = purchase.discount_pct;
  const discountPercent = typeof discountRaw === "number" ? discountRaw : typeof discountRaw === "string" ? Number(discountRaw) : undefined;
  return {
    appid,
    name,
    type: typeof raw.type === "number" ? raw.type : undefined,
    visible: raw.visible,
    coverUrl: storeAssetUrl(fmt, assets.library_capsule_2x ?? assets.library_capsule),
    headerUrl: storeAssetUrl(fmt, assets.header ?? assets.header_2x) ?? officialSteamHeaderUrl(appid),
    backgroundUrl: storeAssetUrl(fmt, assets.library_hero ?? assets.library_hero_2x),
    shortDescription: typeof raw.basic_info?.short_description === "string" ? raw.basic_info.short_description : undefined,
    reviewScore: typeof reviews.review_score === "number" ? reviews.review_score : undefined,
    reviewCount: typeof reviews.review_count === "number" ? reviews.review_count : undefined,
    percentPositive: typeof reviews.percent_positive === "number" ? reviews.percent_positive : undefined,
    reviewLabel: typeof reviews.review_score_label === "string" ? reviews.review_score_label : undefined,
    priceText: (typeof purchase.formatted_final_price === "string" ? purchase.formatted_final_price : undefined) ?? (raw.is_free ? "Free" : undefined),
    originalPriceText: typeof purchase.formatted_original_price === "string" ? purchase.formatted_original_price : undefined,
    discountPercent: discountPercent && Number.isFinite(discountPercent) && discountPercent > 0 ? discountPercent : undefined,
    releaseDate: typeof releaseDateSeconds === "number" ? new Date(releaseDateSeconds * 1000).toISOString().slice(0, 10) : undefined,
    storeUrl: typeof raw.store_url_path === "string" ? `https://store.steampowered.com/${raw.store_url_path}` : `https://store.steampowered.com/app/${appid}`
  };
}

// Batch-resolve titles, vertical capsule art, and review quality for a set of appids via the
// modern storefront API. One call per 100 appids — no per-app rate limiting.
async function fetchStoreItems(appIds: string[], fetchImpl: typeof fetch, logger?: RecommendationLogger): Promise<Map<string, StoreItemInfo>> {
  const items = new Map<string, StoreItemInfo>();
  for (let start = 0; start < appIds.length; start += STORE_ITEMS_BATCH_SIZE) {
    const batch = appIds.slice(start, start + STORE_ITEMS_BATCH_SIZE);
    const input = {
      ids: batch.map((appid) => ({ appid: Number(appid) })),
      context: { language: "english", country_code: "DE", steam_realm: 1 },
      data_request: { include_assets: true, include_release: true, include_reviews: true, include_basic_info: true }
    };
    const url = `https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`;
    try {
      const response = await fetchImpl(url);
      if (!response.ok) {
        logger?.({ level: "warning", phase: "home:discovery", message: `GetItems returned ${response.status}`, details: { batch: batch.length } });
        continue;
      }
      const json = (await response.json()) as { response?: { store_items?: Array<Record<string, any>> } };
      for (const raw of json.response?.store_items ?? []) {
        const item = storeItemFromResponse(raw);
        if (item) {
          items.set(item.appid, item);
        }
      }
    } catch (error) {
      logger?.({
        level: "warning",
        phase: "home:discovery",
        message: "GetItems batch failed",
        details: { error: error instanceof Error ? error.message : String(error) }
      });
    }
  }
  return items;
}

export const HOME_DISCOVERY_CACHE_VERSION = 2;

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
const DISCOVERY_SOURCE_FETCH_TIMEOUT_MS = 10_000;
const HOME_HERO_NSFW_PATTERNS = [
  {
    reason: "adult age marker",
    pattern: /(?:^|[\s([{"'_/\\-])(?:18\+|r[-\s]?18)(?:$|[\s)\]}.,:;!?'"_/\\-])/i
  },
  {
    reason: "adult/sexual marker",
    pattern: /\b(?:adult(?:\s+(?:only|content|game|games|visual\s+novel))?|nsfw|xxx|hentai|ecchi|eroge|porn(?:ographic|ography)?|erotic|sexual(?:\s+(?:content|themes?|material))?|nudity|nude|naked|sex|sexy|suggestive(?:\s+themes?)?|risque|lewd|lust(?:ful)?|fetish|bdsm|strip(?:per|ping)?|brothel|prostitut(?:e|ion)|incest|futanari|futa|milf|boobs?|breasts?)\b/i
  }
];

type HomeHeroSafetyFields = Pick<Game, "title" | "genres" | "tags" | "contentDescriptors"> &
  Partial<Pick<Game, "shortDescription" | "aboutText">>;

function isLegacyGuessedLibraryCapsuleUrl(value: string | undefined): boolean {
  return Boolean(value && /^https:\/\/(?:cdn\.akamai\.steamstatic\.com\/steam|steamcdn-a\.akamaihd\.net\/steam)\/apps\/\d+\/library_600x900(?:_2x)?\.jpg(?:\?.*)?$/i.test(value));
}

function usableArtworkUrl(value: string | undefined): string | undefined {
  return isLegacyGuessedLibraryCapsuleUrl(value) ? undefined : value;
}

const STEAM_CATEGORY_TAGS = new Set([
  "captions available",
  "commentary available",
  "cross-platform multiplayer",
  "family sharing",
  "full controller support",
  "hdr available",
  "in-app purchases",
  "includes level editor",
  "includes source sdk",
  "lan co-op",
  "lan pvp",
  "mmo",
  "multi-player",
  "online co-op",
  "online pvp",
  "partial controller support",
  "pvp",
  "remote play on phone",
  "remote play on tablet",
  "remote play on tv",
  "remote play together",
  "shared/split screen",
  "shared/split screen co-op",
  "shared/split screen pvp",
  "single-player",
  "stats",
  "steam achievements",
  "steam cloud",
  "steam deck",
  "steam leaderboards",
  "steam trading cards",
  "steam turn notifications",
  "steam workshop",
  "stereo sound",
  "tracked controller support",
  "valve anti-cheat enabled",
  "vr only",
  "vr supported"
]);

function hasResolvedStoreTags(game: Pick<Game, "tags">): boolean {
  return game.tags.some((tag) => !STEAM_CATEGORY_TAGS.has(tag.trim().toLocaleLowerCase()));
}

function homeHeroSafetyText(game: HomeHeroSafetyFields): string {
  return [game.title, game.shortDescription, game.aboutText, ...game.genres, ...game.tags, ...game.contentDescriptors]
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

export function homeHeroSafetyReason(game: HomeHeroSafetyFields): string | undefined {
  const safetyText = homeHeroSafetyText(game);
  for (const { reason, pattern } of HOME_HERO_NSFW_PATTERNS) {
    const match = pattern.exec(safetyText);
    if (match) {
      return `${reason}: ${match[0].trim()}`;
    }
  }

  return undefined;
}

export function isHomeHeroSafe(game: HomeHeroSafetyFields): boolean {
  return !homeHeroSafetyReason(game);
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

function officialSteamHeaderUrl(appid: string): string {
  return `https://cdn.akamai.steamstatic.com/steam/apps/${encodeURIComponent(appid)}/header.jpg`;
}

function gameFromCandidate(candidate: Candidate, discovery: GameDiscovery): Game {
  const title = candidate.title?.trim() || `Steam App ${candidate.appid}`;
  const headerUrl = candidate.headerUrl ?? officialSteamHeaderUrl(candidate.appid);
  return {
    ...emptyGame(candidate.appid, title),
    headerUrl,
    backgroundUrl: headerUrl,
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

async function fetchWithTimeout(fetchImpl: typeof fetch, input: RequestInfo | URL, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, { signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`Discovery source fetch timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFeaturedCategories(fetchImpl: typeof fetch, timeoutMs: number): Promise<Candidate[]> {
  const response = await fetchWithTimeout(steamFetch(fetchImpl), "https://store.steampowered.com/api/featuredcategories/?cc=DE&l=english", timeoutMs);
  if (!response.ok) {
    throw new Error(`Steam featured categories returned ${response.status}`);
  }

  const json = (await response.json()) as FeaturedCategoriesResponse;
  const candidates = new Map<string, Candidate>();
  for (const [key, category] of Object.entries(json)) {
    if (typeof category !== "object" || category === null || !("items" in category) || !Array.isArray(category.items)) {
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
      if (/\b(soundtrack|season\s+pass|art\s*book)\b|\bost\s*$/i.test(item.name)) {
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

async function fetchStoreFeatured(fetchImpl: typeof fetch, timeoutMs: number): Promise<Candidate[]> {
  const response = await fetchWithTimeout(steamFetch(fetchImpl), "https://store.steampowered.com/api/featured/?cc=DE&l=english", timeoutMs);
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
      if (/\b(soundtrack|season\s+pass|art\s*book)\b|\bost\s*$/i.test(item.name)) {
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

async function fetchDiscoverySources(fetchImpl: typeof fetch, logger?: RecommendationLogger, timeoutMs = DISCOVERY_SOURCE_FETCH_TIMEOUT_MS): Promise<DiscoverySources> {
  const [storeFeatured, featuredCategories] = await Promise.allSettled([
    fetchStoreFeatured(fetchImpl, timeoutMs),
    fetchFeaturedCategories(fetchImpl, timeoutMs)
  ]);
  const rateLimited = [storeFeatured, featuredCategories].find((result) => result.status === "rejected" && isSteamRateLimitError(result.reason));
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
    featuredCategories: featuredCategories.status === "fulfilled" ? featuredCategories.value : []
  };
}

function mergeCandidates(values: Candidate[]): Candidate[] {
  const candidates = new Map<string, Candidate>();
  for (const candidate of values) {
    mergeCandidate(candidates, candidate.appid, candidate);
  }

  return [...candidates.values()];
}

async function enrichWithinBudget(
  candidates: Candidate[],
  previousRanks: Map<string, number>,
  fetchImpl: typeof fetch,
  cachedGames: Map<string, Game>,
  options: BuildHomeOptions
): Promise<Game[]> {
  const results = new Array<Game | undefined>(candidates.length);
  let timedOut = false;
  let nextIndex = 0;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      options.logger?.({
        level: "warning",
        phase: "home:discovery",
        message: "Home discovery enrichment exceeded budget; using completed metadata plus feed data for the Home banner",
        details: {
          budgetMs: DISCOVERY_ENRICHMENT_BUDGET_MS,
          candidates: candidates.length,
          enriched: results.filter(Boolean).length
        }
      });
      resolve("timeout");
    }, DISCOVERY_ENRICHMENT_BUDGET_MS);
  });

  async function worker(): Promise<void> {
    while (!timedOut) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const candidate = candidates[currentIndex];
      if (!candidate) {
        return;
      }

      const game = await enrichCandidate(candidate, scoreCandidate(candidate, previousRanks), fetchImpl, cachedGames, options);
      if (game) {
        results[currentIndex] = game;
      }
    }
  }

  const workers = Promise.all(Array.from({ length: Math.min(DISCOVERY_ENRICHMENT_CONCURRENCY, candidates.length) }, () => worker()));
  const completed = workers.then(() => "completed" as const);
  const outcome = await Promise.race([completed, timeout]);
  if (outcome === "timeout") {
    workers.catch((error) => {
      options.logger?.({
        level: isSteamRateLimitError(error) ? "warning" : "error",
        phase: "metadata:discovery",
        message: "Home discovery enrichment failed after timeout",
        details: { error: error instanceof Error ? error.message : String(error) }
      });
    });
  }

  if (timeoutId) {
    clearTimeout(timeoutId);
  }

  return results.filter((game): game is Game => Boolean(game));
}

function scoreCandidate(candidate: Candidate, _previousRanks: Map<string, number>): GameDiscovery {
  const discountScore = Math.min(1, (candidate.discountPercent ?? 0) / 80);
  const score = candidate.featuredWeight * 20 + candidate.newnessWeight * 15 + discountScore * 5;
  const signal =
    (candidate.sources.has("featured:new_releases") || candidate.sources.has("featured:newreleases"))
      ? "New release"
      : candidate.sources.has("featured:coming_soon") || candidate.sources.has("featured:comingsoon")
        ? "Coming soon"
        : candidate.sources.has("featured:top_sellers") || candidate.sources.has("featured:topsellers")
          ? "Top seller"
          : (candidate.discountPercent ?? 0) > 0
            ? "Special"
            : candidate.featuredWeight > 0.8
              ? "Top seller"
              : "Featured";

  return {
    score,
    signal,
    priceText: formatPrice(candidate.finalPrice, candidate.currency),
    originalPriceText: formatPrice(candidate.originalPrice, candidate.currency),
    discountPercent: candidate.discountPercent,
    storeCategory: candidate.storeCategory,
    storeUrl: candidate.storeUrl,
    sources: [...candidate.sources]
  };
}

function canReuseCachedDiscoveryGame(game: Game, currentCache: boolean): boolean {
  if (game.metadataStatus === "none" || /^Steam App \d+$/i.test(game.title)) {
    return false;
  }

  if (isLegacyGuessedLibraryCapsuleUrl(game.libraryCapsuleUrl) || isLegacyGuessedLibraryCapsuleUrl(game.coverUrl)) {
    return false;
  }

  if (currentCache) {
    return true;
  }

  return Boolean(usableArtworkUrl(game.libraryCapsuleUrl) && (hasResolvedStoreTags(game) || game.metadataStatus === "complete"));
}

function previousDiscoveryGames(previous?: HomeModel): Map<string, Game> {
  const games = new Map<string, Game>();
  const currentCache = previous?.cacheVersion === HOME_DISCOVERY_CACHE_VERSION;
  for (const game of [...(previous?.popularNow ?? []), ...(previous?.recommended ?? []), ...(previous?.newAndNotable ?? [])]) {
    if (canReuseCachedDiscoveryGame(game, currentCache)) {
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
  if (cached) {
    const cachedLibraryCapsuleUrl = usableArtworkUrl(cached.libraryCapsuleUrl);
    const cachedCoverUrl = usableArtworkUrl(cached.coverUrl);
    const fallbackHeaderUrl = candidate.headerUrl ?? cached.headerUrl ?? cached.backgroundUrl ?? officialSteamHeaderUrl(candidate.appid);
    const title = candidate.title?.trim() || cached.title;
    return {
      ...cached,
      title,
      sortTitle: makeSortTitle(title),
      discovery,
      libraryCapsuleUrl: cachedLibraryCapsuleUrl,
      coverUrl: cachedLibraryCapsuleUrl ?? cachedCoverUrl,
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
        signal: tasteWeights.size > 0 ? "Popular with your library" : (item.candidate.discovery?.signal ?? "Featured")
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
  if (hasSource(candidate, "featured:new_releases") || hasSource(candidate, "featured:newreleases")) {
    return 4500 + discovery.score;
  }

  if (hasSource(candidate, "featured:coming_soon") || hasSource(candidate, "featured:comingsoon")) {
    return 4000 + discovery.score;
  }

  if (hasSource(candidate, "store-featured:large_capsules")) {
    return 3800 + discovery.score;
  }

  if (hasSource(candidate, "store-featured:featured_win")) {
    return 3500 + discovery.score;
  }

  if (hasSource(candidate, "featured:top_sellers") || hasSource(candidate, "featured:topsellers")) {
    return 3000 + discovery.score;
  }

  if (hasSource(candidate, "store-featured:")) {
    return 1500 + discovery.score;
  }

  return discovery.score;
}

function previousChartRanks(previous?: HomeModel): Map<string, number> {
  const ranks = new Map<string, number>();
  previous?.popularNow.forEach((game, index) => ranks.set(game.id, index + 1));
  return ranks;
}

function candidateGameId(candidate: Candidate): string {
  return makeGameId("steam", candidate.appid);
}

export type ResolveDiscoveryGamesParams = {
  fetchImpl?: typeof fetch;
  /** Display signal shown on each card (e.g. "In your discovery queue"). */
  signal: string;
  /** Discovery source tag stored on each game (e.g. "discovery:queue"). */
  sourceTag: string;
  /** Games owned by the user, excluded from the result. Keyed `provider:externalId`. */
  ownedIds?: Set<string>;
  /** Max appids to resolve metadata for (default {@link APPID_ROW_FETCH_LIMIT}). */
  fetchLimit?: number;
  /** Max games returned (default {@link APPID_ROW_VISIBLE_LIMIT}). */
  visibleLimit?: number;
  logger?: RecommendationLogger;
};

// Turns an externally supplied appid list (personalised recommendations, the discovery
// queue, curated top releases) into discovery games. Titles, correct vertical capsule art,
// and review quality all come from one batched GetItems call — no per-appid enrichment, so
// these rows can't be starved by Steam rate-limiting the way the hero enrichment can be.
// Ordering follows Steam's own ordering of the appids.
export async function resolveDiscoveryGames(appIds: string[], params: ResolveDiscoveryGamesParams): Promise<Game[]> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const ownedIds = params.ownedIds ?? new Set<string>();
  const fetchLimit = params.fetchLimit ?? APPID_ROW_FETCH_LIMIT;
  const visibleLimit = params.visibleLimit ?? APPID_ROW_VISIBLE_LIMIT;

  const orderedIds: string[] = [];
  const seen = new Set<string>();
  for (const appid of appIds) {
    const trimmed = String(appid).trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    orderedIds.push(trimmed);
  }
  if (orderedIds.length === 0) {
    return [];
  }

  const items = await fetchStoreItems(orderedIds.slice(0, fetchLimit), fetchImpl, params.logger);
  const row: Game[] = [];
  for (const appid of orderedIds) {
    const item = items.get(appid);
    if (!item) {
      continue;
    }
    // Games only (drop DLC/soundtracks/hardware) and anything Steam marks not visible.
    if ((item.type !== undefined && item.type !== 0) || item.visible === false) {
      continue;
    }
    const id = makeGameId("steam", appid);
    if (ownedIds.has(id)) {
      continue;
    }
    if (!isHomeHeroSafe({ title: item.name, genres: [], tags: [], contentDescriptors: [], shortDescription: item.shortDescription })) {
      continue;
    }

    const headerUrl = item.headerUrl ?? officialSteamHeaderUrl(appid);
    row.push({
      ...emptyGame(appid, item.name),
      coverUrl: item.coverUrl,
      libraryCapsuleUrl: item.coverUrl,
      headerUrl,
      backgroundUrl: item.backgroundUrl ?? headerUrl,
      releaseDate: item.releaseDate,
      metadataStatus: "partial",
      discovery: {
        score: (item.reviewScore ?? 0) * 10 + (item.percentPositive ?? 0) / 10,
        signal: params.signal,
        sources: [params.sourceTag],
        storeCategory: item.reviewLabel,
        priceText: item.priceText,
        originalPriceText: item.originalPriceText,
        discountPercent: item.discountPercent,
        storeUrl: item.storeUrl
      }
    });
    if (row.length >= visibleLimit) {
      break;
    }
  }
  return uniqueGames(row);
}

function buildAppIdRow(spec: AppIdRowSpec, fetchImpl: typeof fetch, ownedIds: Set<string>, options: BuildHomeOptions): Promise<Game[]> {
  return resolveDiscoveryGames(spec.appIds, {
    fetchImpl,
    signal: spec.signal,
    sourceTag: spec.sourceTag,
    ownedIds,
    logger: options.logger
  });
}

export async function buildHomeModel(localGames: Game[], fetchImpl: typeof fetch = fetch, previous?: HomeModel, options: BuildHomeOptions = {}): Promise<HomeModel> {
  const previousRanks = previousChartRanks(previous);
  const cachedGames = previousDiscoveryGames(previous);
  const sources = await fetchDiscoverySources(fetchImpl, options.logger, options.discoverySourceFetchTimeoutMs);
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
  const enrichmentCandidates = mergeCandidates(prioritized.map((item) => item.candidate));
  const feedGames = enrichmentCandidates.map((candidate) => gameFromCandidate(candidate, scoreCandidate(candidate, previousRanks)));
  const enriched = [
    ...feedGames,
    ...(await enrichWithinBudget(enrichmentCandidates, previousRanks, fetchImpl, cachedGames, options))
  ]
    .filter((game): game is Game => Boolean(game))
    .filter((game) => !/^Steam App \d+$/i.test(game.title));

  const ownedIds = new Set(localGames.flatMap((game) => game.sourceIds.map((source) => `${source.provider}:${source.externalId}`)));
  const enrichedById = new Map(enriched.map((game) => [game.id, game]));
  const heroPool = uniqueGames(
    prioritized
      .map((item) => enrichedById.get(candidateGameId(item.candidate)))
      .filter((game): game is Game => Boolean(game))
      .filter((game) => !ownedIds.has(game.id))
  );
  const rejectedHeroGames = heroPool
    .map((game) => ({ game, reason: homeHeroSafetyReason(game) }))
    .filter((item): item is { game: Game; reason: string } => Boolean(item.reason));
  if (rejectedHeroGames.length > 0) {
    options.logger?.({
      level: "info",
      phase: "home:discovery",
      message: "Home hero NSFW filter excluded discovery games",
      details: {
        excluded: rejectedHeroGames.slice(0, 20).map(({ game, reason }) => ({
          id: game.id,
          title: game.title,
          reason,
          genres: game.genres,
          tags: game.tags,
          contentDescriptors: game.contentDescriptors
        })),
        totalExcluded: rejectedHeroGames.length
      }
    });
  }
  const popularNow = uniqueGames(
    heroPool.filter(isHomeHeroSafe)
  ).slice(0, 20);

  // Supplemental personalised / curated rows. Each is best-effort: a missing or empty
  // appid list simply yields an empty row rather than failing the whole rebuild.
  const appIdRowSpecs: AppIdRowSpec[] = [
    { row: "recommended", appIds: options.recommendedAppIds ?? [], sourceTag: "userdata:recommended", signal: "Recommended for you" },
    { row: "newAndNotable", appIds: options.topReleaseAppIds ?? [], sourceTag: "charts:top_releases", signal: "Top new release" },
    { row: "discoveryQueue", appIds: options.discoveryQueueAppIds ?? [], sourceTag: "discovery:queue", signal: "In your discovery queue" }
  ];
  // Sequential (not Promise.all): each row is one batched GetItems call; running them in turn
  // keeps outbound Steam requests modest and ordering deterministic.
  const appIdRows: Record<AppIdRowSpec["row"], Game[]> = { recommended: [], newAndNotable: [], discoveryQueue: [] };
  for (const spec of appIdRowSpecs) {
    const built = await buildAppIdRow(spec, fetchImpl, ownedIds, options);
    // Preserve the previous row when a fetch comes back empty. These sources need a live
    // (and sometimes auth'd) Steam session, so an empty result is almost always a transient
    // failure (401 / rate limit) rather than a genuinely empty row — don't wipe good data.
    if (built.length === 0) {
      const carried = (previous?.[spec.row] ?? []).filter((game) => !ownedIds.has(game.id));
      if (carried.length > 0) {
        options.logger?.({
          level: "warning",
          phase: "home:discovery",
          message: `${spec.row} fetch was empty; keeping ${carried.length} previous games`,
          details: { sourceTag: spec.sourceTag }
        });
        appIdRows[spec.row] = carried;
        continue;
      }
    }
    appIdRows[spec.row] = built;
  }
  const { recommended, newAndNotable, discoveryQueue } = appIdRows;

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
    recommended,
    newAndNotable,
    discoveryQueue,
    generatedAt: new Date().toISOString(),
    stale: false,
    cacheVersion: HOME_DISCOVERY_CACHE_VERSION
  };
}
