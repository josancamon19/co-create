import { Database as SqlJsDatabase } from 'sql.js';

export const SCHEMA_VERSION = 5;

export function initializeSchema(db: SqlJsDatabase): void {
  // Create projects table
  db.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      git_remote_url TEXT UNIQUE NOT NULL,
      name TEXT,
      local_path TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create sessions table
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ended_at DATETIME,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    )
  `);

  // Create diffs table (the main data we collect)
  db.run(`
    CREATE TABLE IF NOT EXISTS diffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      source TEXT NOT NULL,
      agent_subtype TEXT,
      agent_model TEXT,
      agent_prompt TEXT,
      agent_response TEXT,
      agent_thinking TEXT,
      agent_tool_usage TEXT,
      agent_input_tokens INTEGER DEFAULT 0,
      agent_output_tokens INTEGER DEFAULT 0,
      file_path TEXT NOT NULL,
      diff TEXT NOT NULL,
      lines_added INTEGER DEFAULT 0,
      lines_removed INTEGER DEFAULT 0,
      commit_id TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);

  // Migrations: Add columns if they don't exist (for existing databases)
  try {
    db.run(`ALTER TABLE diffs ADD COLUMN agent_subtype TEXT`);
  } catch {
    // Column already exists, ignore
  }
  try {
    db.run(`ALTER TABLE diffs ADD COLUMN agent_model TEXT`);
  } catch {
    // Column already exists, ignore
  }
  try {
    db.run(`ALTER TABLE diffs ADD COLUMN agent_prompt TEXT`);
  } catch {
    // Column already exists, ignore
  }
  try {
    db.run(`ALTER TABLE diffs ADD COLUMN agent_response TEXT`);
  } catch {
    // Column already exists, ignore
  }
  try {
    db.run(`ALTER TABLE diffs ADD COLUMN agent_thinking TEXT`);
  } catch {
    // Column already exists, ignore
  }
  try {
    db.run(`ALTER TABLE diffs ADD COLUMN agent_tool_usage TEXT`);
  } catch {
    // Column already exists, ignore
  }
  try {
    db.run(`ALTER TABLE diffs ADD COLUMN agent_input_tokens INTEGER DEFAULT 0`);
  } catch {
    // Column already exists, ignore
  }
  try {
    db.run(`ALTER TABLE diffs ADD COLUMN agent_output_tokens INTEGER DEFAULT 0`);
  } catch {
    // Column already exists, ignore
  }

  // Create indexes
  db.run(`CREATE INDEX IF NOT EXISTS idx_diffs_session ON diffs(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_diffs_source ON diffs(source)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id)`);

  // Create schema version table for migrations
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    )
  `);

  // Insert or update schema version
  const result = db.exec('SELECT version FROM schema_version LIMIT 1');
  if (result.length === 0 || result[0].values.length === 0) {
    db.run('INSERT INTO schema_version (version) VALUES (?)', [SCHEMA_VERSION]);
  }
}

export interface Project {
  id: number;
  git_remote_url: string;
  name: string | null;
  local_path: string | null;
  created_at: string;
}

export interface Session {
  id: number;
  project_id: number;
  started_at: string;
  ended_at: string | null;
}

export interface Diff {
  id: number;
  session_id: number;
  source: 'human' | 'agent' | 'tab-completion';
  agent_subtype: 'cmdk' | 'composer' | null;
  agent_model: string | null;
  agent_prompt: string | null;
  agent_response: string | null;
  agent_thinking: string | null;
  agent_tool_usage: string | null;
  agent_input_tokens: number;
  agent_output_tokens: number;
  file_path: string;
  diff: string;
  lines_added: number;
  lines_removed: number;
  commit_id: string | null;
  timestamp: string;
}
