import { existsSync } from "node:fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { HyniteRepository } from "@hynite/db";
import type {
  AppSettings,
  Game,
  GameSoundtrack,
  OstDownloadProgress,
  OstResolveResult,
  OstScoredResult,
  OstSearchPreview,
  OstSettings,
  OstSourceMode,
  YoutubeSearchResult
} from "@hynite/core";
import type { YtdlpService } from "./ytdlpService";

const BUILTIN_REJECT_KEYWORDS = [
  "gameplay", "walkthrough", "trailer", "reaction", "review",
  "let's play", "lets play", "playthrough", "speedrun", "speed run",
  "tutorial", "guide", "tier list", "podcast", "stream highlight"
];

const POSITIVE_PATTERNS: Array<{ regex: RegExp; weight: number }> = [
  { regex: /\boriginal\s+soundtrack\b/i, weight: 3 },
  { regex: /\bost\b/i, weight: 2 },
  { regex: /\bfull\s+album\b/i, weight: 3 },
  { regex: /\bcomplete\s+(soundtrack|ost)\b/i, weight: 3 },
  { regex: /\bsoundtrack\b/i, weight: 1 },
  { regex: /\bmain\s+theme\b/i, weight: 1 }
];

function splitKeywords(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

function scoreResult(
  result: YoutubeSearchResult,
  gameTitle: string,
  settings: OstSettings
): OstScoredResult {
  const titleLower = result.title.toLowerCase();
  const channelLower = (result.channel ?? "").toLowerCase();
  const duration = result.durationSeconds ?? 0;

  // Hard duration filters
  const minSec = settings.minDurationSeconds ?? 0;
  const maxSec = settings.maxDurationSeconds ?? 0;
  if (minSec > 0 && duration > 0 && duration < minSec) {
    return { ...result, score: 0, rejected: true, rejectReason: `shorter than ${minSec}s` };
  }
  if (maxSec > 0 && duration > 0 && duration > maxSec) {
    return { ...result, score: 0, rejected: true, rejectReason: `longer than ${maxSec}s` };
  }

  // Keyword rejection (opt-in)
  const customRejects = splitKeywords(settings.customRejectKeywords);
  const builtinHit = settings.filterRejectKeywords === true
    ? BUILTIN_REJECT_KEYWORDS.find((k) => titleLower.includes(k))
    : undefined;
  const customHit = customRejects.find((k) => titleLower.includes(k));
  if (builtinHit) {
    return { ...result, score: 0, rejected: true, rejectReason: `contains "${builtinHit}"` };
  }
  if (customHit) {
    return { ...result, score: 0, rejected: true, rejectReason: `custom reject: "${customHit}"` };
  }

  // Title word match (opt-in hard requirement)
  const gameWords = gameTitle.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
  const matched = gameWords.filter((w) => titleLower.includes(w)).length;
  const ratio = gameWords.length > 0 ? matched / gameWords.length : 1;
  if (settings.requireTitleWordMatch === true && ratio < 0.4) {
    return { ...result, score: 0, rejected: true, rejectReason: "title doesn't match game" };
  }

  // Ranking signals
  let score = 0;
  for (const { regex, weight } of POSITIVE_PATTERNS) {
    if (regex.test(result.title)) score += weight;
  }
  for (const k of splitKeywords(settings.customBoostKeywords)) {
    if (titleLower.includes(k)) score += 2;
  }

  if (settings.preferLongUploads !== false) {
    if (duration >= 3600) score += 4;
    else if (duration >= 1200) score += 2;
    else if (duration > 0 && duration < 300) score -= 1;
  }

  if (result.viewCount && result.viewCount > 0) {
    score += Math.min(2.5, Math.log10(result.viewCount + 1) / 3);
  }

  if (gameWords.length > 0) score += ratio * 2;

  if (settings.preferOfficialChannels !== false) {
    if (channelLower.includes("topic")) score += 2;       // YT auto artist channels
    if (channelLower.includes("official")) score += 1;
    if (channelLower.includes("- topic")) score += 1;
  }

  return { ...result, score, rejected: false };
}

function rankResults(results: YoutubeSearchResult[], gameTitle: string, settings: OstSettings): OstScoredResult[] {
  return results
    .map((r) => scoreResult(r, gameTitle, settings))
    .sort((a, b) => {
      if (a.rejected !== b.rejected) return a.rejected ? 1 : -1;
      return b.score - a.score;
    });
}

function buildQuery(template: string, game: Game): string {
  const year = game.releaseDate ? new Date(game.releaseDate).getUTCFullYear() : "";
  return template
    .replace(/\{title\}/gi, game.title)
    .replace(/\{year\}/gi, Number.isFinite(year as number) && year ? String(year) : "")
    .trim();
}

function parseYoutubeVideoId(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("youtu.be")) {
      return parsed.pathname.replace(/^\//, "") || undefined;
    }
    const v = parsed.searchParams.get("v");
    if (v) return v;
    const match = parsed.pathname.match(/\/(?:embed|shorts|v)\/([^/?#]+)/);
    if (match) return match[1];
  } catch {
    // not a URL — maybe a bare id
    if (/^[\w-]{11}$/.test(url)) return url;
  }
  return undefined;
}

const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;

type SearchCacheEntry = { results: YoutubeSearchResult[]; expiresAt: number };

export class SoundtrackService {
  private cacheDir: string;
  private resolveInFlight = new Map<string, Promise<OstResolveResult>>();
  private listeners = new Set<(progress: OstDownloadProgress) => void>();
  private searchCache = new Map<string, SearchCacheEntry>();

  constructor(
    cacheRoot: string,
    private readonly repository: HyniteRepository,
    private readonly ytdlp: YtdlpService,
    private readonly getSettings: () => Promise<AppSettings>
  ) {
    this.cacheDir = cacheRoot;
  }

  subscribe(listener: (progress: OstDownloadProgress) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(progress: OstDownloadProgress): void {
    for (const listener of this.listeners) listener(progress);
  }

  getCacheDir(): string {
    return this.cacheDir;
  }

  async cacheStats(): Promise<{ totalBytes: number; entryCount: number }> {
    if (!existsSync(this.cacheDir)) return { totalBytes: 0, entryCount: 0 };
    let totalBytes = 0;
    let entryCount = 0;
    try {
      const files = await readdir(this.cacheDir);
      for (const name of files) {
        try {
          const s = await stat(join(this.cacheDir, name));
          if (s.isFile()) {
            totalBytes += s.size;
            entryCount += 1;
          }
        } catch { /* skip */ }
      }
    } catch { /* missing dir */ }
    return { totalBytes, entryCount };
  }

  async pickGameForSource(settings: OstSettings, excludeGameIds: string[] = []): Promise<Game | undefined> {
    const games = this.repository.listGames();
    const installed = games.filter((g) => g.installState === "installed");
    const pool = (installed.length > 0 ? installed : games).filter((g) => !excludeGameIds.includes(g.id));
    if (pool.length === 0) return undefined;

    switch (settings.source as OstSourceMode | undefined) {
      case "mostPlayed": {
        const sorted = [...pool].sort((a, b) => (b.playtimeMinutes ?? 0) - (a.playtimeMinutes ?? 0));
        return sorted[0];
      }
      case "random": {
        return pool[Math.floor(Math.random() * pool.length)];
      }
      case "favorites": {
        const favs = new Set(settings.favorites ?? []);
        const favPool = pool.filter((g) => favs.has(g.id));
        if (favPool.length === 0) return undefined;
        return favPool[Math.floor(Math.random() * favPool.length)];
      }
      case "lastPlayed":
      default: {
        const withPlayed = pool.filter((g) => g.lastPlayedAt);
        const sorted = withPlayed.length > 0
          ? withPlayed.sort((a, b) => Date.parse(b.lastPlayedAt!) - Date.parse(a.lastPlayedAt!))
          : [...pool].sort((a, b) => (b.playtimeMinutes ?? 0) - (a.playtimeMinutes ?? 0));
        return sorted[0];
      }
    }
  }

  private searchCacheKey(query: string, limit: number, thorough: boolean): string {
    return `${thorough ? "T" : "F"}:${limit}:${query}`;
  }

  private async cachedSearch(query: string, limit: number, thorough: boolean): Promise<{ results: YoutubeSearchResult[]; cached: boolean }> {
    const key = this.searchCacheKey(query, limit, thorough);
    const entry = this.searchCache.get(key);
    if (entry && entry.expiresAt > Date.now()) {
      return { results: entry.results, cached: true };
    }
    const results = await this.ytdlp.search(query, limit, { thorough });
    this.searchCache.set(key, { results, expiresAt: Date.now() + SEARCH_CACHE_TTL_MS });
    return { results, cached: false };
  }

  clearSearchCache(): void {
    this.searchCache.clear();
  }

  async pickVideoForGame(game: Game, settings: OstSettings): Promise<YoutubeSearchResult | undefined> {
    const query = buildQuery(settings.queryTemplate ?? "{title} Game Original Soundtrack", game);
    this.emit({ gameId: game.id, videoId: "", phase: "searching", message: query });
    const t0 = Date.now();
    const limit = settings.searchResultLimit ?? 8;
    const { results, cached } = await this.cachedSearch(query, limit, settings.thoroughSearch === true);
    this.emit({
      gameId: game.id, videoId: "", phase: "diagnostic",
      message: `search ${results.length}res in ${Date.now() - t0}ms (${cached ? "memcache" : settings.thoroughSearch ? "thorough" : "flat"})`
    });
    if (results.length === 0) return undefined;
    const ranked = rankResults(results, game.title, settings).filter((r) => !r.rejected);
    return ranked[0];
  }

  async previewSearchForGame(gameId: string): Promise<OstSearchPreview | undefined> {
    const game = this.repository.getGame(gameId);
    if (!game) return undefined;
    const settings = (await this.getSettings()).music?.osts ?? {};
    const query = buildQuery(settings.queryTemplate ?? "{title} Game Original Soundtrack", game);
    const limit = settings.searchResultLimit ?? 8;
    const { results } = await this.cachedSearch(query, limit, settings.thoroughSearch === true);
    return {
      query,
      results: rankResults(results, game.title, settings)
    };
  }

  async setManualUrl(gameId: string, youtubeUrl: string): Promise<GameSoundtrack> {
    const videoId = parseYoutubeVideoId(youtubeUrl);
    if (!videoId) {
      throw new Error("Could not parse a YouTube video id from the URL.");
    }
    const game = this.repository.getGame(gameId);
    if (!game) throw new Error("Game not found.");

    const existing = this.repository.getGameSoundtrack(gameId);
    if (existing?.localFilePath && existsSync(existing.localFilePath)) {
      await unlink(existing.localFilePath).catch(() => undefined);
    }

    const entry: GameSoundtrack = {
      gameId,
      videoId,
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
      videoTitle: undefined,
      channel: undefined,
      durationSeconds: undefined,
      localFilePath: undefined,
      fileSizeBytes: undefined,
      isManual: true,
      pickedAt: new Date().toISOString()
    };
    this.repository.upsertGameSoundtrack(entry);
    return entry;
  }

  async clearForGame(gameId: string): Promise<void> {
    const existing = this.repository.getGameSoundtrack(gameId);
    if (existing?.localFilePath && existsSync(existing.localFilePath)) {
      await unlink(existing.localFilePath).catch(() => undefined);
    }
    this.repository.deleteGameSoundtrack(gameId);
  }

  async clearAll(): Promise<{ removed: number }> {
    const all = this.repository.listGameSoundtracks();
    let removed = 0;
    for (const entry of all) {
      if (entry.localFilePath && existsSync(entry.localFilePath)) {
        await unlink(entry.localFilePath).catch(() => undefined);
      }
      removed += 1;
    }
    this.repository.clearAllGameSoundtracks();
    return { removed };
  }

  async repick(gameId: string): Promise<OstResolveResult> {
    await this.clearForGame(gameId);
    const settings = (await this.getSettings()).music?.osts ?? {};
    return this.resolveForGameId(gameId, settings);
  }

  private async resolveForGameId(gameId: string, settings: OstSettings): Promise<OstResolveResult> {
    const game = this.repository.getGame(gameId);
    if (!game) return { kind: "no-game", reason: `Game ${gameId} not found.` };
    return this.resolveForGame(game, settings);
  }

  async resolveForGame(game: Game, settings: OstSettings): Promise<OstResolveResult> {
    if (this.resolveInFlight.has(game.id)) {
      return this.resolveInFlight.get(game.id)!;
    }
    const work = this.doResolve(game, settings).finally(() => {
      this.resolveInFlight.delete(game.id);
    });
    this.resolveInFlight.set(game.id, work);
    return work;
  }

  private async doResolve(game: Game, settings: OstSettings): Promise<OstResolveResult> {
    try {
      const existing = this.repository.getGameSoundtrack(game.id);
      if (existing) {
        // Whether the file is cached or not, we have a pick — the protocol
        // handler will stream-and-tee on cache miss. Return immediately.
        return { kind: "ready", gameId: game.id, gameTitle: game.title, soundtrack: existing };
      }

      const pick = await this.pickVideoForGame(game, settings);
      if (!pick) {
        return { kind: "no-pick", gameId: game.id, gameTitle: game.title, reason: "No suitable YouTube result." };
      }
      const entry: GameSoundtrack = {
        gameId: game.id,
        videoId: pick.videoId,
        videoUrl: pick.url,
        videoTitle: pick.title,
        channel: pick.channel,
        durationSeconds: pick.durationSeconds,
        localFilePath: undefined,
        fileSizeBytes: undefined,
        isManual: false,
        pickedAt: new Date().toISOString()
      };
      this.repository.upsertGameSoundtrack(entry);
      return { kind: "ready", gameId: game.id, gameTitle: game.title, soundtrack: entry };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ gameId: game.id, videoId: "", phase: "error", message });
      return { kind: "error", gameId: game.id, gameTitle: game.title, reason: message };
    }
  }

  /** Called by the protocol handler when a stream-and-tee completes. */
  async markFileCached(videoId: string, filePath: string, fileSizeBytes: number): Promise<void> {
    const entry = this.repository.getGameSoundtrackByVideoId(videoId);
    if (!entry) return;
    this.repository.updateGameSoundtrackLocalFile(entry.gameId, filePath, fileSizeBytes);
    this.emit({ gameId: entry.gameId, videoId, phase: "ready" });
    const settings = (await this.getSettings()).music?.osts ?? {};
    await this.evictIfOverBudget(settings.maxCacheBytes);
  }

  /** Look up the pick row for a videoId — used by the protocol handler. */
  lookupByVideoId(videoId: string): GameSoundtrack | undefined {
    return this.repository.getGameSoundtrackByVideoId(videoId);
  }

  private async downloadVideoForGame(
    gameId: string,
    videoUrl: string,
    videoId: string,
    settings: OstSettings
  ): Promise<{ filePath: string; fileSizeBytes: number } | undefined> {
    await mkdir(this.cacheDir, { recursive: true });
    const destPath = join(this.cacheDir, `${videoId}.m4a`);
    const t0 = Date.now();
    try {
      const result = await this.ytdlp.downloadAudio(videoUrl, destPath, (progress) => {
        if (progress.phase === "downloading") {
          this.emit({
            gameId,
            videoId,
            phase: "downloading",
            percent: progress.percent,
            bytesDownloaded: progress.bytesDownloaded,
            totalBytes: progress.totalBytes,
            bytesPerSecond: progress.bytesPerSecond,
            etaSeconds: progress.etaSeconds
          });
        } else if (progress.phase === "ready") {
          const ms = Date.now() - t0;
          this.emit({
            gameId, videoId, phase: "diagnostic",
            message: `download done in ${ms}ms`
          });
          this.emit({ gameId, videoId, phase: "ready" });
        }
      }, { quality: settings.audioQuality ?? "standard" });
      return result;
    } catch (error) {
      this.emit({
        gameId,
        videoId,
        phase: "error",
        message: error instanceof Error ? error.message : String(error)
      });
      return undefined;
    }
  }

  private async evictIfOverBudget(maxBytes: number | undefined): Promise<void> {
    if (!maxBytes || maxBytes <= 0) return;
    const stats = await this.cacheStats();
    if (stats.totalBytes <= maxBytes) return;
    const entries = this.repository.listGameSoundtracks()
      .filter((entry) => entry.localFilePath && existsSync(entry.localFilePath))
      .sort((a, b) => {
        const aTs = Date.parse(a.lastPlayedAt ?? a.pickedAt);
        const bTs = Date.parse(b.lastPlayedAt ?? b.pickedAt);
        return aTs - bTs;
      });
    let currentBytes = stats.totalBytes;
    for (const entry of entries) {
      if (currentBytes <= maxBytes) break;
      if (entry.isManual) continue;
      if (entry.localFilePath && existsSync(entry.localFilePath)) {
        try {
          const s = await stat(entry.localFilePath);
          await unlink(entry.localFilePath).catch(() => undefined);
          this.repository.updateGameSoundtrackLocalFile(entry.gameId, null, null);
          currentBytes -= s.size;
        } catch { /* skip */ }
      }
    }
  }

  markPlayed(gameId: string): void {
    this.repository.updateGameSoundtrackPlayed(gameId, new Date().toISOString());
  }

  async resolveNext(excludeGameIds: string[] = []): Promise<OstResolveResult> {
    const settings = (await this.getSettings()).music?.osts ?? {};
    if (!settings.enabled) {
      return { kind: "error", reason: "OST mode is disabled." };
    }
    const game = await this.pickGameForSource(settings, excludeGameIds);
    if (!game) {
      return { kind: "no-game", reason: "No matching game available for the selected source." };
    }
    return this.resolveForGame(game, settings);
  }
}
