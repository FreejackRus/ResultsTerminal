import { DatabaseSync } from 'node:sqlite';
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  scryptSync,
  timingSafeEqual,
  createHash,
} from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { defaults, type Config, type Hardware } from '@rt/contracts';
export const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export const token = () => randomBytes(32).toString('base64url');
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function checkPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(':');
  const computed = scryptSync(password, salt, 64);
  return !!hash && hash.length === 128 && timingSafeEqual(computed, Buffer.from(hash, 'hex'));
}
export type Integration = { url: string; key: string; ca: string; timeoutMs: number };
export type TerminalRecord = {
  id: string;
  name: string;
  hardware: Partial<Hardware>;
  revoked: number;
  last_seen: number | null;
  version: string | null;
  error: string | null;
  health: unknown;
  timers: Partial<Config['timers']> | null;
};
export class Store {
  db: DatabaseSync;
  private key: Buffer;
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const keyPath = path + '.key';
    if (path !== ':memory:' && !existsSync(keyPath))
      writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    this.key = path === ':memory:' ? randomBytes(32) : readFileSync(keyPath);
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(
      `PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS settings(id TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS admins(name TEXT PRIMARY KEY,password TEXT NOT NULL); CREATE TABLE IF NOT EXISTS terminals(id TEXT PRIMARY KEY,name TEXT NOT NULL,token TEXT NOT NULL,hardware TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,last_seen INTEGER,version TEXT,error TEXT,health TEXT,timers TEXT); CREATE TABLE IF NOT EXISTS enrollment(code TEXT PRIMARY KEY,name TEXT NOT NULL,expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,time TEXT NOT NULL,event TEXT NOT NULL,subject TEXT NOT NULL); PRAGMA user_version=1;`,
    );
    this.migrateHealth();
    if (
      !this.db
        .prepare('PRAGMA table_info(terminals)')
        .all()
        .some((c) => c.name === 'timers')
    )
      this.db.exec('ALTER TABLE terminals ADD COLUMN timers TEXT');
  }
  migrateHealth() {
    const columns = this.db.prepare('PRAGMA table_info(terminals)').all();
    if (!columns.some((c) => c.name === 'health'))
      this.db.exec('ALTER TABLE terminals ADD COLUMN health TEXT');
  }
  get config(): Config {
    return JSON.parse(
      (
        this.db.prepare('SELECT value FROM settings WHERE id=?').get('config') as
          { value: string } | undefined
      )?.value ?? JSON.stringify(defaults),
    );
  }
  set config(c: Config) {
    this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('config', JSON.stringify(c));
  }
  get integration(): Integration {
    const row = this.db.prepare('SELECT value FROM settings WHERE id=?').get('integration') as
      { value: string } | undefined;
    if (!row) return { url: '', key: '', ca: '', timeoutMs: 30000 };
    const [iv, tag, data] = row.value.split('.').map((s) => Buffer.from(s, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString());
  }
  set integration(v: Integration) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, iv),
      data = Buffer.concat([cipher.update(JSON.stringify(v)), cipher.final()]);
    this.db
      .prepare('INSERT OR REPLACE INTO settings VALUES(?,?)')
      .run(
        'integration',
        [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.'),
      );
  }
  audit(event: string, subject = '') {
    this.db
      .prepare('INSERT INTO audit(time,event,subject) VALUES(?,?,?)')
      .run(new Date().toISOString(), event, subject);
    this.db.exec(
      'DELETE FROM audit WHERE id NOT IN (SELECT id FROM audit ORDER BY id DESC LIMIT 2000)',
    );
  }
  terminals(): TerminalRecord[] {
    return this.db
      .prepare(
        'SELECT id,name,hardware,revoked,last_seen,version,error,health,timers FROM terminals ORDER BY name',
      )
      .all()
      .map(
        (t) =>
          ({
            ...t,
            hardware: JSON.parse(t.hardware as string),
            health: t.health ? JSON.parse(t.health as string) : null,
            timers: t.timers ? JSON.parse(t.timers as string) : null,
          }) as TerminalRecord,
      );
  }
  terminalByToken(value: string) {
    return this.db
      .prepare('SELECT id,hardware,timers FROM terminals WHERE token=? AND revoked=0')
      .get(digest(value)) as { id: string; hardware: string; timers: string | null } | undefined;
  }
  updateHardware(id: string, hardware: Hardware) {
    this.db.prepare('UPDATE terminals SET hardware=? WHERE id=?').run(JSON.stringify(hardware), id);
  }
  close() {
    this.db.close();
  }
}
