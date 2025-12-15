import { dbConnection } from '../connection';
import { Session } from '../schema';

function rowToSession(row: unknown[]): Session {
  return {
    id: row[0] as number,
    project_id: row[1] as number,
    started_at: row[2] as string,
    ended_at: row[3] as string | null,
  };
}

export class SessionRepository {
  findById(id: number): Session | undefined {
    const db = dbConnection.getDatabase();
    const result = db.exec('SELECT * FROM sessions WHERE id = ?', [id]);
    if (result.length === 0 || result[0].values.length === 0) {
      return undefined;
    }
    return rowToSession(result[0].values[0]);
  }

  create(projectId: number): Session {
    const db = dbConnection.getDatabase();
    db.run('INSERT INTO sessions (project_id) VALUES (?)', [projectId]);
    dbConnection.markDirty();

    const result = db.exec('SELECT last_insert_rowid()');
    const lastId = result[0].values[0][0] as number;
    return this.findById(lastId)!;
  }

  endSession(id: number): void {
    const db = dbConnection.getDatabase();
    db.run("UPDATE sessions SET ended_at = datetime('now') WHERE id = ?", [id]);
    dbConnection.markDirty();
  }

  getLatestForProject(projectId: number): Session | undefined {
    const db = dbConnection.getDatabase();
    const result = db.exec(
      'SELECT * FROM sessions WHERE project_id = ? ORDER BY started_at DESC LIMIT 1',
      [projectId]
    );
    if (result.length === 0 || result[0].values.length === 0) {
      return undefined;
    }
    return rowToSession(result[0].values[0]);
  }

  getOpenSessionForProject(projectId: number): Session | undefined {
    const db = dbConnection.getDatabase();
    const result = db.exec(
      'SELECT * FROM sessions WHERE project_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1',
      [projectId]
    );
    if (result.length === 0 || result[0].values.length === 0) {
      return undefined;
    }
    return rowToSession(result[0].values[0]);
  }

  getAllForProject(projectId: number): Session[] {
    const db = dbConnection.getDatabase();
    const result = db.exec(
      'SELECT * FROM sessions WHERE project_id = ? ORDER BY started_at DESC',
      [projectId]
    );
    if (result.length === 0) {
      return [];
    }
    return result[0].values.map(rowToSession);
  }
}

export const sessionRepository = new SessionRepository();
