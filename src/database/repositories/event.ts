import { dbConnection } from '../connection';
import { Event, EventSource, EventType, EventMetadata } from '../schema';

export interface EventInput {
  interactionId?: number | null;
  sessionId: number;
  source: EventSource;
  type: EventType;
  filePath?: string | null;
  content?: string | null;
  metadata?: EventMetadata | null;
}

export class EventRepository {
  create(input: EventInput): number {
    const db = dbConnection.getDatabase();
    const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;

    db.run(
      `INSERT INTO events (
        interaction_id, session_id, source, type, file_path, content, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.interactionId ?? null,
        input.sessionId,
        input.source,
        input.type,
        input.filePath ?? null,
        input.content ?? null,
        metadataJson,
      ]
    );
    dbConnection.markDirty();

    // Get the last inserted ID
    const result = db.exec('SELECT last_insert_rowid()');
    return result[0].values[0][0] as number;
  }

  getForSession(sessionId: number): Event[] {
    const db = dbConnection.getDatabase();
    const result = db.exec(
      'SELECT * FROM events WHERE session_id = ? ORDER BY timestamp ASC',
      [sessionId]
    );
    if (result.length === 0) {
      return [];
    }
    return result[0].values.map((row) => this.rowToEvent(row));
  }

  getForInteraction(interactionId: number): Event[] {
    const db = dbConnection.getDatabase();
    const result = db.exec(
      'SELECT * FROM events WHERE interaction_id = ? ORDER BY timestamp ASC',
      [interactionId]
    );
    if (result.length === 0) {
      return [];
    }
    return result[0].values.map((row) => this.rowToEvent(row));
  }

  getLatest(sessionId: number): Event | undefined {
    const db = dbConnection.getDatabase();
    const result = db.exec(
      'SELECT * FROM events WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1',
      [sessionId]
    );
    if (result.length === 0 || result[0].values.length === 0) {
      return undefined;
    }
    return this.rowToEvent(result[0].values[0]);
  }

  countForSession(sessionId: number): number {
    const db = dbConnection.getDatabase();
    const result = db.exec(
      'SELECT COUNT(*) FROM events WHERE session_id = ?',
      [sessionId]
    );
    if (result.length === 0) {
      return 0;
    }
    return result[0].values[0][0] as number;
  }

  countBySource(sessionId: number): { human: number; agent: number; tabCompletion: number } {
    const db = dbConnection.getDatabase();
    const result = db.exec(
      `SELECT source, COUNT(*) as count
       FROM events
       WHERE session_id = ?
       GROUP BY source`,
      [sessionId]
    );

    const counts = { human: 0, agent: 0, tabCompletion: 0 };
    if (result.length > 0) {
      for (const row of result[0].values) {
        const source = row[0] as string;
        const count = row[1] as number;
        if (source === 'human') counts.human = count;
        else if (source === 'agent') counts.agent = count;
        else if (source === 'tab-completion') counts.tabCompletion = count;
      }
    }
    return counts;
  }

  private rowToEvent(row: unknown[]): Event {
    return {
      id: row[0] as number,
      interaction_id: row[1] as number | null,
      session_id: row[2] as number,
      source: row[3] as EventSource,
      type: row[4] as EventType,
      file_path: row[5] as string | null,
      content: row[6] as string | null,
      metadata: row[7] as string | null,
      timestamp: row[8] as string,
    };
  }
}

export const eventRepository = new EventRepository();
