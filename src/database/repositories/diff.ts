import { dbConnection } from '../connection';
import { Diff } from '../schema';

export interface DiffInput {
  sessionId: number;
  source: 'human' | 'agent' | 'tab-completion';
  filePath: string;
  diff: string;
  linesAdded: number;
  linesRemoved: number;
  commitId?: string | null;
}

export class DiffRepository {
  create(input: DiffInput): void {
    const db = dbConnection.getDatabase();
    db.run(
      'INSERT INTO diffs (session_id, source, file_path, diff, lines_added, lines_removed, commit_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        input.sessionId,
        input.source,
        input.filePath,
        input.diff,
        input.linesAdded,
        input.linesRemoved,
        input.commitId ?? null,
      ]
    );
    dbConnection.markDirty();
  }

  getForSession(sessionId: number): Diff[] {
    const db = dbConnection.getDatabase();
    const result = db.exec(
      'SELECT * FROM diffs WHERE session_id = ? ORDER BY timestamp ASC',
      [sessionId]
    );
    if (result.length === 0) {
      return [];
    }
    return result[0].values.map((row) => ({
      id: row[0] as number,
      session_id: row[1] as number,
      source: row[2] as 'human' | 'agent' | 'tab-completion',
      file_path: row[3] as string,
      diff: row[4] as string,
      lines_added: row[5] as number,
      lines_removed: row[6] as number,
      commit_id: row[7] as string | null,
      timestamp: row[8] as string,
    }));
  }

  getLatest(sessionId: number): Diff | undefined {
    const db = dbConnection.getDatabase();
    const result = db.exec(
      'SELECT * FROM diffs WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1',
      [sessionId]
    );
    if (result.length === 0 || result[0].values.length === 0) {
      return undefined;
    }
    const row = result[0].values[0];
    return {
      id: row[0] as number,
      session_id: row[1] as number,
      source: row[2] as 'human' | 'agent' | 'tab-completion',
      file_path: row[3] as string,
      diff: row[4] as string,
      lines_added: row[5] as number,
      lines_removed: row[6] as number,
      commit_id: row[7] as string | null,
      timestamp: row[8] as string,
    };
  }

  countForSession(sessionId: number): number {
    const db = dbConnection.getDatabase();
    const result = db.exec(
      'SELECT COUNT(*) FROM diffs WHERE session_id = ?',
      [sessionId]
    );
    if (result.length === 0) {
      return 0;
    }
    return result[0].values[0][0] as number;
  }
}

export const diffRepository = new DiffRepository();
