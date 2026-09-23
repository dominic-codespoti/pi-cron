/**
 * pi-cron daemon — always-on scheduler backend, no Pi session required.
 *
 * Same YAML (config/jobs.yaml), prompts/, runs/, SQLite state as the Pi
 * extension. The extension and daemon single-flight via the SQLite
 * `scheduler` lock (90s TTL), so both can tick; only one fires.
 *
 * Run:  node dist/src/daemon.js   (Node >= 22.5 for node:sqlite)
 * Systemd unit: ~/.config/systemd/user/pi-cron.service
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawn } from "node:child_process";
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

/** Append a remediation ticket (<data-dir>/state/remediation-queue.json) and, when
 *  `defaults.onFailure` names a job, trigger that job promptly (e.g. a sentinel that
 *  fixes what it can and pages only when a human must act). Never throws —
 *  remediation must not break scheduling.
 *  kind: failed (code, counts to auto-pause) | auth-error | dependency-fail (never counts). */
function fileRemediationTicket(jobId: string, trigger: Trigger, fails: number, paused: boolean, runDir: string, note: string, kind: string, onFailure: string | undefined): void {
  const dataDir = path.dirname(path.dirname(runDir));
  try {
    const ticketFile = path.join(dataDir, "state", "remediation-queue.json");
    let tickets: Array<Record<string, unknown>> = [];
    try {
      if (fs.existsSync(ticketFile)) {
        const parsed = JSON.parse(fs.readFileSync(ticketFile, "utf8")) as { tickets?: unknown };
        if (parsed && typeof parsed === "object" && Array.isArray(parsed.tickets)) {
          tickets = parsed.tickets as Array<Record<string, unknown>>;
        }
      }
    } catch {
      tickets = [];
    }
    tickets.push({ jobId, trigger, fails, paused, runDir, note, kind, at: new Date().toISOString(), status: "pending" });
    fs.writeFileSync(ticketFile, JSON.stringify({ tickets: tickets.slice(-50) }, null, 2));
    logLine(`remediation ticket filed ${jobId} kind=${kind} fails=${fails}/3${paused ? " AUTO-PAUSED" : ""}`);
  } catch (e: unknown) {
    logLine(`remediation ticket FAILED for ${jobId}: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (!onFailure || onFailure === jobId) return; // no handler configured, or the handler itself failed
  try {
    const daemonJs = process.argv[1];
    if (daemonJs && fs.existsSync(daemonJs)) {
      const child = spawn(process.execPath, [daemonJs, "--run", onFailure], {
        detached: true,
        stdio: "ignore",
        cwd: dataDir,
      });
      child.unref();
      logLine(`${onFailure} triggered for ${jobId}`);
    }
  } catch (e: unknown) {
    logLine(`${onFailure} trigger FAILED for ${jobId}: ${e instanceof Error ? e.message : String(e)}`);
  }
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
        // Typed failures (T1): auth-error / dependency-fail never increment fails
        // and never auto-pause. Only code `failed` counts toward the breaker.
        const kind = (summary as { failureKind?: string }).failureKind ?? "failed";
        if (kind === "auth-error" || kind === "dependency-fail") {
          store.patch(job.id, { lastRunAt: new Date().toISOString(), lastStatus: kind as "auth-error" });
          logLine(
            `done ${job.id} trigger=${trigger} ${kind.toUpperCase()} fails=${st.fails}/3 (not counted) ${Date.now() - started}ms ${summary.reportNote} run=${summary.runDir}`,
          );
          fileRemediationTicket(job.id, trigger, st.fails, false, summary.runDir, summary.reportNote, kind, defaults.onFailure);
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
          fileRemediationTicket(job.id, trigger, fails, paused, summary.runDir, summary.reportNote, "failed", defaults.onFailure);
        }
      }
    } catch (e: unknown) {
      logLine(`fire ${job.id} ERROR: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      running.delete(job.id);
    }
  }

  // one-shot mode: node dist/src/daemon.js --run <job-id>
  // Same fire() path as the scheduler (trigger=manual). For out-of-band checks.
  const runIdx = process.argv.indexOf("--run");
  if (runIdx !== -1) {
    const id = process.argv[runIdx + 1];
    if (!id) {
      logLine("usage: daemon.js --run <job-id>");
      process.exit(2);
    }
    let jobs: Job[];
    try {
      jobs = await loadJobs();
    } catch (e: unknown) {
      logLine(`config ERROR: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    }
    const job = jobs.find((j) => j.id === id);
    if (!job) {
      logLine(`job not found: ${id}`);
      process.exit(2);
    }
    logLine(`manual run start ${id}`);
    await fire(job, "manual");
    const st = store.state(job.id, job.enabled);
    logLine(`manual run end ${id} status=${st.lastStatus}`);
    try {
      store.close();
    } catch {}
    process.exit(st.lastStatus === "success" ? 0 : 1);
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
