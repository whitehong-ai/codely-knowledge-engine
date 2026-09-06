/**
 * Configuration for the knowledge-engine MCP Server.
 */
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

export class Config {
  /** Home directory for all knowledge-engine data */
  readonly kbHome: string;
  /** SQLite database path */
  readonly dbPath: string;
  /** LanceDB directory for vector storage */
  readonly lanceDbPath: string;
  /** FTS5 database path for keyword search */
  readonly ftsDbPath: string;

  constructor() {
    const homeEnv = process.env.KNOWLEDGE_ENGINE_HOME ?? '~/.codely-knowledge';
    this.kbHome = homeEnv.replace('~', os.homedir());
    this.dbPath = path.join(this.kbHome, 'knowledge.db');
    this.lanceDbPath = path.join(this.kbHome, 'lancedb');
    this.ftsDbPath = path.join(this.kbHome, 'fts.db');

    // Ensure directories exist
    fs.mkdirSync(this.kbHome, { recursive: true });
    fs.mkdirSync(this.lanceDbPath, { recursive: true });
  }
}

let _config: Config | null = null;

export function getConfig(): Config {
  if (!_config) {
    _config = new Config();
  }
  return _config;
}

export function resetConfig(): void {
  _config = null;
}
