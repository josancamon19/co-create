import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';

let sqlJsInstance: Awaited<ReturnType<typeof initSqlJs>> | null = null;

async function getSqlJs(): Promise<Awaited<ReturnType<typeof initSqlJs>>> {
  if (!sqlJsInstance) {
    sqlJsInstance = await initSqlJs();
  }
  return sqlJsInstance;
}

/**
 * Get the path to Cursor's state database
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
