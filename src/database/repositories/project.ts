import { dbConnection } from '../connection';
import { Project } from '../schema';

function rowToProject(row: unknown[]): Project {
  return {
    id: row[0] as number,
    git_remote_url: row[1] as string,
    name: row[2] as string | null,
    local_path: row[3] as string | null,
    created_at: row[4] as string,
  };
}

export class ProjectRepository {
  findByGitRemoteUrl(gitRemoteUrl: string): Project | undefined {
    const db = dbConnection.getDatabase();
    const result = db.exec('SELECT * FROM projects WHERE git_remote_url = ?', [gitRemoteUrl]);
    if (result.length === 0 || result[0].values.length === 0) {
      return undefined;
    }
    return rowToProject(result[0].values[0]);
  }

  findById(id: number): Project | undefined {
    const db = dbConnection.getDatabase();
    const result = db.exec('SELECT * FROM projects WHERE id = ?', [id]);
    if (result.length === 0 || result[0].values.length === 0) {
      return undefined;
    }
    return rowToProject(result[0].values[0]);
  }

  create(gitRemoteUrl: string, name?: string, localPath?: string): Project {
    const db = dbConnection.getDatabase();
    db.run(
      'INSERT INTO projects (git_remote_url, name, local_path) VALUES (?, ?, ?)',
      [gitRemoteUrl, name ?? null, localPath ?? null]
    );
    dbConnection.markDirty();

    // Get the last inserted ID
    const result = db.exec('SELECT last_insert_rowid()');
    const lastId = result[0].values[0][0] as number;
    return this.findById(lastId)!;
  }

  findOrCreate(gitRemoteUrl: string, name?: string, localPath?: string): Project {
    const existing = this.findByGitRemoteUrl(gitRemoteUrl);
    if (existing) {
      // Update local path if it changed
      if (localPath && existing.local_path !== localPath) {
        this.updateLocalPath(existing.id, localPath);
        return { ...existing, local_path: localPath };
      }
      return existing;
    }
    return this.create(gitRemoteUrl, name, localPath);
  }

  updateLocalPath(id: number, localPath: string): void {
    const db = dbConnection.getDatabase();
    db.run('UPDATE projects SET local_path = ? WHERE id = ?', [localPath, id]);
    dbConnection.markDirty();
  }

  getAll(): Project[] {
    const db = dbConnection.getDatabase();
    const result = db.exec('SELECT * FROM projects ORDER BY created_at DESC');
    if (result.length === 0) {
      return [];
    }
    return result[0].values.map(rowToProject);
  }
}

export const projectRepository = new ProjectRepository();
