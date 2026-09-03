/** SQLite state via node:sqlite (built-in, zero deps). Job state + run history + scheduler lock. */
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { JobState, Trigger } from "./types.js";

export class Store {
  private db: DatabaseSync;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs(
        id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        fails INTEGER NOT NULL DEFAULT 0,
        last_run_at TEXT, last_status TEXT, last_fire_minute TEXT, updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS runs(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL, week TEXT, trigger TEXT NOT NULL,
        status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
        dir TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runs_job ON runs(job_id, id DESC);
      CREATE TABLE IF NOT EXISTS locks(
        name TEXT PRIMARY KEY, owner TEXT NOT NULL, heartbeat_at TEXT NOT NULL
      );
    `);
  }

  close() {
    this.db.close();
  }

  /** ensure row exists; returns current state merged with config default */
  state(id: string, enabledDefault: boolean): JobState {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as any;
    if (!row) {
      this.db.prepare("INSERT INTO jobs(id, enabled) VALUES(?,?)").run(id, enabledDefault ? 1 : 0);
      return { enabled: enabledDefault, fails: 0 };
    }
    return {
      enabled: row.enabled === 1,
      fails: row.fails,
      lastRunAt: row.last_run_at ?? undefined,
      lastStatus: row.last_status ?? undefined,
      lastFireMinute: row.last_fire_minute ?? undefined,
    };
  }

  patch(id: string, p: Partial<{ enabled: boolean; fails: number; lastRunAt: string; lastStatus: string; lastFireMinute: string }>) {
    this.state(id, true);
    const sets: string[] = ["updated_at=datetime('now')"];
    const vals: any[] = [];
    if (p.enabled !== undefined) {
      sets.push("enabled=?");
      vals.push(p.enabled ? 1 : 0);
    }
    if (p.fails !== undefined) {
      sets.push("fails=?");
      vals.push(p.fails);
    }
    if (p.lastRunAt !== undefined) {
      sets.push("last_run_at=?");
      vals.push(p.lastRunAt);
    }
    if (p.lastStatus !== undefined) {
      sets.push("last_status=?");
      vals.push(p.lastStatus);
    }
    if (p.lastFireMinute !== undefined) {
      sets.push("last_fire_minute=?");
      vals.push(p.lastFireMinute);
    }
    vals.push(id);
    this.db.prepare(`UPDATE jobs SET ${sets.join(",")} WHERE id=?`).run(...vals);
  }

  recordRun(jobId: string, week: string, trigger: Trigger, dir: string): number {
    // prior 'running' rows for this job are orphans (killed host/timeout) — label them
    this.db.prepare("UPDATE runs SET status='orphaned' WHERE job_id=? AND status='running'").run(jobId);
    const r = this.db
      .prepare("INSERT INTO runs(job_id, week, trigger, status, started_at, dir) VALUES(?,?,?,?,datetime('now'),?)")
      .run(jobId, week, trigger, "running", dir);
    return Number(r.lastInsertRowid);
  }

  finishRun(runId: number, status: "success" | "failed") {
    this.db.prepare("UPDATE runs SET status=?, ended_at=datetime('now') WHERE id=?").run(status, runId);
  }

  history(jobId: string, limit = 10): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM runs WHERE job_id=? ORDER BY id DESC LIMIT ?").all(jobId, limit) as Array<
      Record<string, unknown>
    >;
  }

  /** single-flight across processes. stale owner (>90s heartbeat) is taken over. */
  acquireLock(name: string, owner: string, ttlSec = 90): boolean {
    const row = this.db.prepare("SELECT * FROM locks WHERE name=?").get(name) as any;
    const now = Date.now();
    if (row) {
      const age = (now - Date.parse(row.heartbeat_at)) / 1000;
      if (age < ttlSec && row.owner !== owner) return false;
    }
    this.db
      .prepare("INSERT INTO locks(name, owner, heartbeat_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner, heartbeat_at=excluded.heartbeat_at")
      .run(name, owner, new Date(now).toISOString());
    return true;
  }

  heartbeat(name: string, owner: string) {
    this.db.prepare("UPDATE locks SET heartbeat_at=? WHERE name=? AND owner=?").run(new Date().toISOString(), name, owner);
  }

  releaseLock(name: string, owner: string) {
    this.db.prepare("DELETE FROM locks WHERE name=? AND owner=?").run(name, owner);
  }

  pruneRuns(olderThanDays: number): number {
    const r = this.db
      .prepare("DELETE FROM runs WHERE started_at < datetime('now', ?)")
      .run(`-${Math.max(1, Math.floor(olderThanDays))} days`);
    return Number(r.changes);
  }
}
