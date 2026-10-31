import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { defaultSettings } from '../shared/catalog.js';
import type { HistoryPoint, Settings } from '../shared/types.js';
import type { NewApiConfig } from '../plugins/newapi/connector.js';
import { decrypt, encrypt } from './crypto.js';

export interface NodeRecord {
  id: string; name: string; token_hash: string; interval_ms: number;
  platform: string; capabilities: string; last_seen: number | null;
}
export interface ConnectionRecord extends NewApiConfig { id: string; name: string }
export class Store {
  readonly db: DatabaseSync;
  constructor(filename: string, private readonly key: Buffer) {
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS nodes(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL, interval_ms INTEGER NOT NULL,
        platform TEXT NOT NULL DEFAULT 'unknown', capabilities TEXT NOT NULL DEFAULT '[]', last_seen INTEGER);
      CREATE TABLE IF NOT EXISTS history(
        node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        timestamp INTEGER NOT NULL, sample TEXT, PRIMARY KEY(node_id,timestamp));
      CREATE TABLE IF NOT EXISTS connections(id TEXT PRIMARY KEY, name TEXT NOT NULL, config TEXT NOT NULL);
    `);
  }
  close() { this.db.close(); }
  value(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM kv WHERE key=?').get(key) as { value: string } | undefined)?.value;
  }
  setValue(key: string, value: string) {
    this.db.prepare('INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }
  settings(): Settings { const s = this.value('settings'); return s ? JSON.parse(s) as Settings : defaultSettings(); }
  saveSettings(s: Settings) { this.setValue('settings', JSON.stringify(s)); }
  session(hash: string, now: number): { csrf: string; expires: number } | undefined {
    return this.db.prepare('SELECT csrf,expires FROM sessions WHERE hash=? AND expires>?').get(hash, now) as { csrf: string; expires: number } | undefined;
  }
  newSession(hash: string, csrf: string, expires: number) { this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash, csrf, expires); }
  removeSession(hash: string) { this.db.prepare('DELETE FROM sessions WHERE hash=?').run(hash); }
  clearSessions() { this.db.exec('DELETE FROM sessions'); }
  nodes(): NodeRecord[] { return this.db.prepare('SELECT * FROM nodes ORDER BY rowid').all() as unknown as NodeRecord[]; }
  node(id: string): NodeRecord | undefined { return this.db.prepare('SELECT * FROM nodes WHERE id=?').get(id) as NodeRecord | undefined; }
  addNode(id: string, name: string, tokenHash: string) {
    this.db.prepare('INSERT INTO nodes(id,name,token_hash,interval_ms) VALUES(?,?,?,1000)').run(id, name, tokenHash);
  }
  updateNode(id: string, name: string, intervalMs: number) { this.db.prepare('UPDATE nodes SET name=?, interval_ms=? WHERE id=?').run(name, intervalMs, id); }
  nodeMeta(id: string, platform: string, caps: string[]) {
    this.db.prepare('UPDATE nodes SET platform=?, capabilities=? WHERE id=?').run(platform, JSON.stringify(caps), id);
  }
  rotateNode(id: string, hash: string) { this.db.prepare('UPDATE nodes SET token_hash=? WHERE id=?').run(hash, id); }
  deleteNode(id: string) { this.db.prepare('DELETE FROM nodes WHERE id=?').run(id); }
  insertHistory(id: string, point: HistoryPoint, lastSeen: number | null) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT OR REPLACE INTO history VALUES(?,?,?)').run(id, point.timestamp, point.sample ? JSON.stringify(point.sample) : null);
      this.db.prepare('UPDATE nodes SET last_seen=? WHERE id=?').run(lastSeen, id);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  history(id: string, since: number, resolutionMs = 1): HistoryPoint[] {
    // Select one already averaged record per display bucket. Keep explicit outage boundaries.
    // Avoid loading every raw history record for a week-long chart.
    const rows = this.db.prepare(`SELECT timestamp,sample FROM history WHERE node_id=? AND timestamp IN (
      SELECT MAX(timestamp) FROM history WHERE node_id=? AND timestamp>=? AND sample IS NOT NULL GROUP BY CAST(timestamp / ? AS INTEGER)
      UNION SELECT timestamp FROM history WHERE node_id=? AND timestamp>=? AND sample IS NULL
    ) ORDER BY timestamp`).all(id, id, since, resolutionMs, id, since) as { timestamp: number; sample: string | null }[];
    return rows.map(row => ({ timestamp: row.timestamp, sample: row.sample === null ? null : JSON.parse(row.sample) }));
  }
  connections(): ConnectionRecord[] {
    return (this.db.prepare('SELECT id,name,config FROM connections ORDER BY rowid').all() as { id: string; name: string; config: string }[])
      .map(row => ({ id: row.id, name: row.name, ...JSON.parse(decrypt(row.config, this.key)) as NewApiConfig }));
  }
  addConnection(id: string, name: string, config: NewApiConfig) {
    this.db.prepare('INSERT INTO connections VALUES(?,?,?)').run(id, name, encrypt(JSON.stringify(config), this.key));
  }
  deleteConnection(id: string) { this.db.prepare('DELETE FROM connections WHERE id=?').run(id); }
  cleanup(now: number, days: number) {
    this.db.prepare('DELETE FROM history WHERE timestamp<?').run(now - days * 86400000);
    this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(now);
  }
}
