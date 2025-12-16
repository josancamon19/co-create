import { dbConnection } from '../connection';
import { Interaction } from '../schema';

export interface InteractionInput {
  sessionId: number;
  subtype?: 'cmdk' | 'composer' | null;
  model?: string | null;
  prompt?: string | null;
  thinking?: string | null;
  response?: string | null;
  toolUsage?: string | null;
  inputTokens?: number;
  outputTokens?: number;
}

export class InteractionRepository {
  create(input: InteractionInput): number {
    const db = dbConnection.getDatabase();
    db.run(
      `INSERT INTO interactions (
        session_id, subtype, model, prompt, thinking, response,
        tool_usage, input_tokens, output_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.sessionId,
        input.subtype ?? null,
        input.model ?? null,
        input.prompt ?? null,
        input.thinking ?? null,
        input.response ?? null,
        input.toolUsage ?? null,
        input.inputTokens ?? 0,
        input.outputTokens ?? 0,
      ]
    );
    dbConnection.markDirty();

    // Get the last inserted ID
    const result = db.exec('SELECT last_insert_rowid()');
    return result[0].values[0][0] as number;
  }

  getForSession(sessionId: number): Interaction[] {
    const db = dbConnection.getDatabase();
    const result = db.exec(
      'SELECT * FROM interactions WHERE session_id = ? ORDER BY timestamp ASC',
      [sessionId]
    );
    if (result.length === 0) {
      return [];
    }
    return result[0].values.map((row) => this.rowToInteraction(row));
  }

  getById(id: number): Interaction | undefined {
    const db = dbConnection.getDatabase();
    const result = db.exec('SELECT * FROM interactions WHERE id = ?', [id]);
    if (result.length === 0 || result[0].values.length === 0) {
      return undefined;
    }
    return this.rowToInteraction(result[0].values[0]);
  }

  getLatest(sessionId: number): Interaction | undefined {
    const db = dbConnection.getDatabase();
    const result = db.exec(
      'SELECT * FROM interactions WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1',
      [sessionId]
    );
    if (result.length === 0 || result[0].values.length === 0) {
      return undefined;
    }
    return this.rowToInteraction(result[0].values[0]);
  }

  countForSession(sessionId: number): number {
    const db = dbConnection.getDatabase();
    const result = db.exec(
      'SELECT COUNT(*) FROM interactions WHERE session_id = ?',
      [sessionId]
    );
    if (result.length === 0) {
      return 0;
    }
    return result[0].values[0][0] as number;
  }

  private rowToInteraction(row: unknown[]): Interaction {
    return {
      id: row[0] as number,
      session_id: row[1] as number,
      subtype: row[2] as 'cmdk' | 'composer' | null,
      model: row[3] as string | null,
      prompt: row[4] as string | null,
      thinking: row[5] as string | null,
      response: row[6] as string | null,
      tool_usage: row[7] as string | null,
      input_tokens: (row[8] as number) || 0,
      output_tokens: (row[9] as number) || 0,
      timestamp: row[10] as string,
    };
  }
}

export const interactionRepository = new InteractionRepository();
