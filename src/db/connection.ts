import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';

export function resolvePath(dbPath: string): string {
  if (dbPath.startsWith('~')) {
    return dbPath.replace('~', homedir());
  }
  return dbPath;
}

export function createDatabase(dbPath: string): Database.Database {
  const resolved = resolvePath(dbPath);
  mkdirSync(dirname(resolved), { recursive: true });

  const db = new Database(resolved);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  return db;
}
