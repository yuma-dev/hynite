import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type Game,
  type GameMetadataPatch,
  type ImportedGame,
  makeGameId,
  makeSortTitle,
  type ProviderId,
  type SourceMatch
} from "@hynite/core";
import { migrations } from "./schema";

type GameRow = {
  id: string;
  title: string;
  sort_title: string;
  install_state: Game["installState"];
  install_directory: string | null;
  executable_path: string | null;
  cover_url: string | null;
  background_url: string | null;
  genres_json: string;
  tags_json: string;
  developers_json: string;
  publishers_json: string;
  release_date: string | null;
  playtime_minutes: number | null;
  last_played_at: string | null;
  metadata_status: Game["metadataStatus"];
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
          genres_json, tags_json, developers_json, publishers_json, playtime_minutes,
          last_played_at, metadata_status, launch_command, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', '[]', '[]', ?, ?, 'none', ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          sort_title = excluded.sort_title,
          install_state = excluded.install_state,
          install_directory = excluded.install_directory,
          executable_path = excluded.executable_path,
          playtime_minutes = COALESCE(excluded.playtime_minutes, games.playtime_minutes),
          last_played_at = COALESCE(excluded.last_played_at, games.last_played_at),
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
        game.playtimeMinutes ?? null,
        game.lastPlayedAt ?? null,
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
          cover_url = COALESCE(?, cover_url),
          background_url = COALESCE(?, background_url),
          genres_json = COALESCE(?, genres_json),
          tags_json = COALESCE(?, tags_json),
          developers_json = COALESCE(?, developers_json),
          publishers_json = COALESCE(?, publishers_json),
          release_date = COALESCE(?, release_date),
          metadata_status = COALESCE(?, metadata_status),
          updated_at = ?
        WHERE id = ?`
      )
      .run(
        patch.coverUrl ?? null,
        patch.backgroundUrl ?? null,
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

  queryGames(search = "", installState: Game["installState"] | "all" = "all", sort: "recent" | "title" | "playtime" | "release" = "title"): Game[] {
    let games = this.listGames();
    const normalizedSearch = search.trim().toLocaleLowerCase();
    if (normalizedSearch) {
      games = games.filter((game) => game.title.toLocaleLowerCase().includes(normalizedSearch));
    }

    if (installState !== "all") {
      games = games.filter((game) => game.installState === installState);
    }

    return games.sort((a, b) => {
      if (sort === "recent") {
        return (Date.parse(b.lastPlayedAt ?? "") || 0) - (Date.parse(a.lastPlayedAt ?? "") || 0);
      }
      if (sort === "playtime") {
        return (b.playtimeMinutes ?? 0) - (a.playtimeMinutes ?? 0);
      }
      if (sort === "release") {
        return (Date.parse(b.releaseDate ?? "") || 0) - (Date.parse(a.releaseDate ?? "") || 0);
      }
      return a.sortTitle.localeCompare(b.sortTitle);
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

    return {
      id: row.id,
      title: row.title,
      sortTitle: row.sort_title,
      sourceIds: sourceRows.map((source) => ({ provider: source.provider, externalId: source.external_id })),
      installState: row.install_state,
      installDirectory: row.install_directory ?? undefined,
      executablePath: row.executable_path ?? undefined,
      coverUrl: row.cover_url ?? undefined,
      backgroundUrl: row.background_url ?? undefined,
      genres: parseArray(row.genres_json),
      tags: parseArray(row.tags_json),
      developers: parseArray(row.developers_json),
      publishers: parseArray(row.publishers_json),
      releaseDate: row.release_date ?? undefined,
      playtimeMinutes: row.playtime_minutes ?? undefined,
      lastPlayedAt: row.last_played_at ?? undefined,
      metadataStatus: row.metadata_status
    };
  }
}
