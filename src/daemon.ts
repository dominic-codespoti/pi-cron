/**
 * pi-cron daemon — always-on scheduler backend, no Pi session required.
 *
 * Same YAML (config/jobs.yaml), prompts/, runs/, SQLite state as the Pi
 * extension. The extension and daemon single-flight via the SQLite
 * `scheduler` lock (90s TTL), so both can tick; only one fires.
 *
 * Run:  /home/dom/.nvm/versions/node/v24.16.0/bin/node dist/daemon.js
 * Systemd unit: ~/.config/systemd/user/pi-cron.service
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { loadConfig, expandPath } from "./config.js";
import { Store } from "./store.js";
import { Scheduler } from "./scheduler.js";
import { runJob } from "./runner.js";
import type { Job, Trigger } from "./types.js";

export function dataDir(): string {
  const override = process.env.PI_CRON_DIR;
  if (override) return expandPath(override);
  return path.join(os.homedir(), ".local", "share", "pi-cron");
}

function ensureDirs(dir: string) {
  for (const sub of ["config", "state", "runs", "prompts"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
}

const jobsFile = (dir: string) => path.join(dir, "config", "jobs.yaml");

function logLine(...parts: unknown[]) {
  const line = `[${new Date().toISOString()}] ${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}`;
  process.stdout.write(line + "\n");
}

async function main() {
  const dir = dataDir();
  ensureDirs(dir);
  const owner = `daemon-${process.pid}-${randomUUID().slice(0, 6)}`;
  const store = new Store(path.join(dir, "state", "state.db"));
  const running = new Set<string>();
  let piBinCache: string | undefined;

  function piBin(defaultsPiBin?: string): string {
    if (defaultsPiBin) return defaultsPiBin;
    if (piBinCache) return piBinCache;
    try {
      const found = execFileSync("bash", ["-lc", "command -v pi"], { encoding: "utf8" }).trim().split("\n").pop()?.trim();
      piBinCache = found || "pi";
    } catch {
      piBinCache = "pi";
    }
    return piBinCache;
  }

  async function loadJobs(): Promise<Job[]> {
    return loadConfig(jobsFile(dir)).jobs;
  }

  async function fire(job: Job, trigger: Trigger): Promise<void> {
    if (job.overlap !== "parallel" && running.has(job.id)) {
      logLine(`skip overlap ${job.id}`);
      return;
    }
    running.add(job.id);
    const started = Date.now();
    try {
      const defaults = loadConfig(jobsFile(dir)).defaults;
      const summary = await runJob(job, { dataDir: dir, store, piBin: piBin(defaults.piBin), trigger, defaults });
      const st = store.state(job.id, job.enabled);
      if (summary.success) {
        store.patch(job.id, { fails: 0, lastRunAt: new Date().toISOString(), lastStatus: "success" });
        logLine(`done ${job.id} trigger=${trigger} success ${Date.now() - started}ms ${summary.reportNote} run=${summary.runDir}`);
      } else {
        const fails = st.fails + 1;
        const patch: Parameters<Store["patch"]>[1] = { fails, lastRunAt: new Date().toISOString(), lastStatus: "failed" };
        let paused = false;
        if (fails >= 3 && st.enabled) {
          patch.enabled = false;
          paused = true;
        }
        store.patch(job.id, patch);
        logLine(
          `done ${job.id} trigger=${trigger} FAILED fails=${fails}/3${paused ? " AUTO-PAUSED" : ""} ${Date.now() - started}ms ${summary.reportNote} run=${summary.runDir}`,
        );
      }
    } catch (e: unknown) {
      logLine(`fire ${job.id} ERROR: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      running.delete(job.id);
    }
  }

  const scheduler = new Scheduler({
    store,
    loadJobs: async () => {
      try {
        return await loadJobs();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg !== loadJobsErr) {
          loadJobsErr = msg;
          logLine(`config ERROR (scheduler idle until fixed): ${msg.split("\n")[0]}`);
        }
        return [];
      }
    },
    fire: async (job) => {
      await fire(job, "cron");
    },
    running,
    ownerId: owner,
  });
  let loadJobsErr = "";

  const shutdown = () => {
    logLine(`shutdown owner=${owner}`);
    scheduler.stop();
    try {
      store.close();
    } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // startup report
  try {
    const { jobs, defaults } = loadConfig(jobsFile(dir));
    const states = jobs.map((j) => {
      const st = store.state(j.id, j.enabled);
      return `${st.enabled ? "●" : "⛔"} ${j.id} @ ${j.schedule} fails:${st.fails}/3 last:${st.lastRunAt ?? "never"}`;
    });
    logLine(`pi-cron daemon start owner=${owner} dir=${dir} tz=${defaults.timezone ?? "system"} jobs=${jobs.length}`);
    for (const s of states) logLine(`  ${s}`);
  } catch (e: unknown) {
    logLine(`config ERROR at startup: ${e instanceof Error ? e.message : String(e)}`);
  }

  scheduler.start(15_000);
  // Scheduler's interval is unref'd (correct inside the Pi host, which stays
  // alive on its own). Standalone, we need a ref'd handle or node exits.
  setInterval(() => {
    logLine("heartbeat");
  }, 60_000);
  logLine("scheduler ticking every 15s");
}

void main();
