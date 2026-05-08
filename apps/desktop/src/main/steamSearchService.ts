import type { SteamSearchResult } from "@hynite/core";
import { normalizeTitle } from "@hynite/source-search";

type StoreSearchItem = {
  type?: string;
  name?: string;
  id?: number | string;
  tiny_image?: string;
  metascore?: string | number;
  price?: {
    final?: number;
  };
};

type StoreSearchResponse = {
  items?: StoreSearchItem[];
};

type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

const STEAM_SEARCH_LIMIT = 30;
const STORE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9"
};

function formatPrice(cents: number | undefined): string | undefined {
  if (cents === undefined) return undefined;
  if (cents === 0) return "Free";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function resultFromItem(item: StoreSearchItem): SteamSearchResult | undefined {
  if (item.type && item.type !== "app") return undefined;
  const appId = item.id === undefined ? undefined : String(item.id);
  const title = item.name?.trim();
  if (!appId || !title) return undefined;
  return {
    appId,
    title,
    capsuleUrl: item.tiny_image || `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/capsule_231x87.jpg`,
    price: formatPrice(item.price?.final),
    reviewSummary: item.metascore !== undefined && String(item.metascore).trim() ? `Metascore ${item.metascore}` : undefined
  };
}

function scoreResult(query: string, result: SteamSearchResult): number {
  const normalizedQuery = normalizeTitle(query);
  const normalizedTitle = normalizeTitle(result.title);
  if (!normalizedQuery || !normalizedTitle) return 0;
  if (normalizedQuery === normalizedTitle) return 1;
  if (normalizedTitle.startsWith(normalizedQuery)) return 0.92;
  const queryWords = normalizedQuery.split(" ").filter(Boolean);
  const titleWords = normalizedTitle.split(" ").filter(Boolean);
  if (queryWords.length > 0 && queryWords.every((word) => normalizedTitle.includes(word))) return 0.86;
  const partials = queryWords.filter((word) => titleWords.some((titleWord) => titleWord.includes(word) || word.includes(titleWord))).length;
  if (partials > 0) return 0.45 + (partials / queryWords.length) * 0.35;
  return 0;
}

function fallbackQueries(query: string): string[] {
  const normalized = normalizeTitle(query);
  const words = normalized.split(" ").filter((word) => word.length >= 3);
  const bigrams = words.slice(0, -1).map((word, index) => `${word} ${words[index + 1]}`);
  return [...new Set([...bigrams, ...words])].filter((candidate) => candidate !== query.trim() && candidate !== normalized);
}

async function fetchStoreSearch(fetchImpl: FetchLike, query: string): Promise<SteamSearchResult[]> {
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(query)}&l=english&cc=us`;
  const response = await fetchImpl(url, { headers: STORE_HEADERS });
  if (!response.ok) return [];
  const data = (await response.json()) as StoreSearchResponse;
  return (data.items ?? []).flatMap((item) => {
    const result = resultFromItem(item);
    return result ? [result] : [];
  });
}

export async function searchSteamStore(query: string, fetchImpl: FetchLike): Promise<SteamSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const resultsById = new Map<string, { result: SteamSearchResult; primary: boolean }>();
  const primaryResults = await fetchStoreSearch(fetchImpl, trimmed);
  for (const result of primaryResults) {
    resultsById.set(result.appId, { result, primary: true });
  }

  const bestPrimaryScore = Math.max(0, ...primaryResults.map((result) => scoreResult(trimmed, result)));
  if (primaryResults.length < 5 || bestPrimaryScore < 0.7) {
    for (const fallbackQuery of fallbackQueries(trimmed)) {
      const fallbackResults = await fetchStoreSearch(fetchImpl, fallbackQuery);
      for (const result of fallbackResults) {
        if (!resultsById.has(result.appId)) {
          resultsById.set(result.appId, { result, primary: false });
        }
      }
      if (resultsById.size >= STEAM_SEARCH_LIMIT) break;
    }
  }

  return [...resultsById.values()]
    .map((entry) => ({
      ...entry,
      score: scoreResult(trimmed, entry.result)
    }))
    .sort((a, b) => Number(b.primary) - Number(a.primary) || b.score - a.score || a.result.title.localeCompare(b.result.title))
    .slice(0, STEAM_SEARCH_LIMIT)
    .map((entry) => entry.result);
}
