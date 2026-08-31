/** SQL catalog schema. Shared by the in-process engine and the SAH worker. */
export const CATALOG_SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  file_type TEXT,
  size INTEGER,
  content_type TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  blob_id TEXT,
  meta TEXT,
  deleted_at INTEGER,
  trash_parent_id TEXT,
  sort_order INTEGER
);
CREATE INDEX IF NOT EXISTS nodes_parent ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS nodes_parent_name ON nodes(parent_id, name);
CREATE INDEX IF NOT EXISTS nodes_parent_sort ON nodes(parent_id, sort_order);
CREATE INDEX IF NOT EXISTS nodes_deleted ON nodes(deleted_at);

CREATE TABLE IF NOT EXISTS blob_refs (
  id TEXT PRIMARY KEY,
  opfs_path TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  content_type TEXT,
  pending_promote INTEGER,
  pending INTEGER,
  pack_offset INTEGER,
  crc32 INTEGER,
  pack_generation INTEGER
);
CREATE INDEX IF NOT EXISTS blob_refs_path ON blob_refs(opfs_path);

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  app_id TEXT,
  updated_at INTEGER NOT NULL,
  payload TEXT,
  open_file_id TEXT,
  open_file_generation INTEGER
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS leases (
  key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS leases_expires ON leases(expires_at);
`;
