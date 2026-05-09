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
  },
  {
    id: 2,
    sql: `
      ALTER TABLE games ADD COLUMN added_at TEXT;
      ALTER TABLE games ADD COLUMN community_icon_url TEXT;
      ALTER TABLE games ADD COLUMN library_capsule_url TEXT;
      ALTER TABLE games ADD COLUMN header_url TEXT;
      ALTER TABLE games ADD COLUMN trailer_url TEXT;
      ALTER TABLE games ADD COLUMN trailer_poster_url TEXT;
      ALTER TABLE games ADD COLUMN screenshots_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE games ADD COLUMN short_description TEXT;
      ALTER TABLE games ADD COLUMN about_text TEXT;
      ALTER TABLE games ADD COLUMN website_url TEXT;
      ALTER TABLE games ADD COLUMN support_url TEXT;
      ALTER TABLE games ADD COLUMN platforms_json TEXT;
      ALTER TABLE games ADD COLUMN achievement_count INTEGER;
      ALTER TABLE games ADD COLUMN recommendation_count INTEGER;
      ALTER TABLE games ADD COLUMN content_descriptors_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE games ADD COLUMN discovery_json TEXT;
    `
  },
  {
    id: 3,
    sql: `
      ALTER TABLE games ADD COLUMN metadata_version INTEGER NOT NULL DEFAULT 0;
    `
  },
  {
    id: 4,
    sql: `
      ALTER TABLE games ADD COLUMN imported_at TEXT;
      UPDATE games SET imported_at = added_at WHERE imported_at IS NULL;
      UPDATE games SET added_at = NULL;
    `
  }
  ,
  {
    id: 5,
    sql: `
      -- Recreate download_sources without the UNIQUE constraint on raw_hash,
      -- and add url + last_fetched_at for auto-refresh support.
      PRAGMA foreign_keys = OFF;
      CREATE TABLE download_sources_v2 (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT,
        raw_hash TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        last_fetched_at TEXT
      );
      INSERT INTO download_sources_v2 (id, name, raw_hash, imported_at)
        SELECT id, name, raw_hash, imported_at FROM download_sources;
      DROP TABLE download_sources;
      ALTER TABLE download_sources_v2 RENAME TO download_sources;
      PRAGMA foreign_keys = ON;
    `
  },
  {
    id: 6,
    sql: `
      ALTER TABLE games ADD COLUMN logo_url TEXT;

      CREATE TABLE IF NOT EXISTS game_metadata_raw (
        game_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        source TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (provider, external_id, source),
        FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_game_metadata_raw_game_id ON game_metadata_raw(game_id);
    `
  },
  {
    id: 7,
    sql: `
      ALTER TABLE game_sources ADD COLUMN share_type TEXT NOT NULL DEFAULT 'owned';
      ALTER TABLE game_sources ADD COLUMN family_owner_steamids_json TEXT;
    `
  }
] as const;
