// Applied idempotently on the first request of each isolate.
export const SCHEMA: string[] = [
  "CREATE TABLE IF NOT EXISTS cases (\n  id TEXT PRIMARY KEY,\n  token_hash TEXT NOT NULL UNIQUE,\n  title TEXT NOT NULL,\n  first_name TEXT NOT NULL,\n  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','submitted','plan_ready','closed')),\n  intro_json TEXT NOT NULL DEFAULT '[]',\n  questions_json TEXT NOT NULL DEFAULT '[]',\n  plan_json TEXT NOT NULL DEFAULT '[]',\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);",
  "CREATE TABLE IF NOT EXISTS answers (\n  case_id TEXT NOT NULL REFERENCES cases(id),\n  question_id TEXT NOT NULL,\n  text TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  PRIMARY KEY (case_id, question_id)\n);",
  "CREATE TABLE IF NOT EXISTS submissions (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  case_id TEXT NOT NULL REFERENCES cases(id),\n  seq INTEGER NOT NULL,\n  idem_key TEXT NOT NULL,\n  submitted_at TEXT NOT NULL,\n  answered INTEGER NOT NULL,\n  total INTEGER NOT NULL,\n  changed_json TEXT NOT NULL,\n  payload TEXT NOT NULL,\n  sha256 TEXT NOT NULL,\n  UNIQUE (case_id, seq),\n  UNIQUE (case_id, idem_key)\n);",
  "CREATE TRIGGER IF NOT EXISTS submissions_no_update BEFORE UPDATE ON submissions\nBEGIN SELECT RAISE(ABORT, 'submissions are append-only'); END;",
  "CREATE TABLE IF NOT EXISTS audit_log (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  case_id TEXT,\n  actor TEXT NOT NULL,\n  action TEXT NOT NULL,\n  detail TEXT,\n  ray_id TEXT,\n  at TEXT NOT NULL\n);"
  ,"CREATE TABLE IF NOT EXISTS cost_entries (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  case_id TEXT NOT NULL REFERENCES cases(id),\n  usd_micro INTEGER NOT NULL,\n  label TEXT NOT NULL,\n  at TEXT NOT NULL\n);",
  "CREATE TABLE IF NOT EXISTS profiles (\n  id TEXT PRIMARY KEY,\n  slug TEXT NOT NULL UNIQUE,\n  name TEXT NOT NULL,\n  created_at TEXT NOT NULL\n);",
  "CREATE TABLE IF NOT EXISTS sessions (\n  token_hash TEXT PRIMARY KEY,\n  case_id TEXT NOT NULL,\n  pw_version INTEGER NOT NULL,\n  expires_at TEXT NOT NULL\n);",
  "CREATE TABLE IF NOT EXISTS reroutes (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  case_id TEXT NOT NULL,\n  message TEXT NOT NULL,\n  at TEXT NOT NULL,\n  handled_at TEXT\n);",
  "CREATE TABLE IF NOT EXISTS settings (\n  key TEXT PRIMARY KEY,\n  value TEXT NOT NULL\n);"
];
