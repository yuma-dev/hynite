import { session } from "electron";
import { repairSteamLoginCookies, steamFamilySessionPartition } from "./steamAuthService";

/**
 * Personalised + curated Steam discovery sources for the Home page, fetched as plain
 * JSON with the logged-in store session — no webview render. The two personalised
 * endpoints reuse the same persistent partition the Steam store tab is logged into
 * ({@link steamFamilySessionPartition}); the curated one is a public Web API call.
 *
 * Every fetcher is best-effort: any failure (logged out, rate limited, shape change)
 * resolves to an empty list so the Home rebuild degrades gracefully.
 */

export type DiscoveryFetchLogEntry = {
  level: "info" | "warning" | "error";
  phase: string;
  message: string;
  details?: Record<string, unknown>;
};

export type DiscoveryFetchLogger = (entry: DiscoveryFetchLogEntry) => void;

const STORE_ORIGIN = "https://store.steampowered.com";
const USERDATA_URL = `${STORE_ORIGIN}/dynamicstore/userdata/`;
const DISCOVERY_QUEUE_URL = `${STORE_ORIGIN}/explore/generatenewdiscoveryqueue`;
const DISCOVERY_QUEUE_WEBAPI_URL = "https://api.steampowered.com/IStoreService/GetDiscoveryQueue/v1/";
const TOP_RELEASES_URL = "https://api.steampowered.com/ISteamChartsService/GetTopReleasesPages/v1/";
const FETCH_TIMEOUT_MS = 10_000;
const STORE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9"
};

function normalizeAppIds(values: unknown, cap = 60): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    // Entries can be a bare appid number, a numeric string, or an object holding one.
    const raw =
      typeof value === "object" && value !== null
        ? ((value as Record<string, unknown>).appid ?? (value as Record<string, unknown>).id)
        : value;
    const num = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    if (!Number.isFinite(num) || num <= 0) {
      continue;
    }
    const appid = String(Math.trunc(num));
    if (seen.has(appid)) {
      continue;
    }
    seen.add(appid);
    out.push(appid);
    if (out.length >= cap) {
      break;
    }
  }
  return out;
}

// Electron's Session.fetch and the global fetch have slightly different input types; both
// satisfy this minimal shape (we only ever pass a string URL).
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function fetchWithTimeout(fetchImpl: FetchLike, input: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * "Recommended for you" — the appids Steam surfaces on your logged-in store homepage,
 * read from dynamicstore/userdata (`rgRecommendedApps`). Requires the store login cookie.
 */
export async function fetchRecommendedAppIds(steamId: string, logger?: DiscoveryFetchLogger): Promise<string[]> {
  try {
    const partition = session.fromPartition(steamFamilySessionPartition(steamId));
    const response = await fetchWithTimeout(partition.fetch.bind(partition), `${USERDATA_URL}?t=0`, {
      credentials: "include",
      headers: STORE_HEADERS
    });
    if (!response.ok) {
      logger?.({ level: "warning", phase: "home:discovery", message: `dynamicstore userdata returned ${response.status}` });
      return [];
    }
    const json = (await response.json()) as Record<string, unknown>;
    const appIds = normalizeAppIds(json.rgRecommendedApps);
    logger?.({
      level: appIds.length ? "info" : "warning",
      phase: "home:discovery",
      message: `Recommended-for-you appids: ${appIds.length}`,
      details: { keys: Object.keys(json).slice(0, 20) }
    });
    return appIds;
  } catch (error) {
    logger?.({
      level: "warning",
      phase: "home:discovery",
      message: "Recommended-for-you fetch failed",
      details: { error: error instanceof Error ? error.message : String(error) }
    });
    return [];
  }
}

async function readSessionId(steamId: string): Promise<string | undefined> {
  const partition = session.fromPartition(steamFamilySessionPartition(steamId));
  const cookies = await partition.cookies.get({ name: "sessionid" });
  const storeCookie =
    cookies.find((cookie) => (cookie.domain ?? "").replace(/^\./, "").endsWith("steampowered.com")) ?? cookies[0];
  return storeCookie?.value;
}

/**
 * Steam only mints the `sessionid` cookie on a real store page load. Prime it with a single
 * store-home GET (sets the cookie in the partition jar) then read it back. `force` re-primes
 * even when a cookie already exists, to replace a stale one that the server has rotated.
 */
async function storeSessionId(steamId: string, force = false): Promise<string | undefined> {
  if (!force) {
    const existing = await readSessionId(steamId);
    if (existing) {
      return existing;
    }
  }
  try {
    const partition = session.fromPartition(steamFamilySessionPartition(steamId));
    await fetchWithTimeout(partition.fetch.bind(partition), `${STORE_ORIGIN}/`, { credentials: "include", headers: STORE_HEADERS });
  } catch {
    // ignore — we just want the Set-Cookie side effect
  }
  return readSessionId(steamId);
}

async function postDiscoveryQueue(steamId: string, sessionId: string): Promise<Response> {
  const partition = session.fromPartition(steamFamilySessionPartition(steamId));
  const body = new URLSearchParams({ queuetype: "0", sessionid: sessionId });
  return fetchWithTimeout(partition.fetch.bind(partition), DISCOVERY_QUEUE_URL, {
    method: "POST",
    credentials: "include",
    headers: {
      ...STORE_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
      Origin: STORE_ORIGIN,
      Referer: `${STORE_ORIGIN}/explore/`
    },
    body: body.toString()
  });
}

/**
 * "Discovery queue" via the authenticated WebAPI using the family `access_token` the app
 * already refreshes. This needs NO store cookie and NO open Steam tab — the robust path.
 * `rebuild_queue` regenerates a fresh queue each call (variety for the infinite row).
 */
async function fetchDiscoveryQueueViaToken(accessToken: string, logger?: DiscoveryFetchLogger): Promise<string[]> {
  const params = new URLSearchParams({
    access_token: accessToken,
    queue_type: "0",
    country_code: "DE",
    rebuild_queue: "true",
    settings_changed: "0"
  });
  const response = await fetchWithTimeout(fetch, `${DISCOVERY_QUEUE_WEBAPI_URL}?${params.toString()}`, { headers: STORE_HEADERS });
  if (!response.ok) {
    logger?.({ level: "warning", phase: "home:discovery", message: `Discovery queue (webapi) returned ${response.status}` });
    return [];
  }
  const json = (await response.json()) as { response?: Record<string, unknown> };
  const resp = json.response ?? {};
  const appIds = normalizeAppIds(resp.appids ?? resp.queue ?? resp.appid_data);
  logger?.({
    level: appIds.length ? "info" : "warning",
    phase: "home:discovery",
    message: `Discovery queue (webapi) appids: ${appIds.length}`,
    details: { keys: Object.keys(resp).slice(0, 20) }
  });
  return appIds;
}

/**
 * "Discovery queue" — a fresh personalised queue of ~12 games. Prefers the authenticated
 * WebAPI (`access_token`, no cookies / no Steam tab needed); falls back to the cookie-based
 * generatenewdiscoveryqueue POST only when no token is available. The cookie path heals
 * duplicate login cookies and retries once with a re-primed sessionid on 401/403.
 */
export async function fetchDiscoveryQueueAppIds(
  steamId: string,
  logger?: DiscoveryFetchLogger,
  accessToken?: string
): Promise<string[]> {
  if (accessToken) {
    const viaToken = await fetchDiscoveryQueueViaToken(accessToken, logger).catch(() => [] as string[]);
    if (viaToken.length > 0) {
      return viaToken;
    }
    // Token path returned nothing — fall through to the cookie path as a backup.
  }

  try {
    // Collapse duplicate/stale steamLoginSecure cookies so the POST reads a valid session,
    // exactly like the store webview does before it loads.
    await repairSteamLoginCookies(steamId).catch(() => false);

    let sessionId = await storeSessionId(steamId);
    if (!sessionId) {
      logger?.({ level: "warning", phase: "home:discovery", message: "Discovery queue skipped: no store sessionid cookie" });
      return [];
    }

    let response = await postDiscoveryQueue(steamId, sessionId);
    if (response.status === 401 || response.status === 403) {
      // Likely a stale sessionid — force a fresh one and retry once.
      sessionId = await storeSessionId(steamId, true);
      if (sessionId) {
        response = await postDiscoveryQueue(steamId, sessionId);
      }
    }

    if (!response.ok) {
      logger?.({ level: "warning", phase: "home:discovery", message: `Discovery queue returned ${response.status}` });
      return [];
    }
    const json = (await response.json()) as Record<string, unknown>;
    const appIds = normalizeAppIds(json.queue);
    logger?.({
      level: appIds.length ? "info" : "warning",
      phase: "home:discovery",
      message: `Discovery queue appids: ${appIds.length}`,
      details: { keys: Object.keys(json).slice(0, 20) }
    });
    return appIds;
  } catch (error) {
    logger?.({
      level: "warning",
      phase: "home:discovery",
      message: "Discovery queue fetch failed",
      details: { error: error instanceof Error ? error.message : String(error) }
    });
    return [];
  }
}

type TopReleasesResponse = {
  response?: {
    pages?: Array<{ name?: string; start_of_month?: number; item_ids?: Array<{ appid?: number }> }>;
  };
};

/**
 * "Top new releases" — Steam's own curated monthly Top Releases lists (quality-gated by
 * design). Public Web API, no auth. Takes the most recent months first, newest month leading.
 */
export async function fetchTopNewReleaseAppIds(
  fetchImpl: typeof fetch = fetch,
  logger?: DiscoveryFetchLogger
): Promise<string[]> {
  try {
    const response = await fetchWithTimeout(fetchImpl, TOP_RELEASES_URL, { headers: STORE_HEADERS });
    if (!response.ok) {
      logger?.({ level: "warning", phase: "home:discovery", message: `Top releases returned ${response.status}` });
      return [];
    }
    const json = (await response.json()) as TopReleasesResponse;
    const pages = [...(json.response?.pages ?? [])].sort((a, b) => (b.start_of_month ?? 0) - (a.start_of_month ?? 0));
    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const page of pages) {
      for (const appid of normalizeAppIds(page.item_ids)) {
        if (seen.has(appid)) {
          continue;
        }
        seen.add(appid);
        ordered.push(appid);
      }
    }
    logger?.({
      level: ordered.length ? "info" : "warning",
      phase: "home:discovery",
      message: `Top new-release appids: ${ordered.length}`,
      details: { pages: pages.length, latest: pages[0]?.name }
    });
    return ordered.slice(0, 60);
  } catch (error) {
    logger?.({
      level: "warning",
      phase: "home:discovery",
      message: "Top new releases fetch failed",
      details: { error: error instanceof Error ? error.message : String(error) }
    });
    return [];
  }
}

export type SteamDiscoveryAppIds = {
  recommendedAppIds: string[];
  discoveryQueueAppIds: string[];
  topReleaseAppIds: string[];
};

/** Fetch all three supplemental discovery sources for a primary account, best-effort. */
export async function fetchSteamDiscoveryAppIds(
  steamId: string | undefined,
  accessToken: string | undefined,
  logger?: DiscoveryFetchLogger
): Promise<SteamDiscoveryAppIds> {
  const [recommendedAppIds, discoveryQueueAppIds, topReleaseAppIds] = await Promise.all([
    steamId ? fetchRecommendedAppIds(steamId, logger) : Promise.resolve([]),
    steamId ? fetchDiscoveryQueueAppIds(steamId, logger, accessToken) : Promise.resolve([]),
    fetchTopNewReleaseAppIds(fetch, logger)
  ]);
  return { recommendedAppIds, discoveryQueueAppIds, topReleaseAppIds };
}
