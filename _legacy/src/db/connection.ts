import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';

function resolvePath(dbPath: string): string {
  if (dbPath.startsWith('~')) {
    return dbPath.replace('~', homedir());
  }
  return dbPath;
}

export function createDatabase(dbPath: string): DatabaseSync {
  const resolved = resolvePath(dbPath);
  mkdirSync(dirname(resolved), { recursive: true });

  const db = new DatabaseSync(resolved);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  return db;
}
