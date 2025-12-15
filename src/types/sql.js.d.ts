declare module 'sql.js' {
  export interface SqlJsStatic {
    Database: typeof Database;
  }

  export interface QueryExecResult {
    columns: string[];
    values: unknown[][];
  }

  export interface StatementIteratorResult {
    /** `true` if there are no more available statements */
    done: boolean;
    /** the next available Statement (as returned by `Database.prepare`) */
    value: Statement;
  }

  export interface SqlValue {
    [index: number]: number | string | Uint8Array | null;
  }

  export interface ParamsObject {
    [key: string]: number | string | Uint8Array | null;
  }

  export interface ParamsCallback {
    (obj: ParamsObject): void;
  }

  export type BindParams = SqlValue | ParamsObject | null;

  export class Statement {
    bind(params?: BindParams): boolean;
    step(): boolean;
    getAsObject(params?: ParamsObject): ParamsObject;
    getAsObject(): { [key: string]: unknown };
    get(params?: BindParams): SqlValue;
    getColumnNames(): string[];
    free(): boolean;
    freemem(): void;
    reset(): void;
    run(params?: BindParams): void;
  }

  export class Database {
    constructor();
    constructor(data?: ArrayLike<number> | Buffer | null);

    run(sql: string, params?: BindParams): Database;
    exec(sql: string, params?: BindParams): QueryExecResult[];
    each(
      sql: string,
      params: BindParams,
      callback: ParamsCallback,
      done: () => void
    ): Database;
    each(sql: string, callback: ParamsCallback, done: () => void): Database;
    prepare(sql: string, params?: BindParams): Statement;
    iterateStatements(sql: string): StatementIteratorResult;
    export(): Uint8Array;
    close(): void;
    getRowsModified(): number;
    create_function(name: string, func: (...args: unknown[]) => unknown): Database;
    create_aggregate(
      name: string,
      functions: {
        init?: () => unknown;
        step: (state: unknown, ...args: unknown[]) => unknown;
        finalize: (state: unknown) => unknown;
      }
    ): Database;
  }

  export interface SqlJsConfig {
    locateFile?: (filename: string, prefix: string) => string;
  }

  export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
}
