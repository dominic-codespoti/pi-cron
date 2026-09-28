/** node-cron-free scheduler: 15s tick, cron match, fire-once-per-minute, sqlite lock. */
import { randomUUID } from "node:crypto";
import { parseCron, cronMatches, minuteKey } from "./cron.js";
import type { Job } from "./types.js";
import type { Store } from "./store.js";

export interface SchedulerDeps {
  store: Store;
  loadJobs: () => Promise<Job[]>;
  fire: (job: Job) => Promise<void>;
  running: Set<string>;
  ownerId?: string;
}

/** lastFireMinute sentinel marking a consumed one-shot (re-enable won't refire). */
export const ONCE_FIRED_MINUTE = "once:fired";
/** Default late-fire grace for one-shots whose daemon was down at runAt. */
export const DEFAULT_ONCE_GRACE_MS = 86_400_000;

export class Scheduler {
  private timer?: NodeJS.Timeout;
  private owner: string;
  constructor(private deps: SchedulerDeps) {
    this.owner = deps.ownerId ?? `${process.pid}-${randomUUID().slice(0, 6)}`;
  }

  start(intervalMs = 15_000) {
    this.stop();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * One-shot branch: fire once at runAt, then auto-disable (at-most-once).
   * The disable lands BEFORE fire so a crash mid-fire can't duplicate the
   * run — a started-but-unfinished run row is left behind for inspection,
   * and `run_job` can re-run it manually if needed. Past-grace jobs are
   * marked missed and disabled without firing.
   */
  private async tickOnce(
    job: Job,
    st: ReturnType<Store["state"]>,
    now: Date
  ): Promise<void> {
    const { store, fire, running } = this.deps;
    const runAt = typeof job.runAt === "string" ? Date.parse(job.runAt) : NaN;
    if (Number.isNaN(runAt)) return; // validate_config reports it; scheduler stays alive
    if (st.lastFireMinute === ONCE_FIRED_MINUTE) return; // consumed (re-enable won't refire)
    const t = now.getTime();
    if (t < runAt) return;
    const graceMs = job.graceMs ?? DEFAULT_ONCE_GRACE_MS;
    if (graceMs > 0 && t - runAt > graceMs) {
      try {
        store.patch(job.id, {
          enabled: false,
          lastRunAt: new Date(t).toISOString(),
          lastStatus: "missed",
        });
      } catch {
        // patch failure: next tick retries
      }
      return;
    }
    if (job.overlap !== "parallel" && running.has(job.id)) return;
    if (!store.acquireLock("scheduler", this.owner)) return;
    try {
      store.heartbeat("scheduler", this.owner);
      try {
        store.patch(job.id, { enabled: false, lastFireMinute: ONCE_FIRED_MINUTE });
      } catch {
        return; // couldn't claim: retry next tick rather than risk double-fire
      }
      await fire(job);
    } finally {
      try {
        store.patch(job.id, { lastFireMinute: ONCE_FIRED_MINUTE });
      } catch {
        // completion status already patched by fire; marker re-assert is best-effort
      }
    }
  }

  /** single pass; also used by tests */
  async tick(now = new Date()) {
    const { store, loadJobs, fire, running } = this.deps;
    let jobs: Job[];
    try {
      jobs = await loadJobs();
    } catch {
      return; // config broken: validate_config explains; scheduler stays alive
    }
    for (const job of jobs) {
      let st: ReturnType<Store["state"]>;
      try {
        st = store.state(job.id, job.enabled);
      } catch {
        continue;
      }
      if (!st.enabled) continue;
      if (job.once === true) {
        await this.tickOnce(job, st, now);
        continue;
      }
      if (!job.schedule) continue; // config-validated otherwise; scheduler stays alive
      let parsed;
      try {
        parsed = parseCron(job.schedule);
      } catch {
        continue; // invalid schedule: validate_config reports it
      }
      const tz = job.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
      let matches = false;
      try {
        matches = cronMatches(parsed, now, tz);
      } catch {
        continue;
      }
      if (!matches) continue;
      const key = minuteKey(now, tz);
      if (st.lastFireMinute === key) continue; // already fired this minute
      if (job.overlap !== "parallel" && running.has(job.id)) continue; // skip overlapping
      // cross-process single-flight first; minute claimed AFTER fire so a crash
      // during fire leaves the slot unclaimed and allows refire on restart.
      // In-process double-fire within the same minute is still prevented by
      // `running`, and cross-process by the scheduler lock held across fire.
      if (!store.acquireLock("scheduler", this.owner)) continue;
      try {
        store.heartbeat("scheduler", this.owner);
        await fire(job);
      } finally {
        try {
          store.patch(job.id, { lastFireMinute: key });
        } catch {
          // patch failure must not break scheduling; next tick will retry
        }
      }
    }
  }
}
