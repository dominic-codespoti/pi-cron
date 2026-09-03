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
      // claim the minute before firing (crash-safe-ish: refire only after restart edge)
      try {
        store.patch(job.id, { lastFireMinute: key });
      } catch {
        continue;
      }
      // cross-process single-flight
      if (!store.acquireLock("scheduler", this.owner)) continue;
      try {
        store.heartbeat("scheduler", this.owner);
        await fire(job);
      } finally {
        // keep lock for next ticks; heartbeat refreshes ownership
      }
    }
  }
}
