import { dbConnection } from '../connection';
import { Diff } from '../schema';

export interface DiffInput {
  sessionId: number;
  source: 'human' | 'agent' | 'tab-completion';
  agentSubtype?: 'cmdk' | 'composer' | null;
  agentModel?: string | null;
  agentPrompt?: string | null;
  agentResponse?: string | null;
  agentThinking?: string | null;
  agentToolUsage?: string | null;
  agentInputTokens?: number;
  agentOutputTokens?: number;
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
      `INSERT INTO diffs (
        session_id, source, agent_subtype, agent_model, agent_prompt,
        agent_response, agent_thinking, agent_tool_usage, agent_input_tokens, agent_output_tokens,
        file_path, diff, lines_added, lines_removed, commit_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.sessionId,
        input.source,
        input.agentSubtype ?? null,
        input.agentModel ?? null,
        input.agentPrompt ?? null,
        input.agentResponse ?? null,
        input.agentThinking ?? null,
        input.agentToolUsage ?? null,
        input.agentInputTokens ?? 0,
        input.agentOutputTokens ?? 0,
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
      agent_subtype: row[3] as 'cmdk' | 'composer' | null,
      agent_model: row[4] as string | null,
      agent_prompt: row[5] as string | null,
      agent_response: row[6] as string | null,
      agent_thinking: row[7] as string | null,
      agent_tool_usage: row[8] as string | null,
      agent_input_tokens: (row[9] as number) || 0,
      agent_output_tokens: (row[10] as number) || 0,
      file_path: row[11] as string,
      diff: row[12] as string,
      lines_added: row[13] as number,
      lines_removed: row[14] as number,
      commit_id: row[15] as string | null,
      timestamp: row[16] as string,
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
      agent_subtype: row[3] as 'cmdk' | 'composer' | null,
      agent_model: row[4] as string | null,
      agent_prompt: row[5] as string | null,
      agent_response: row[6] as string | null,
      agent_thinking: row[7] as string | null,
      agent_tool_usage: row[8] as string | null,
      agent_input_tokens: (row[9] as number) || 0,
      agent_output_tokens: (row[10] as number) || 0,
      file_path: row[11] as string,
      diff: row[12] as string,
      lines_added: row[13] as number,
      lines_removed: row[14] as number,
      commit_id: row[15] as string | null,
      timestamp: row[16] as string,
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
