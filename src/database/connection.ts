import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import * as path from 'path';
import * as fs from 'fs';
import { initializeSchema } from './schema';

// Get the path to the WASM file bundled with the extension
function getWasmPath(): string {
  // __dirname is out/database/, so go up one level to out/
  return path.join(__dirname, '..', 'sql-wasm.wasm');
}

const DB_FOLDER = '.cursor-data';
const DB_FILENAME = 'collector.db';

export class DatabaseConnection {
  private static instance: DatabaseConnection | null = null;
  private db: SqlJsDatabase | null = null;
  private workspacePath: string | null = null;
  private dbPath: string | null = null;
  private saveInterval: NodeJS.Timeout | null = null;
  private isDirty: boolean = false;

  private constructor() {}

  static getInstance(): DatabaseConnection {
    if (!DatabaseConnection.instance) {
      DatabaseConnection.instance = new DatabaseConnection();
    }
    return DatabaseConnection.instance;
  }

  async initialize(workspacePath: string): Promise<void> {
    if (this.db && this.workspacePath === workspacePath) {
      return; // Already initialized for this workspace
    }

    this.close(); // Close any existing connection
    this.workspacePath = workspacePath;

    // Create .cursor-data folder if it doesn't exist
    const dbFolderPath = path.join(workspacePath, DB_FOLDER);
    if (!fs.existsSync(dbFolderPath)) {
      fs.mkdirSync(dbFolderPath, { recursive: true });
    }

    this.dbPath = path.join(dbFolderPath, DB_FILENAME);

    // Initialize SQL.js with the WASM file location
    const wasmPath = getWasmPath();
    console.log('[Database] Loading WASM from:', wasmPath);

    const SQL = await initSqlJs({
      locateFile: () => wasmPath,
    });

    // Load existing database or create new one
    if (fs.existsSync(this.dbPath)) {
      const fileBuffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(fileBuffer);
    } else {
      this.db = new SQL.Database();
    }

    // Initialize schema
    initializeSchema(this.db);

    // Save to disk
    this.saveToDisk();

    // Set up periodic saves (every 10 seconds if dirty)
    this.saveInterval = setInterval(() => {
      if (this.isDirty) {
        this.saveToDisk();
      }
    }, 10000);
  }

  getDatabase(): SqlJsDatabase {
    if (!this.db) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.db;
  }

  isInitialized(): boolean {
    return this.db !== null;
  }

  markDirty(): void {
    this.isDirty = true;
  }

  saveToDisk(): void {
    if (!this.db || !this.dbPath) {
      return;
    }
    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(this.dbPath, buffer);
      this.isDirty = false;
    } catch (error) {
      console.error('[Database] Failed to save:', error);
    }
  }

  close(): void {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }
    if (this.db) {
      // Save any pending changes
      if (this.isDirty) {
        this.saveToDisk();
      }
      this.db.close();
      this.db = null;
      this.workspacePath = null;
      this.dbPath = null;
    }
  }

  getWorkspacePath(): string | null {
    return this.workspacePath;
  }
}

export const dbConnection = DatabaseConnection.getInstance();
