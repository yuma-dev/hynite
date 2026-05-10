import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type DownloadSourceInfo,
  type Game,
  type GameDiscovery,
  type GameMetadataPatch,
  type GamePlatforms,
  type GameScreenshot,
  type ImportedGame,
  type LibraryQuery,
  type PlayerMode,
  playerModesFromSteamCategories,
  gameActivityTime,
  makeGameId,
  makeSortTitle,
  type ProviderId,
  type SourceExactMatch,
  type SourceMatch
} from "@hynite/core";
import { migrations } from "./schema";

export const CURRENT_METADATA_VERSION = 9;

type GameRow = {
  id: string;
  title: string;
  sort_title: string;
  install_state: Game["installState"];
  install_directory: string | null;
  executable_path: string | null;
  cover_url: string | null;
  background_url: string | null;
  logo_url: string | null;
  community_icon_url: string | null;
  library_capsule_url: string | null;
  header_url: string | null;
  trailer_url: string | null;
  trailer_poster_url: string | null;
  screenshots_json: string;
  short_description: string | null;
  about_text: string | null;
  website_url: string | null;
  support_url: string | null;
  platforms_json: string | null;
  achievement_count: number | null;
  recommendation_count: number | null;
  content_descriptors_json: string;
  discovery_json: string | null;
  genres_json: string;
  tags_json: string;
  player_modes_json: string;
  developers_json: string;
  publishers_json: string;
  release_date: string | null;
  playtime_minutes: number | null;
  last_played_at: string | null;
  added_at: string | null;
  imported_at: string | null;
  metadata_status: Game["metadataStatus"];
  metadata_version: number;
  updated_at: string;
};

export type PersistedDownloadEntry = {
  id: string;
  sourceId: string;
  sourceName: string;
  title: string;
  normalizedTitle: string;
  fileSize?: string;
  uploadDate?: string;
  uris: string[];
};

export type RawGameMetadata = {
  gameId: string;
  provider: ProviderId;
  externalId: string;
  source: string;
  raw: unknown;
  fetchedAt: string;
};

export type UpsertImportedGameSummary = {
  id: string;
  metadataStatus: Game["metadataStatus"];
  metadataVersion: number;
};

function parseArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function serializeArray(value: string[] | undefined): string {
  return JSON.stringify(value ?? []);
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function serializeJson<T>(value: T | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function playerModesFromSteamRaw(rawJson: string): PlayerMode[] {
  try {
    const parsed = JSON.parse(rawJson) as Record<
      string,
      { data?: { categories?: Array<{ description?: string }> } }
    >;
    for (const value of Object.values(parsed ?? {})) {
      const cats = value?.data?.categories;
      if (Array.isArray(cats) && cats.length > 0) {
        return playerModesFromSteamCategories(cats);
      }
    }
  } catch {
    // ignore malformed cached JSON
  }
  return [];
}

function isLegacyGuessedLibraryCapsuleUrl(value: string | null | undefined): boolean {
  return Boolean(value && /^https:\/\/(?:cdn\.akamai\.steamstatic\.com\/steam|steamcdn-a\.akamaihd\.net\/steam)\/apps\/\d+\/library_600x900(?:_2x)?\.jpg(?:\?.*)?$/i.test(value));
}

export class HyniteRepository {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
    this.backfillPlayerModesFromSteamRaw();
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(task: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = task();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Populate `player_modes_json` for any rows still defaulted to `[]` by parsing the raw
   * Steam appdetails JSON we already cache in `game_metadata_raw`. Runs on every startup
   * but exits cheaply once every persisted Steam title has a non-empty value.
   */
  private backfillPlayerModesFromSteamRaw(): void {
    const candidates = this.db
      .prepare(
        `SELECT g.id AS game_id, m.raw_json AS raw_json
         FROM games g
         INNER JOIN game_metadata_raw m
           ON m.game_id = g.id
          AND m.source = 'steam_appdetails'
         WHERE g.player_modes_json = '[]' OR g.player_modes_json IS NULL`
      )
      .all() as Array<{ game_id: string; raw_json: string }>;

    const update = this.db.prepare("UPDATE games SET player_modes_json = ? WHERE id = ?");
    for (const row of candidates) {
      const modes = playerModesFromSteamRaw(row.raw_json);
      if (modes.length > 0) {
        update.run(JSON.stringify(modes), row.game_id);
      }
    }

    // Fallback: derive from `tags_json` for any rows still empty. Steam categories
    // (e.g. "Single-player", "Local Co-op") flow into `tags` during normalization,
    // so any previously-synced game has the data we need without a raw cache hit.
    const tagFallback = this.db
      .prepare("SELECT id, tags_json FROM games WHERE player_modes_json = '[]' OR player_modes_json IS NULL")
      .all() as Array<{ id: string; tags_json: string }>;
    for (const row of tagFallback) {
      let tags: string[] = [];
      try {
        const parsed = JSON.parse(row.tags_json) as unknown;
        if (Array.isArray(parsed)) tags = parsed.filter((item): item is string => typeof item === "string");
      } catch {
        continue;
      }
      const modes = playerModesFromSteamCategories(tags);
      if (modes.length > 0) {
        update.run(JSON.stringify(modes), row.id);
      }
    }
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    for (const migration of migrations) {
      const existing = this.db.prepare("SELECT id FROM migrations WHERE id = ?").get(migration.id);
      if (!existing) {
        this.db.exec(migration.sql);
        this.db
          .prepare("INSERT OR REPLACE INTO migrations (id, applied_at) VALUES (?, ?)")
          .run(migration.id, new Date().toISOString());
      }
    }
  }

  upsertImportedGameSummary(game: ImportedGame): UpsertImportedGameSummary {
    const id = makeGameId(game.provider, game.externalId);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO games (
          id, title, sort_title, install_state, install_directory, executable_path,
          community_icon_url, genres_json, tags_json, developers_json, publishers_json,
          playtime_minutes, last_played_at, added_at, imported_at, metadata_status, launch_command, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', '[]', '[]', ?, ?, ?, ?, 'none', ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          sort_title = excluded.sort_title,
          install_state = excluded.install_state,
          install_directory = excluded.install_directory,
          executable_path = excluded.executable_path,
          community_icon_url = COALESCE(excluded.community_icon_url, games.community_icon_url),
          playtime_minutes = COALESCE(excluded.playtime_minutes, games.playtime_minutes),
          last_played_at = COALESCE(excluded.last_played_at, games.last_played_at),
          added_at = COALESCE(excluded.added_at, games.added_at),
          launch_command = excluded.launch_command,
          updated_at = excluded.updated_at`
      )
      .run(
        id,
        game.title,
        makeSortTitle(game.title),
        game.installState,
        game.installDirectory ?? null,
        game.executablePath ?? null,
        game.communityIconUrl ?? null,
        game.playtimeMinutes ?? null,
        game.lastPlayedAt ?? null,
        game.addedAt ?? null,
        now,
        game.launchCommand ?? null,
        now
      );

    const incomingShareType = game.shareType ?? "owned";
    const ownerJson = game.familyOwnerSteamIds && game.familyOwnerSteamIds.length > 0
      ? JSON.stringify(game.familyOwnerSteamIds)
      : null;
    const ownerSteamid = game.ownerSteamid ?? "";

    const existingSource = this.db
      .prepare("SELECT share_type FROM game_sources WHERE provider = ? AND external_id = ? AND owner_steamid = ?")
      .get(game.provider, game.externalId, ownerSteamid) as { share_type: string } | undefined;

    // Owned-takes-precedence: never downgrade an existing owned row to family for the same owner.
    if (existingSource?.share_type === "owned" && incomingShareType === "family") {
      this.db
        .prepare("UPDATE game_sources SET game_id = ? WHERE provider = ? AND external_id = ? AND owner_steamid = ?")
        .run(id, game.provider, game.externalId, ownerSteamid);
    } else {
      this.db
        .prepare(
          `INSERT INTO game_sources (game_id, provider, external_id, share_type, family_owner_steamids_json, owner_steamid)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider, external_id, owner_steamid) DO UPDATE SET
             game_id = excluded.game_id,
             share_type = excluded.share_type,
             family_owner_steamids_json = excluded.family_owner_steamids_json`
        )
        .run(id, game.provider, game.externalId, incomingShareType, ownerJson, ownerSteamid);
    }

    const summary = this.db
      .prepare("SELECT id, metadata_status, metadata_version FROM games WHERE id = ?")
      .get(id) as { id: string; metadata_status: Game["metadataStatus"]; metadata_version: number } | undefined;
    if (!summary) {
      throw new Error(`Failed to persist game ${id}`);
    }

    return {
      id: summary.id,
      metadataStatus: summary.metadata_status,
      metadataVersion: summary.metadata_version
    };
  }

  upsertImportedGame(game: ImportedGame): Game {
    const { id } = this.upsertImportedGameSummary(game);
    const persisted = this.getGame(id);
    if (!persisted) {
      throw new Error(`Failed to persist game ${id}`);
    }

    return persisted;
  }

  applyMetadata(gameId: string, patch: GameMetadataPatch): void {
    this.db
      .prepare(
        `UPDATE games SET
          title = COALESCE(?, title),
          sort_title = COALESCE(?, sort_title),
          cover_url = COALESCE(?, cover_url),
          background_url = COALESCE(?, background_url),
          logo_url = COALESCE(?, logo_url),
          community_icon_url = COALESCE(?, community_icon_url),
          library_capsule_url = COALESCE(?, library_capsule_url),
          header_url = COALESCE(?, header_url),
          trailer_url = COALESCE(?, trailer_url),
          trailer_poster_url = COALESCE(?, trailer_poster_url),
          screenshots_json = COALESCE(?, screenshots_json),
          short_description = COALESCE(?, short_description),
          about_text = COALESCE(?, about_text),
          website_url = COALESCE(?, website_url),
          support_url = COALESCE(?, support_url),
          platforms_json = COALESCE(?, platforms_json),
          achievement_count = COALESCE(?, achievement_count),
          recommendation_count = COALESCE(?, recommendation_count),
          content_descriptors_json = COALESCE(?, content_descriptors_json),
          discovery_json = COALESCE(?, discovery_json),
          genres_json = COALESCE(?, genres_json),
          tags_json = COALESCE(?, tags_json),
          player_modes_json = COALESCE(?, player_modes_json),
          developers_json = COALESCE(?, developers_json),
          publishers_json = COALESCE(?, publishers_json),
          release_date = COALESCE(?, release_date),
          metadata_status = COALESCE(?, metadata_status),
          metadata_version = ${CURRENT_METADATA_VERSION},
          updated_at = ?
        WHERE id = ?`
      )
      .run(
        patch.title ?? null,
        patch.title ? makeSortTitle(patch.title) : (patch.sortTitle ?? null),
        patch.coverUrl ?? null,
        patch.backgroundUrl ?? null,
        patch.logoUrl ?? null,
        patch.communityIconUrl ?? null,
        patch.libraryCapsuleUrl ?? null,
        patch.headerUrl ?? null,
        patch.trailerUrl ?? null,
        patch.trailerPosterUrl ?? null,
        serializeJson(patch.screenshots),
        patch.shortDescription ?? null,
        patch.aboutText ?? null,
        patch.websiteUrl ?? null,
        patch.supportUrl ?? null,
        serializeJson(patch.platforms),
        patch.achievementCount ?? null,
        patch.recommendationCount ?? null,
        patch.contentDescriptors ? serializeArray(patch.contentDescriptors) : null,
        serializeJson(patch.discovery),
        patch.genres ? serializeArray(patch.genres) : null,
        patch.tags ? serializeArray(patch.tags) : null,
        patch.playerModes ? JSON.stringify(patch.playerModes) : null,
        patch.developers ? serializeArray(patch.developers) : null,
        patch.publishers ? serializeArray(patch.publishers) : null,
        patch.releaseDate ?? null,
        patch.metadataStatus ?? null,
        new Date().toISOString(),
        gameId
      );
  }

  saveRawGameMetadata(input: {
    gameId: string;
    provider: ProviderId;
    externalId: string;
    source: string;
    raw: unknown;
    fetchedAt?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO game_metadata_raw (
          game_id, provider, external_id, source, raw_json, fetched_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, external_id, source) DO UPDATE SET
          game_id = excluded.game_id,
          raw_json = excluded.raw_json,
          fetched_at = excluded.fetched_at`
      )
      .run(input.gameId, input.provider, input.externalId, input.source, JSON.stringify(input.raw), input.fetchedAt ?? new Date().toISOString());
  }

  getRawGameMetadata(provider: ProviderId, externalId: string, source: string): RawGameMetadata | undefined {
    const row = this.db
      .prepare("SELECT * FROM game_metadata_raw WHERE provider = ? AND external_id = ? AND source = ?")
      .get(provider, externalId, source) as
      | {
          game_id: string;
          provider: ProviderId;
          external_id: string;
          source: string;
          raw_json: string;
          fetched_at: string;
        }
      | undefined;

    if (!row) {
      return undefined;
    }

    return {
      gameId: row.game_id,
      provider: row.provider,
      externalId: row.external_id,
      source: row.source,
      raw: parseJson<unknown>(row.raw_json, undefined),
      fetchedAt: row.fetched_at
    };
  }

  listGames(): Game[] {
    const rows = this.db.prepare("SELECT * FROM games ORDER BY sort_title ASC").all() as GameRow[];
    return rows.map((row) => this.mapGameRow(row));
  }

  queryGames(query: LibraryQuery = {}): Game[] {
    const sort = query.sort ?? "title";
    const sortDirection = query.sortDirection ?? (sort === "title" ? "asc" : "desc");
    const installState = query.installState ?? "all";
    const ownership = query.ownership ?? "all";
    const sources = query.sources ?? [];
    const genres = query.genres ?? [];
    const tags = query.tags ?? [];
    const playerModes = query.playerModes ?? [];
    const dateFilter = query.dateFilter ?? "any";
    const recentCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;

    let games = this.listGames();

    if (query.gameIds) {
      if (query.gameIds.length === 0) {
        return [];
      }
      const allowedIds = new Set(query.gameIds);
      games = games.filter((game) => allowedIds.has(game.id));
    }

    const normalizedSearch = (query.search ?? "").trim().toLocaleLowerCase();
    if (normalizedSearch) {
      games = games.filter((game) => game.title.toLocaleLowerCase().includes(normalizedSearch));
    }

    if (installState !== "all") {
      games = games.filter((game) => game.installState === installState);
    }

    if (ownership !== "all") {
      games = games.filter((game) => {
        if (game.sourceIds.length === 0) return ownership === "owned";
        const allFamily = game.sourceIds.every((source) => source.shareType === "family");
        return ownership === "family" ? allFamily : !allFamily;
      });
    }

    if (sources.length > 0) {
      games = games.filter((game) => game.sourceIds.some((source) => sources.includes(source.provider)));
    }

    if (genres.length > 0) {
      games = games.filter((game) => game.genres.some((genre) => genres.includes(genre)));
    }

    if (tags.length > 0) {
      games = games.filter((game) => game.tags.some((tag) => tags.includes(tag)));
    }

    if (playerModes.length > 0) {
      games = games.filter((game) => game.playerModes.some((mode) => playerModes.includes(mode)));
    }

    if (dateFilter !== "any") {
      games = games.filter((game) => {
        if (dateFilter === "recently_added") {
          const ts = Date.parse(game.importedAt ?? game.addedAt ?? "") || 0;
          return ts >= recentCutoff;
        }
        if (dateFilter === "recently_played") {
          const ts = Date.parse(game.lastPlayedAt ?? "") || 0;
          return ts >= recentCutoff;
        }
        // never_played
        return !game.lastPlayedAt;
      });
    }

    const direction = sortDirection === "asc" ? 1 : -1;
    return games.sort((a, b) => {
      let comparison = 0;
      if (sort === "recent") {
        comparison = gameActivityTime(a) - gameActivityTime(b);
      } else if (sort === "added") {
        const ta = Date.parse(a.importedAt ?? a.addedAt ?? "") || 0;
        const tb = Date.parse(b.importedAt ?? b.addedAt ?? "") || 0;
        comparison = ta - tb;
      } else if (sort === "playtime") {
        comparison = (a.playtimeMinutes ?? 0) - (b.playtimeMinutes ?? 0);
      } else if (sort === "release") {
        comparison = (Date.parse(a.releaseDate ?? "") || 0) - (Date.parse(b.releaseDate ?? "") || 0);
      } else {
        comparison = a.sortTitle.localeCompare(b.sortTitle);
      }
      return comparison * direction;
    });
  }

  getGame(id: string): Game | undefined {
    const row = this.db.prepare("SELECT * FROM games WHERE id = ?").get(id) as GameRow | undefined;
    return row ? this.mapGameRow(row) : undefined;
  }

  getLaunchCommand(gameId: string): string | undefined {
    const row = this.db.prepare("SELECT launch_command FROM games WHERE id = ?").get(gameId) as { launch_command: string | null } | undefined;
    return row?.launch_command ?? undefined;
  }

  clearLibrary(): number {
    const result = this.db.prepare("DELETE FROM games").run();
    return Number(result.changes);
  }

  saveDownloadSource(input: {
    id: string;
    name: string;
    url?: string;
    rawHash: string;
    entries: Array<{
      id: string;
      title: string;
      normalizedTitle: string;
      fileSize?: string;
      uploadDate?: string;
      uris: string[];
    }>;
  }): boolean {
    const now = new Date().toISOString();

    // Skip re-import if content hasn't changed — only bump last_fetched_at.
    const existing = this.db.prepare("SELECT raw_hash FROM download_sources WHERE id = ?").get(input.id) as
      | { raw_hash: string }
      | undefined;
    if (existing?.raw_hash === input.rawHash) {
      this.db.prepare("UPDATE download_sources SET last_fetched_at = ? WHERE id = ?").run(now, input.id);
      return false;
    }

    this.db
      .prepare(
        "INSERT OR REPLACE INTO download_sources (id, name, url, raw_hash, imported_at, last_fetched_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(input.id, input.name, input.url ?? null, input.rawHash, now, now);

    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM download_entries WHERE source_id = ?").run(input.id);
      const insert = this.db.prepare(
        `INSERT INTO download_entries (
          id, source_id, title, normalized_title, file_size, upload_date, uris_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const entry of input.entries) {
        insert.run(
          entry.id,
          input.id,
          entry.title,
          entry.normalizedTitle,
          entry.fileSize ?? null,
          entry.uploadDate ?? null,
          JSON.stringify(entry.uris)
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return true;
  }

  listSources(): DownloadSourceInfo[] {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.name, s.url, s.imported_at, s.last_fetched_at,
                COUNT(e.id) as entry_count
         FROM download_sources s
         LEFT JOIN download_entries e ON e.source_id = s.id
         GROUP BY s.id
         ORDER BY s.imported_at DESC`
      )
      .all() as Array<{
      id: string;
      name: string;
      url: string | null;
      imported_at: string;
      last_fetched_at: string | null;
      entry_count: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      url: row.url ?? undefined,
      entryCount: row.entry_count,
      importedAt: row.imported_at,
      lastFetchedAt: row.last_fetched_at ?? undefined
    }));
  }

  removeSource(id: string): void {
    this.db.prepare("DELETE FROM download_sources WHERE id = ?").run(id);
  }

  listDownloadEntries(): PersistedDownloadEntry[] {
    const rows = this.db
      .prepare(
        `SELECT e.*, s.name as source_name
         FROM download_entries e
         INNER JOIN download_sources s ON s.id = e.source_id`
      )
      .all() as Array<{
      id: string;
      source_id: string;
      source_name: string;
      title: string;
      normalized_title: string;
      file_size: string | null;
      upload_date: string | null;
      uris_json: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      sourceId: row.source_id,
      sourceName: row.source_name,
      title: row.title,
      normalizedTitle: row.normalized_title,
      fileSize: row.file_size ?? undefined,
      uploadDate: row.upload_date ?? undefined,
      uris: parseArray(row.uris_json)
    }));
  }

  searchDownloadEntries(normalizedWords: string[]): PersistedDownloadEntry[] {
    if (normalizedWords.length === 0) return this.listDownloadEntries();
    const conditions = normalizedWords.map(() => "e.normalized_title LIKE ?").join(" OR ");
    const params = normalizedWords.map((w) => `%${w}%`);
    const rows = this.db
      .prepare(
        `SELECT e.*, s.name as source_name
         FROM download_entries e
         INNER JOIN download_sources s ON s.id = e.source_id
         WHERE ${conditions}`
      )
      .all(...params) as Array<{
      id: string;
      source_id: string;
      source_name: string;
      title: string;
      normalized_title: string;
      file_size: string | null;
      upload_date: string | null;
      uris_json: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      sourceId: row.source_id,
      sourceName: row.source_name,
      title: row.title,
      normalizedTitle: row.normalized_title,
      fileSize: row.file_size ?? undefined,
      uploadDate: row.upload_date ?? undefined,
      uris: parseArray(row.uris_json)
    }));
  }

  exactDownloadTitleMatches(normalizedTitle: string): SourceExactMatch[] {
    const trimmed = normalizedTitle.trim();
    if (!trimmed) return [];
    const rows = this.db
      .prepare(
        `SELECT s.id as source_id, s.name as source_name, COUNT(e.id) as match_count
         FROM download_entries e
         INNER JOIN download_sources s ON s.id = e.source_id
         WHERE e.normalized_title = ?
         GROUP BY s.id, s.name
         ORDER BY match_count DESC, s.name ASC`
      )
      .all(trimmed) as Array<{
      source_id: string;
      source_name: string;
      match_count: number;
    }>;

    return rows.map((row) => ({
      sourceId: row.source_id,
      sourceName: row.source_name,
      count: row.match_count
    }));
  }

  listSourceMatches(matches: SourceMatch[]): SourceMatch[] {
    return matches;
  }

  private mapGameRow(row: GameRow): Game {
    const sourceRows = this.db
      .prepare("SELECT provider, external_id, share_type, family_owner_steamids_json, owner_steamid FROM game_sources WHERE game_id = ?")
      .all(row.id) as Array<{
        provider: ProviderId;
        external_id: string;
        share_type: string | null;
        family_owner_steamids_json: string | null;
        owner_steamid: string | null;
      }>;

    const libraryCapsuleUrl = isLegacyGuessedLibraryCapsuleUrl(row.library_capsule_url) ? undefined : (row.library_capsule_url ?? undefined);
    const coverUrl = isLegacyGuessedLibraryCapsuleUrl(row.cover_url) ? undefined : (row.cover_url ?? undefined);

    return {
      id: row.id,
      title: row.title,
      sortTitle: row.sort_title,
      sourceIds: sourceRows.map((source) => ({
        provider: source.provider,
        externalId: source.external_id,
        shareType: source.share_type === "family" ? ("family" as const) : ("owned" as const),
        familyOwnerSteamIds: parseJson<string[] | undefined>(source.family_owner_steamids_json, undefined),
        ownerSteamid: source.owner_steamid ? source.owner_steamid : undefined
      })),
      installState: row.install_state,
      installDirectory: row.install_directory ?? undefined,
      executablePath: row.executable_path ?? undefined,
      coverUrl,
      backgroundUrl: row.background_url ?? undefined,
      logoUrl: row.logo_url ?? undefined,
      communityIconUrl: row.community_icon_url ?? undefined,
      libraryCapsuleUrl,
      headerUrl: row.header_url ?? undefined,
      trailerUrl: row.trailer_url ?? undefined,
      trailerPosterUrl: row.trailer_poster_url ?? undefined,
      screenshots: parseJson<GameScreenshot[]>(row.screenshots_json, []),
      shortDescription: row.short_description ?? undefined,
      aboutText: row.about_text ?? undefined,
      websiteUrl: row.website_url ?? undefined,
      supportUrl: row.support_url ?? undefined,
      platforms: parseJson<GamePlatforms | undefined>(row.platforms_json, undefined),
      achievementCount: row.achievement_count ?? undefined,
      recommendationCount: row.recommendation_count ?? undefined,
      contentDescriptors: parseArray(row.content_descriptors_json),
      discovery: parseJson<GameDiscovery | undefined>(row.discovery_json, undefined),
      genres: parseArray(row.genres_json),
      tags: parseArray(row.tags_json),
      playerModes: parseArray(row.player_modes_json) as PlayerMode[],
      developers: parseArray(row.developers_json),
      publishers: parseArray(row.publishers_json),
      releaseDate: row.release_date ?? undefined,
      playtimeMinutes: row.playtime_minutes ?? undefined,
      lastPlayedAt: row.last_played_at ?? undefined,
      addedAt: row.added_at ?? undefined,
      importedAt: row.imported_at ?? undefined,
      updatedAt: row.updated_at,
      metadataStatus: row.metadata_status
    };
  }

  getMetadataVersion(gameId: string): number {
    const row = this.db.prepare("SELECT metadata_version FROM games WHERE id = ?").get(gameId) as { metadata_version: number } | undefined;
    return row?.metadata_version ?? 0;
  }
}
