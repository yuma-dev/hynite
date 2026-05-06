export const migrations = [
  {
    id: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        sort_title TEXT NOT NULL,
        install_state TEXT NOT NULL,
        install_directory TEXT,
        executable_path TEXT,
        cover_url TEXT,
        background_url TEXT,
        genres_json TEXT NOT NULL DEFAULT '[]',
        tags_json TEXT NOT NULL DEFAULT '[]',
        developers_json TEXT NOT NULL DEFAULT '[]',
        publishers_json TEXT NOT NULL DEFAULT '[]',
        release_date TEXT,
        playtime_minutes INTEGER,
        last_played_at TEXT,
        metadata_status TEXT NOT NULL DEFAULT 'none',
        launch_command TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS game_sources (
        game_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        PRIMARY KEY (provider, external_id),
        FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS download_sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        raw_hash TEXT NOT NULL UNIQUE,
        imported_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS download_entries (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        title TEXT NOT NULL,
        normalized_title TEXT NOT NULL,
        file_size TEXT,
        upload_date TEXT,
        uris_json TEXT NOT NULL,
        FOREIGN KEY (source_id) REFERENCES download_sources(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_games_sort_title ON games(sort_title);
      CREATE INDEX IF NOT EXISTS idx_download_entries_normalized_title ON download_entries(normalized_title);
    `
  }
] as const;

