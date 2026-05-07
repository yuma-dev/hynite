import { type Game, type GameDiscovery, type HomeModel, makeGameId, makeSortTitle } from "@hynite/core";
import { fetchSteamMetadata } from "@hynite/metadata";

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
    developers: [],
    publishers: [],
    contentDescriptors: [],
    metadataStatus: "none"
  };
}

function activityTime(game: Game): number {
  return Math.max(Date.parse(game.lastPlayedAt ?? "") || 0, Date.parse(game.addedAt ?? "") || 0);
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
  const response = await fetchImpl("https://store.steampowered.com/api/featuredcategories/?cc=US&l=english");
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
    const categoryWeight = categoryId === "top_sellers" ? 1 : categoryId === "new_releases" || categoryId === "coming_soon" ? 0.85 : 0.5;
    const newnessWeight = categoryId === "new_releases" || categoryId === "coming_soon" ? 1 : 0;
    const storeCategory = category.name ?? categoryId.replace(/_/g, " ");
    category.items.slice(0, 24).forEach((item, index) => {
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
        sources: new Set([`featured:${categoryId || "category"}`])
      });
    });
  }

  return [...candidates.values()];
}

async function fetchStoreFeatured(fetchImpl: typeof fetch): Promise<Candidate[]> {
  const response = await fetchImpl("https://store.steampowered.com/api/featured/?cc=US&l=english");
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
    items?.slice(0, 24).forEach((item, index) => {
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
  return rows.slice(0, 40).map((row, index) => ({
    appid: row.groups?.appid ?? "",
    title: decodeHtml(row.groups?.name ?? ""),
    headerUrl: row.groups?.image,
    sources: new Set([`steamspy-trending:${index + 1}`]),
    trendRank: index + 1,
    featuredWeight: 0,
    newnessWeight: 0.8,
    owners: row.groups?.owners ? `${row.groups.owners}+` : undefined
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
  const response = await fetchImpl("https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/?format=json");
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

async function discoveryCandidates(fetchImpl: typeof fetch): Promise<Candidate[]> {
  const results = await Promise.allSettled([
    fetchStoreFeatured(fetchImpl),
    fetchFeaturedCategories(fetchImpl)
  ]);
  const candidates = new Map<string, Candidate>();

  for (const result of results) {
    if (result.status !== "fulfilled") {
      continue;
    }

    for (const candidate of result.value) {
      mergeCandidate(candidates, candidate.appid, candidate);
    }
  }

  if (candidates.size === 0) {
    for (const item of fallbackPopular) {
      mergeCandidate(candidates, item.appid, { title: item.title, sources: new Set(["fallback"]), featuredWeight: 0.4, newnessWeight: 0 });
    }
  }

  return [...candidates.values()];
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
    candidate.sources.has("featured:new_releases")
      ? "New release"
      : candidate.sources.has("featured:coming_soon")
        ? "Coming soon"
        : candidate.sources.has("featured:top_sellers")
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
  for (const game of [...(previous?.popularNow ?? []), ...(previous?.recommended ?? []), ...(previous?.newAndNotable ?? [])]) {
    if (game.metadataStatus !== "none" && !/^Steam App \d+$/i.test(game.title)) {
      games.set(game.id, game);
    }
  }

  return games;
}

async function enrichCandidate(candidate: Candidate, discovery: GameDiscovery, fetchImpl: typeof fetch, cachedGames: Map<string, Game>): Promise<Game | undefined> {
  const fallbackTitle = candidate.title?.trim();
  if (!fallbackTitle) {
    return undefined;
  }

  const base = emptyGame(candidate.appid, fallbackTitle);
  const cached = cachedGames.get(base.id);
  if (cached) {
    return {
      ...cached,
      discovery,
      headerUrl: cached.headerUrl ?? candidate.headerUrl,
      metadataStatus: cached.metadataStatus
    };
  }

  try {
    const metadata = await fetchSteamMetadata(candidate.appid, fetchImpl);
    const title = metadata.title ?? fallbackTitle;
    const libraryCapsuleUrl = `https://cdn.akamai.steamstatic.com/steam/apps/${encodeURIComponent(candidate.appid)}/library_600x900.jpg`;
    return {
      ...base,
      ...metadata,
      id: base.id,
      title,
      sortTitle: makeSortTitle(title),
      coverUrl: metadata.coverUrl ?? libraryCapsuleUrl,
      libraryCapsuleUrl: metadata.libraryCapsuleUrl ?? libraryCapsuleUrl,
      headerUrl: metadata.headerUrl ?? candidate.headerUrl,
      discovery,
      metadataStatus: metadata.metadataStatus ?? "partial",
      screenshots: metadata.screenshots ?? [],
      genres: metadata.genres ?? [],
      tags: metadata.tags ?? [],
      developers: metadata.developers ?? [],
      publishers: metadata.publishers ?? [],
      contentDescriptors: metadata.contentDescriptors ?? []
    };
  } catch {
    return {
      ...base,
      headerUrl: candidate.headerUrl,
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

  if (hasSource(candidate, "featured:top_sellers")) {
    return 3000 + discovery.score;
  }

  if (hasSource(candidate, "featured:new_releases") || hasSource(candidate, "featured:coming_soon")) {
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
  return ranks;
}

export async function buildHomeModel(localGames: Game[], fetchImpl: typeof fetch = fetch, previous?: HomeModel): Promise<HomeModel> {
  const previousRanks = previousChartRanks(previous);
  const cachedGames = previousDiscoveryGames(previous);
  const candidates = await discoveryCandidates(fetchImpl);
  const prioritized = candidates
    .map((candidate) => ({ candidate, discovery: scoreCandidate(candidate, previousRanks) }))
    .sort((a, b) => candidatePriority(b.candidate, b.discovery) - candidatePriority(a.candidate, a.discovery))
    .slice(0, 72);
  const enriched = (
    await Promise.all(
      prioritized.map((item) => enrichCandidate(item.candidate, item.discovery, fetchImpl, cachedGames))
    )
  )
    .filter((game): game is Game => Boolean(game))
    .filter((game) => !/^Steam App \d+$/i.test(game.title));

  const ownedIds = new Set(localGames.flatMap((game) => game.sourceIds.map((source) => `${source.provider}:${source.externalId}`)));
  const discoverable = enriched.filter((game) => !ownedIds.has(game.id));
  const popularNow = uniqueGames(discoverable).slice(0, 20);
  const recentActivity = [...localGames].sort((a, b) => activityTime(b) - activityTime(a)).slice(0, 10);
  const continuePlaying = [...localGames]
    .filter((game) => game.lastPlayedAt)
    .sort((a, b) => (Date.parse(b.lastPlayedAt ?? "") || 0) - (Date.parse(a.lastPlayedAt ?? "") || 0))
    .slice(0, 8);
  const mostPlayed = [...localGames].sort((a, b) => (b.playtimeMinutes ?? 0) - (a.playtimeMinutes ?? 0)).slice(0, 8);

  return {
    recentActivity,
    continuePlaying,
    mostPlayed,
    popularNow,
    recommended: [],
    newAndNotable: [],
    generatedAt: new Date().toISOString(),
    stale: false
  };
}
