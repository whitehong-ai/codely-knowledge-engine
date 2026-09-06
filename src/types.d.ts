declare module "better-sqlite3" {
  export interface Statement {
    run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: any[]): any;
    all(...params: any[]): any[];
  }
  export class Database {
    constructor(filename: string);
    prepare(sql: string): Statement;
    exec(sql: string): void;
    pragma(pragma: string): unknown;
    close(): void;
  }
  export default Database;
}

declare module "@xenova/transformers" {
  export const env: {
    allowLocalModels: boolean;
    allowRemoteModels: boolean;
    localModelPath: string;
  };
  export function pipeline(
    task: string,
    model: string,
    options?: any,
  ): Promise<(input: string | string[], options?: any) => Promise<any>>;
}
