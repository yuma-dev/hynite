import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type Game,
  type GameDiscovery,
  type GameMetadataPatch,
  type GamePlatforms,
  type GameScreenshot,
  type ImportedGame,
  gameActivityTime,
  makeGameId,
  makeSortTitle,
  type ProviderId,
  type SourceMatch
} from "@hynite/core";
import { migrations } from "./schema";

export const CURRENT_METADATA_VERSION = 8;

type GameRow = {
  id: string;
  title: string;
  sort_title: string;
  install_state: Game["installState"];
  install_directory: string | null;
  executable_path: string | null;
  cover_url: string | null;
  background_url: string | null;
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
  }

  close(): void {
    this.db.close();
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

  upsertImportedGame(game: ImportedGame): Game {
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

    this.db
      .prepare("INSERT OR REPLACE INTO game_sources (game_id, provider, external_id) VALUES (?, ?, ?)")
      .run(id, game.provider, game.externalId);

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
        patch.developers ? serializeArray(patch.developers) : null,
        patch.publishers ? serializeArray(patch.publishers) : null,
        patch.releaseDate ?? null,
        patch.metadataStatus ?? null,
        new Date().toISOString(),
        gameId
      );
  }

  listGames(): Game[] {
    const rows = this.db.prepare("SELECT * FROM games ORDER BY sort_title ASC").all() as GameRow[];
    return rows.map((row) => this.mapGameRow(row));
  }

  queryGames(
    search = "",
    installState: Game["installState"] | "all" = "all",
    sort: "recent" | "title" | "playtime" | "release" = "title",
    sortDirection: "asc" | "desc" = sort === "title" ? "asc" : "desc"
  ): Game[] {
    let games = this.listGames();
    const normalizedSearch = search.trim().toLocaleLowerCase();
    if (normalizedSearch) {
      games = games.filter((game) => game.title.toLocaleLowerCase().includes(normalizedSearch));
    }

    if (installState !== "all") {
      games = games.filter((game) => game.installState === installState);
    }

    const direction = sortDirection === "asc" ? 1 : -1;
    return games.sort((a, b) => {
      let comparison = 0;
      if (sort === "recent") {
        const activityA = gameActivityTime(a);
        const activityB = gameActivityTime(b);
        comparison = activityA - activityB;
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
    rawHash: string;
    entries: Array<{
      id: string;
      title: string;
      normalizedTitle: string;
      fileSize?: string;
      uploadDate?: string;
      uris: string[];
    }>;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare("INSERT OR REPLACE INTO download_sources (id, name, raw_hash, imported_at) VALUES (?, ?, ?, ?)")
      .run(input.id, input.name, input.rawHash, now);

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

  listSourceMatches(matches: SourceMatch[]): SourceMatch[] {
    return matches;
  }

  private mapGameRow(row: GameRow): Game {
    const sourceRows = this.db
      .prepare("SELECT provider, external_id FROM game_sources WHERE game_id = ?")
      .all(row.id) as Array<{ provider: ProviderId; external_id: string }>;

    const libraryCapsuleUrl = isLegacyGuessedLibraryCapsuleUrl(row.library_capsule_url) ? undefined : (row.library_capsule_url ?? undefined);
    const coverUrl = isLegacyGuessedLibraryCapsuleUrl(row.cover_url) ? undefined : (row.cover_url ?? undefined);

    return {
      id: row.id,
      title: row.title,
      sortTitle: row.sort_title,
      sourceIds: sourceRows.map((source) => ({ provider: source.provider, externalId: source.external_id })),
      installState: row.install_state,
      installDirectory: row.install_directory ?? undefined,
      executablePath: row.executable_path ?? undefined,
      coverUrl,
      backgroundUrl: row.background_url ?? undefined,
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
