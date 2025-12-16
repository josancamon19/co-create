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
  const result = await getMostRecentAIGeneration(workspaceFolderUri);
  return result?.unixMs ?? null;
}

/**
 * Get the most recent AI generation with its type from workspace database
 */
export async function getMostRecentAIGeneration(workspaceFolderUri: string): Promise<AIGeneration | null> {
  const generations = await getRecentAIGenerations(workspaceFolderUri);
  if (generations.length === 0) {
    return null;
  }

  // Find the most recent generation
  let mostRecent: AIGeneration | null = null;
  let maxTime = 0;
  for (const gen of generations) {
    if (gen.unixMs > maxTime) {
      maxTime = gen.unixMs;
      mostRecent = gen;
    }
  }

  return mostRecent;
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

/**
 * Get the most recently used model from composerData
 */
export async function getMostRecentModel(): Promise<string | null> {
  const dbPath = getCursorDbPath();
  if (!dbPath) {
    return null;
  }

  try {
    const SQL = await getSqlJs();
    const fileBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(fileBuffer);

    const query = `
      SELECT json_extract(value, '$.modelConfig.modelName') as modelName
      FROM cursorDiskKV
      WHERE key LIKE 'composerData:%'
        AND json_extract(value, '$.modelConfig.modelName') IS NOT NULL
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
    console.error('[CursorDB] Error getting most recent model:', error);
    return null;
  }
}

/**
 * Complete agent interaction data from Cursor's database
 */
export interface AgentInteraction {
  bubbleId: string;
  model: string | null;
  prompt: string | null;
  response: string | null;
  thinking: string | null;
  toolUsage: string | null;  // JSON string of tool calls
  inputTokens: number;
  outputTokens: number;
  timestamp: string;
  isAgentic: boolean;
}

/**
 * Get the most recent AI bubble with full details including prompt from user bubble
 * and model from composerData. This is the primary function for tracking agent activity.
 */
export async function getLatestAgentInteraction(): Promise<AgentInteraction | null> {
  const dbPath = getCursorDbPath();
  if (!dbPath) {
    return null;
  }

  try {
    const SQL = await getSqlJs();
    const fileBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(fileBuffer);

    // Get the most recent AI bubble (type=2) that has actual content
    // Filter for bubbles with non-empty text OR non-zero tokens (to skip empty intermediate bubbles)
    const aiBubbleQuery = `
      SELECT
        json_extract(value, '$.bubbleId') as bubbleId,
        json_extract(value, '$.text') as text,
        json_extract(value, '$.thinking') as thinkingObj,
        json_extract(value, '$.allThinkingBlocks') as thinkingBlocks,
        json_extract(value, '$.toolResults') as toolResults,
        json_extract(value, '$.tokenCount.inputTokens') as inputTokens,
        json_extract(value, '$.tokenCount.outputTokens') as outputTokens,
        json_extract(value, '$.createdAt') as createdAt,
        json_extract(value, '$.isAgentic') as isAgentic
      FROM cursorDiskKV
      WHERE key LIKE 'bubbleId:%'
        AND json_extract(value, '$.type') = 2
        AND (
          (json_extract(value, '$.text') IS NOT NULL AND json_extract(value, '$.text') != '')
          OR json_extract(value, '$.tokenCount.outputTokens') > 0
        )
      ORDER BY json_extract(value, '$.createdAt') DESC
      LIMIT 1
    `;

    const aiBubbleResult = db.exec(aiBubbleQuery);
    if (aiBubbleResult.length === 0 || aiBubbleResult[0].values.length === 0) {
      db.close();
      return null;
    }

    const aiRow = aiBubbleResult[0].values[0];
    const bubbleId = aiRow[0] as string;
    const response = aiRow[1] as string | null;
    const thinkingObjRaw = aiRow[2] as string | null;
    const thinkingBlocksRaw = aiRow[3] as string | null;
    const toolResultsRaw = aiRow[4] as string | null;
    const inputTokens = (aiRow[5] as number) || 0;
    const outputTokens = (aiRow[6] as number) || 0;
    const timestamp = aiRow[7] as string;
    const isAgentic = aiRow[8] === 1;

    // Parse thinking - can be in 'thinking' object or 'allThinkingBlocks' array
    let thinking: string | null = null;

    // First try the 'thinking' field (object with text property)
    if (thinkingObjRaw) {
      try {
        const thinkingObj = JSON.parse(thinkingObjRaw);
        if (thinkingObj && typeof thinkingObj === 'object' && thinkingObj.text) {
          thinking = thinkingObj.text;
        }
      } catch {
        // Might be a plain string
        if (typeof thinkingObjRaw === 'string' && thinkingObjRaw.length > 0) {
          thinking = thinkingObjRaw;
        }
      }
    }

    // If no thinking yet, try allThinkingBlocks
    if (!thinking && thinkingBlocksRaw) {
      try {
        const thinkingBlocks = JSON.parse(thinkingBlocksRaw);
        if (Array.isArray(thinkingBlocks) && thinkingBlocks.length > 0) {
          thinking = thinkingBlocks.map((b: { thinking?: string; text?: string }) => b.thinking || b.text || '').filter(Boolean).join('\n');
        }
      } catch {
        // Ignore parse errors
      }
    }

    // Parse tool results
    let toolUsage: string | null = null;
    if (toolResultsRaw) {
      try {
        const tools = JSON.parse(toolResultsRaw);
        if (Array.isArray(tools) && tools.length > 0) {
          toolUsage = JSON.stringify(tools);
        }
      } catch {
        // Ignore parse errors
      }
    }

    // Find the user bubble (type=1) created just before this AI bubble
    const userBubbleQuery = `
      SELECT json_extract(value, '$.text') as text
      FROM cursorDiskKV
      WHERE key LIKE 'bubbleId:%'
        AND json_extract(value, '$.type') = 1
        AND json_extract(value, '$.createdAt') < ?
      ORDER BY json_extract(value, '$.createdAt') DESC
      LIMIT 1
    `;

    const userBubbleResult = db.exec(userBubbleQuery, [timestamp]);
    let prompt: string | null = null;
    if (userBubbleResult.length > 0 && userBubbleResult[0].values.length > 0) {
      prompt = userBubbleResult[0].values[0][0] as string | null;
    }

    // Find the composerData containing this bubble to get the model
    const composerQuery = `
      SELECT json_extract(value, '$.modelConfig.modelName') as modelName
      FROM cursorDiskKV
      WHERE key LIKE 'composerData:%'
        AND value LIKE ?
    `;

    const composerResult = db.exec(composerQuery, [`%${bubbleId}%`]);
    let model: string | null = null;
    if (composerResult.length > 0 && composerResult[0].values.length > 0) {
      model = composerResult[0].values[0][0] as string | null;
    }

    db.close();

    return {
      bubbleId,
      model,
      prompt,
      response,
      thinking,
      toolUsage,
      inputTokens,
      outputTokens,
      timestamp,
      isAgentic,
    };
  } catch (error) {
    console.error('[CursorDB] Error getting latest agent interaction:', error);
    return null;
  }
}

/**
 * Get the most recent AI bubble timestamp for comparison
 * Only considers bubbles with actual content (non-empty text or non-zero tokens)
 */
export async function getLatestAIBubbleTimestamp(): Promise<string | null> {
  const dbPath = getCursorDbPath();
  if (!dbPath) {
    return null;
  }

  try {
    const SQL = await getSqlJs();
    const fileBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(fileBuffer);

    // Only track bubbles with actual content to avoid detecting empty intermediate bubbles
    const query = `
      SELECT json_extract(value, '$.createdAt') as createdAt
      FROM cursorDiskKV
      WHERE key LIKE 'bubbleId:%'
        AND json_extract(value, '$.type') = 2
        AND (
          (json_extract(value, '$.text') IS NOT NULL AND json_extract(value, '$.text') != '')
          OR json_extract(value, '$.tokenCount.outputTokens') > 0
        )
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
    console.error('[CursorDB] Error getting latest AI bubble timestamp:', error);
    return null;
  }
}
