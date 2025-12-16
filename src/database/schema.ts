import { Database as SqlJsDatabase } from 'sql.js';

export const SCHEMA_VERSION = 6;

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

  // Create interactions table (agent prompts, thinking, responses)
  db.run(`
    CREATE TABLE IF NOT EXISTS interactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      subtype TEXT,
      model TEXT,
      prompt TEXT,
      thinking TEXT,
      response TEXT,
      tool_usage TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);

  // Create events table (diffs, file creates, file deletes, terminal commands)
  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      interaction_id INTEGER,
      session_id INTEGER NOT NULL,
      source TEXT NOT NULL,
      type TEXT NOT NULL,
      file_path TEXT,
      content TEXT,
      metadata TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (interaction_id) REFERENCES interactions(id),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);

  // Create indexes
  db.run(`CREATE INDEX IF NOT EXISTS idx_interactions_session ON interactions(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_events_interaction ON events(interaction_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_events_source ON events(source)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)`);
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

// ============ Type Definitions ============

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

export interface Interaction {
  id: number;
  session_id: number;
  subtype: 'cmdk' | 'composer' | null;
  model: string | null;
  prompt: string | null;
  thinking: string | null;
  response: string | null;
  tool_usage: string | null;
  input_tokens: number;
  output_tokens: number;
  timestamp: string;
}

export type EventSource = 'human' | 'agent' | 'tab-completion';
export type EventType = 'diff' | 'file_create' | 'file_delete' | 'terminal';

export interface EventMetadata {
  lines_added?: number;
  lines_removed?: number;
  exit_code?: number;
  commit_id?: string | null;
  [key: string]: unknown;
}

export interface Event {
  id: number;
  interaction_id: number | null;
  session_id: number;
  source: EventSource;
  type: EventType;
  file_path: string | null;
  content: string | null;
  metadata: string | null; // JSON string of EventMetadata
  timestamp: string;
}
