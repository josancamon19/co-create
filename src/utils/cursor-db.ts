import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';

let sqlJsInstance: Awaited<ReturnType<typeof initSqlJs>> | null = null;

async function getSqlJs(): Promise<Awaited<ReturnType<typeof initSqlJs>>> {
  if (!sqlJsInstance) {
    sqlJsInstance = await initSqlJs();
  }
  return sqlJsInstance;
}

/**
 * Get the path to Cursor's global state database
 */
export function getCursorDbPath(): string | null {
  const homeDir = os.homedir();
  let cursorDataPath: string;

  switch (process.platform) {
    case 'darwin':
      cursorDataPath = path.join(homeDir, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
      break;
    case 'win32':
      cursorDataPath = path.join(homeDir, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
      break;
    case 'linux':
      cursorDataPath = path.join(homeDir, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
      break;
    default:
      return null;
  }

  if (fs.existsSync(cursorDataPath)) {
    return cursorDataPath;
  }

  return null;
}

/**
 * Get the path to workspace storage directory
 */
function getWorkspaceStoragePath(): string | null {
  const homeDir = os.homedir();
  let workspaceStoragePath: string;

  switch (process.platform) {
    case 'darwin':
      workspaceStoragePath = path.join(homeDir, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage');
      break;
    case 'win32':
      workspaceStoragePath = path.join(homeDir, 'AppData', 'Roaming', 'Cursor', 'User', 'workspaceStorage');
      break;
    case 'linux':
      workspaceStoragePath = path.join(homeDir, '.config', 'Cursor', 'User', 'workspaceStorage');
      break;
    default:
      return null;
  }

  if (fs.existsSync(workspaceStoragePath)) {
    return workspaceStoragePath;
  }

  return null;
}

/**
 * Find the workspace database path for a given workspace folder URI
 */
export function findWorkspaceDbPath(workspaceFolderUri: string): string | null {
  const workspaceStoragePath = getWorkspaceStoragePath();
  if (!workspaceStoragePath) {
    return null;
  }

  try {
    // Cursor uses MD5 hash of the folder URI for workspace storage
    const hash = crypto.createHash('md5').update(workspaceFolderUri).digest('hex');
    const dbPath = path.join(workspaceStoragePath, hash, 'state.vscdb');

    if (fs.existsSync(dbPath)) {
      console.log('[CursorDB] Found workspace DB at:', dbPath);
      return dbPath;
    }

    // Also try searching by workspace.json content as fallback
    const folders = fs.readdirSync(workspaceStoragePath);
    for (const folder of folders) {
      const workspaceJsonPath = path.join(workspaceStoragePath, folder, 'workspace.json');
      if (fs.existsSync(workspaceJsonPath)) {
        try {
          const content = fs.readFileSync(workspaceJsonPath, 'utf-8');
          const data = JSON.parse(content);
          if (data.folder === workspaceFolderUri) {
            const foundDbPath = path.join(workspaceStoragePath, folder, 'state.vscdb');
            if (fs.existsSync(foundDbPath)) {
              console.log('[CursorDB] Found workspace DB via search at:', foundDbPath);
              return foundDbPath;
            }
          }
        } catch {
          // Ignore parsing errors
        }
      }
    }
  } catch (error) {
    console.error('[CursorDB] Error finding workspace DB:', error);
  }

  return null;
}

/**
 * AI Generation entry from workspace database
 */
export interface AIGeneration {
  unixMs: number;
  generationUUID: string;
  type: 'cmdk' | 'composer' | string;
  textDescription?: string;
}

/**
 * Get recent AI generations from workspace database
 * This captures both Cmd+K (type=cmdk) and composer (type=composer) activity
 */
export async function getRecentAIGenerations(workspaceFolderUri: string, sinceMs?: number): Promise<AIGeneration[]> {
  const dbPath = findWorkspaceDbPath(workspaceFolderUri);
  if (!dbPath) {
    console.log('[CursorDB] No workspace DB found for:', workspaceFolderUri);
    return [];
  }

  try {
    const SQL = await getSqlJs();
    const fileBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(fileBuffer);

    const result = db.exec("SELECT value FROM ItemTable WHERE key = 'aiService.generations'");
    db.close();

    if (result.length > 0 && result[0].values.length > 0) {
      const rawValue = result[0].values[0][0] as string;
      const generations: AIGeneration[] = JSON.parse(rawValue);

      // Filter by timestamp if provided
      if (sinceMs) {
        return generations.filter(g => g.unixMs > sinceMs);
      }

      return generations;
    }
    return [];
  } catch (error) {
    console.error('[CursorDB] Error reading AI generations:', error);
    return [];
  }
}

/**
 * Get the most recent AI generation timestamp from workspace database
 */
export async function getMostRecentAIGenerationTime(workspaceFolderUri: string): Promise<number | null> {
  const generations = await getRecentAIGenerations(workspaceFolderUri);
  if (generations.length === 0) {
    return null;
  }

  // Find the most recent timestamp
  let maxTime = 0;
  for (const gen of generations) {
    if (gen.unixMs > maxTime) {
      maxTime = gen.unixMs;
    }
  }

  return maxTime > 0 ? maxTime : null;
}

/**
 * Read a value from Cursor's state database
 */
export async function readCursorState(key: string): Promise<string | null> {
  const dbPath = getCursorDbPath();
  if (!dbPath) {
    return null;
  }

  try {
    const SQL = await getSqlJs();
    const fileBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(fileBuffer);

    const result = db.exec('SELECT value FROM ItemTable WHERE key = ?', [key]);
    db.close();

    if (result.length > 0 && result[0].values.length > 0) {
      return result[0].values[0][0] as string;
    }
    return null;
  } catch (error) {
    console.error('[CursorDB] Error reading state:', error);
    return null;
  }
}

/**
 * Read multiple values from Cursor's state database efficiently
 */
export async function readCursorStateMultiple(keys: string[]): Promise<Map<string, string>> {
  const dbPath = getCursorDbPath();
  const results = new Map<string, string>();

  if (!dbPath) {
    return results;
  }

  try {
    const SQL = await getSqlJs();
    const fileBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(fileBuffer);

    for (const key of keys) {
      const result = db.exec('SELECT value FROM ItemTable WHERE key = ?', [key]);
      if (result.length > 0 && result[0].values.length > 0) {
        results.set(key, result[0].values[0][0] as string);
      }
    }

    db.close();
    return results;
  } catch (error) {
    console.error('[CursorDB] Error reading state:', error);
    return results;
  }
}

/**
 * Get all keys from Cursor's state database (for debugging)
 */
export async function getAllCursorKeys(): Promise<string[]> {
  const dbPath = getCursorDbPath();
  if (!dbPath) {
    return [];
  }

  try {
    const SQL = await getSqlJs();
    const fileBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(fileBuffer);

    const result = db.exec('SELECT key FROM ItemTable');
    db.close();

    if (result.length > 0) {
      return result[0].values.map(row => row[0] as string);
    }
    return [];
  } catch (error) {
    console.error('[CursorDB] Error reading keys:', error);
    return [];
  }
}

/**
 * Bubble data from cursorDiskKV
 */
export interface BubbleData {
  bubbleId: string;
  type: number; // 1 = user, 2 = AI/assistant
  isAgentic: boolean;
  createdAt: string;
  text?: string;
  toolName?: string;
}

/**
 * Get recent AI bubbles from Cursor's cursorDiskKV table
 * This is where Cursor stores actual conversation data
 */
export async function getRecentAIBubbles(sinceTimestamp?: string): Promise<BubbleData[]> {
  const dbPath = getCursorDbPath();
  if (!dbPath) {
    return [];
  }

  try {
    const SQL = await getSqlJs();
    const fileBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(fileBuffer);

    // Query bubbles from cursorDiskKV table where type = 2 (AI messages)
    let query = `
      SELECT
        json_extract(value, '$.bubbleId') as bubbleId,
        json_extract(value, '$.type') as type,
        json_extract(value, '$.isAgentic') as isAgentic,
        json_extract(value, '$.createdAt') as createdAt,
        json_extract(value, '$.text') as text,
        json_extract(value, '$.toolFormerData.name') as toolName
      FROM cursorDiskKV
      WHERE key LIKE 'bubbleId:%'
        AND json_extract(value, '$.type') = 2
    `;

    if (sinceTimestamp) {
      query += ` AND json_extract(value, '$.createdAt') > '${sinceTimestamp}'`;
    }

    query += ` ORDER BY json_extract(value, '$.createdAt') DESC LIMIT 100`;

    const result = db.exec(query);
    db.close();

    if (result.length > 0 && result[0].values.length > 0) {
      return result[0].values.map(row => ({
        bubbleId: row[0] as string,
        type: row[1] as number,
        isAgentic: row[2] === 1,
        createdAt: row[3] as string,
        text: row[4] as string | undefined,
        toolName: row[5] as string | undefined,
      }));
    }
    return [];
  } catch (error) {
    console.error('[CursorDB] Error reading AI bubbles:', error);
    return [];
  }
}

/**
 * Get the count of AI bubbles since a given timestamp
 */
export async function getAIBubbleCount(sinceTimestamp?: string): Promise<number> {
  const dbPath = getCursorDbPath();
  if (!dbPath) {
    return 0;
  }

  try {
    const SQL = await getSqlJs();
    const fileBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(fileBuffer);

    let query = `
      SELECT COUNT(*) as count
      FROM cursorDiskKV
      WHERE key LIKE 'bubbleId:%'
        AND json_extract(value, '$.type') = 2
    `;

    if (sinceTimestamp) {
      query += ` AND json_extract(value, '$.createdAt') > '${sinceTimestamp}'`;
    }

    const result = db.exec(query);
    db.close();

    if (result.length > 0 && result[0].values.length > 0) {
      return result[0].values[0][0] as number;
    }
    return 0;
  } catch (error) {
    console.error('[CursorDB] Error counting AI bubbles:', error);
    return 0;
  }
}

/**
 * Get the most recent AI bubble timestamp
 */
export async function getMostRecentAIBubbleTime(): Promise<string | null> {
  const dbPath = getCursorDbPath();
  if (!dbPath) {
    return null;
  }

  try {
    const SQL = await getSqlJs();
    const fileBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(fileBuffer);

    const query = `
      SELECT json_extract(value, '$.createdAt') as createdAt
      FROM cursorDiskKV
      WHERE key LIKE 'bubbleId:%'
        AND json_extract(value, '$.type') = 2
      ORDER BY json_extract(value, '$.createdAt') DESC
      LIMIT 1
    `;

    const result = db.exec(query);
    db.close();

    if (result.length > 0 && result[0].values.length > 0) {
      return result[0].values[0][0] as string;
    }
    return null;
  } catch (error) {
    console.error('[CursorDB] Error getting most recent AI bubble:', error);
    return null;
  }
}

/**
 * Get the count of non-empty inline diff entries
 * These are created when Cmd+K inline edits are applied
 */
export async function getInlineDiffCount(): Promise<number> {
  const dbPath = getCursorDbPath();
  if (!dbPath) {
    return 0;
  }

  try {
    const SQL = await getSqlJs();
    const fileBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(fileBuffer);

    // Count inlineDiffs entries that have actual content (not empty arrays)
    const query = `
      SELECT COUNT(*) as count
      FROM cursorDiskKV
      WHERE key LIKE 'inlineDiffs-%'
        AND value != '[]'
    `;

    const result = db.exec(query);
    db.close();

    if (result.length > 0 && result[0].values.length > 0) {
      return result[0].values[0][0] as number;
    }
    return 0;
  } catch (error) {
    console.error('[CursorDB] Error counting inline diffs:', error);
    return 0;
  }
}

/**
 * Get the most recent composer createdAt timestamp
 * This captures both agentic and non-agentic (Cmd+K) composer activity
 */
export async function getMostRecentComposerTime(): Promise<number | null> {
  const dbPath = getCursorDbPath();
  if (!dbPath) {
    return null;
  }

  try {
    const SQL = await getSqlJs();
    const fileBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(fileBuffer);

    const query = `
      SELECT json_extract(value, '$.createdAt') as createdAt
      FROM cursorDiskKV
      WHERE key LIKE 'composerData:%'
      ORDER BY json_extract(value, '$.createdAt') DESC
      LIMIT 1
    `;

    const result = db.exec(query);
    db.close();

    if (result.length > 0 && result[0].values.length > 0) {
      return result[0].values[0][0] as number;
    }
    return null;
  } catch (error) {
    console.error('[CursorDB] Error getting most recent composer:', error);
    return null;
  }
}
