import { DatabaseSync } from "node:sqlite";

export function createDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      file_name TEXT NOT NULL DEFAULT '',
      relative_path TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL DEFAULT '',
      file_path TEXT NOT NULL DEFAULT '',
      pasted_text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      error TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      content_hash TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      indexed_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      locator_json TEXT NOT NULL DEFAULT '{}',
      embedding_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sources_profile ON sources(profile_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_profile ON chunks(profile_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_id);

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      total_sources INTEGER NOT NULL DEFAULT 0,
      processed_sources INTEGER NOT NULL DEFAULT 0,
      failed_sources INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_runs (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      query TEXT NOT NULL,
      answer TEXT NOT NULL,
      citations_json TEXT NOT NULL DEFAULT '[]',
      provider_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rules (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL DEFAULT '',
      section TEXT NOT NULL DEFAULT '',
      principle TEXT NOT NULL DEFAULT '',
      terms_json TEXT NOT NULL DEFAULT '[]',
      prefer_json TEXT NOT NULL DEFAULT '[]',
      pairs_json TEXT NOT NULL DEFAULT '[]',
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rules_profile ON rules(profile_id);

    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL DEFAULT '',
      rating INTEGER NOT NULL,
      query TEXT NOT NULL,
      answer TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      correction TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT '',
      query_embedding_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_profile ON feedback(profile_id);
  `);
  migrate(db);
  return db;
}

// Lightweight, idempotent column migrations so existing data/rag.sqlite files
// pick up new columns without a manual reset.
function migrate(db) {
  const columns = db.prepare("PRAGMA table_info(profiles)").all().map((c) => c.name);
  // `published` marks a profile as part of the shared "central library" that
  // remote viewers can browse and copy. 0 = private (default), 1 = published.
  if (!columns.includes("published")) {
    db.exec("ALTER TABLE profiles ADD COLUMN published INTEGER NOT NULL DEFAULT 0");
  }

  // Preprocessing agent: a structuring pass turns a messy/OCR'd source (or a
  // document screenshot) into clean Markdown BEFORE chunking. The result is
  // held here for human review; indexing prefers it over the raw extraction.
  const sourceColumns = db.prepare("PRAGMA table_info(sources)").all().map((c) => c.name);
  // Restructured Markdown (empty = not preprocessed; index uses raw extraction).
  if (!sourceColumns.includes("normalized_md")) {
    db.exec("ALTER TABLE sources ADD COLUMN normalized_md TEXT NOT NULL DEFAULT ''");
  }
  if (!sourceColumns.includes("preprocessed_at")) {
    db.exec("ALTER TABLE sources ADD COLUMN preprocessed_at TEXT NOT NULL DEFAULT ''");
  }
  // content_hash captured when normalized_md was produced, so a re-run can skip
  // sources whose content has not changed since the last structuring pass.
  if (!sourceColumns.includes("preprocess_hash")) {
    db.exec("ALTER TABLE sources ADD COLUMN preprocess_hash TEXT NOT NULL DEFAULT ''");
  }
}

export function one(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

export function all(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}

export function run(db, sql, ...params) {
  return db.prepare(sql).run(...params);
}
