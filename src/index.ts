/**
 * pi-cron — scheduled shell + LLM jobs for Pi. Zero runtime dependencies.
 *
 * Declarative YAML in <data>/config/jobs.yaml, prompt files in <data>/prompts/,
 * SQLite state in <data>/state/state.db, per-run dirs in <data>/runs/.
 * Shell runs via child_process only — never pi.exec — so cron runs cannot die
 * from stale extension contexts.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig, expandPath } from "./config.js";
import { parseCron, nextCronDate, formatNextRun } from "./cron.js";
import { Store } from "./store.js";
import { Scheduler } from "./scheduler.js";
import { runJob } from "./runner.js";
import { defaultPromptsDir } from "./llm.js";
import { CronError } from "./errors.js";
import type { Job, Trigger } from "./types.js";

export function dataDir(): string {
  const override = process.env.PI_CRON_DIR;
  if (override) return expandPath(override);
  return path.join(os.homedir(), ".local", "share", "pi-cron");
}

function ensureDirs(dir: string) {
  for (const sub of ["config", "state", "runs", "prompts"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  const jobsFile = path.join(dir, "config", "jobs.yaml");
  if (!fs.existsSync(jobsFile)) {
    fs.writeFileSync(jobsFile, `# pi-cron jobs. The runner never writes this file — state lives in state/state.db.\n# See config/jobs.yaml.example in the repo and schema/jobs.schema.json for reference.\njobs: []\n`);
  }
}

const jobsFile = (dir: string) => path.join(dir, "config", "jobs.yaml");

function shortProject(p: string): string {
  const h = os.homedir();
  return p.startsWith(h) ? "~" + p.slice(h.length) : p;
}

// ── minimal YAML block ops (append/remove/edit without reformatting) ──
function readLines(dir: string): string[] {
  return fs.readFileSync(jobsFile(dir), "utf8").split("\n");
}
function writeLines(dir: string, lines: string[]) {
  const tmp = jobsFile(dir) + ".tmp";
  fs.writeFileSync(tmp, lines.join("\n"));
  fs.renameSync(tmp, jobsFile(dir));
}
/** [start,end) of the `- id:` block, or undefined */
function findBlock(lines: string[], id: string): [number, number] | undefined {
  const startRe = new RegExp(`^\\s*-\\s*id:\\s*["']?${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*$`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*-\s*id:/.test(lines[i]) || /^[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return [start, end];
}

function yamlStr(s: string): string {
  return JSON.stringify(s);
}

export default function (pi: ExtensionAPI) {
  const dir = dataDir();
  ensureDirs(dir);
  const store = new Store(path.join(dir, "state", "state.db"));
  const running = new Set<string>();
  let piBinCache: string | undefined;

  function piBin(): string {
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

  async function fire(job: Job, trigger: Trigger): Promise<{ ok: boolean; note: string }> {
    if (job.overlap !== "parallel" && running.has(job.id)) return { ok: false, note: "skipped: overlap" };
    running.add(job.id);
    try {
      const defaults = loadConfig(jobsFile(dir)).defaults;
      const summary = await runJob(job, { dataDir: dir, store, piBin: piBin(), trigger, defaults });
      const st = store.state(job.id, job.enabled);
      if (summary.success) {
        store.patch(job.id, { fails: 0, lastRunAt: new Date().toISOString(), lastStatus: "success" });
      } else {
        const kind = (summary as { failureKind?: string }).failureKind ?? "failed";
        if (kind === "auth-error" || kind === "dependency-fail") {
          store.patch(job.id, { lastRunAt: new Date().toISOString(), lastStatus: kind as "auth-error" });
        } else {
        const fails = st.fails + 1;
        const patch: Parameters<Store["patch"]>[1] = { fails, lastRunAt: new Date().toISOString(), lastStatus: "failed" };
        let paused = false;
        if (fails >= 3 && st.enabled) {
          patch.enabled = false;
          paused = true;
        }
        store.patch(job.id, patch);
        if (paused) summary.reportNote += `\n⛔ auto-paused after 3 consecutive failures — resume_job after fixing.`;
        }
      }
      return { ok: summary.success, note: `${summary.reportNote}\nrun dir: ${summary.runDir}` };
    } finally {
      running.delete(job.id);
    }
  }

  const scheduler = new Scheduler({
    store,
    loadJobs: async () => {
      try {
        return await loadJobs();
      } catch {
        return [];
      }
    },
    fire: async (job) => {
      await fire(job, "cron");
    },
    running,
  });

  pi.on("project_trust", async (event) => {
    if (event.cwd === dir || event.cwd.startsWith(dir + path.sep)) return { trusted: "yes" as const, remember: true };
    return { trusted: "undecided" as const };
  });

  pi.on("session_start", async (_event, ctx) => {
    ensureDirs(dir);
    scheduler.start();
    if (ctx.hasUI) {
      try {
        const jobs = await loadJobs();
        const en = jobs.filter((j) => store.state(j.id, j.enabled).enabled).length;
        ctx.ui.setStatus("pi-cron", `cron: ${en}/${jobs.length} jobs`);
      } catch {}
    }
    // restore the task tree after tab switches / session rebinds (fresh extension instance)
    const entries = ctx.sessionManager.getEntries() as Array<{ type: string; customType?: string; data?: { visible?: boolean } }>;
    const last = [...entries].reverse().find((e) => e.type === "custom" && e.customType === "pi-cron-tasks-state");
    if (last?.data?.visible && ctx.hasUI !== false) {
      await showTasks(ctx);
    }
  });

  pi.on("session_shutdown", async () => {
    stopTasksTimer();
    tasksVisible = false;
    scheduler.stop();
    try {
      store.close();
    } catch {}
  });

  // ── tools ──
  pi.registerTool({
    name: "schedule_job",
    label: "Schedule Job",
    description:
      "Schedule a recurring job (single step). For multi-step jobs with prompt files, hand-write config/jobs.yaml instead (see jobs.yaml.example). Reports per job config; run job_history to inspect.",
    parameters: Type.Object({
      name: Type.String({ description: "Human name; id derived from it" }),
      schedule: Type.String({ description: "Cron: '45 6 * * *'" }),
      command: Type.Optional(Type.String({ description: "exec step shell command (omit if prompt is set)" })),
      prompt: Type.Optional(Type.String({ description: "llm step prompt file (relative to prompts/<id>/ or absolute)" })),
      cwd: Type.Optional(Type.String()),
      condition: Type.Optional(Type.String({ description: "bash gate: exit 0 runs" })),
      timezone: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const id = `${params.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24)}-${Date.now().toString(36).slice(-4)}`;
      if (!params.command && !params.prompt) throw new CronError("E_CONFIG", "schedule_job needs command or prompt");
      const lines: string[] = [];
      lines.push(`  - id: ${id}`);
      lines.push(`    schedule: ${yamlStr(params.schedule)}`);
      if (params.timezone) lines.push(`    timezone: ${yamlStr(params.timezone)}`);
      lines.push(`    cwd: ${yamlStr(params.cwd ?? ctx.cwd)}`);
      lines.push(`    enabled: true`);
      lines.push(`    steps:`);
      if (params.prompt) {
        lines.push(`      - name: main`);
        if (params.condition) lines.push(`        condition: ${yamlStr(params.condition)}`);
        lines.push(`        run: { type: llm, prompt: ${yamlStr(params.prompt)} }`);
      } else {
        lines.push(`      - name: main`);
        if (params.condition) lines.push(`        condition: ${yamlStr(params.condition)}`);
        lines.push(`        run: { type: exec, command: ${yamlStr(params.command as string)} }`);
      }
      const file = readLines(dir);
      // append inside jobs list (or create it)
      let jobsIdx = file.findIndex((l) => /^jobs:\s*(\[\])?\s*(#.*)?$/.test(l));
      if (jobsIdx === -1) {
        file.push("jobs:");
        jobsIdx = file.length - 1;
      } else if (/jobs:\s*\[\]/.test(file[jobsIdx])) {
        file[jobsIdx] = "jobs:";
      }
      file.splice(jobsIdx + 1 + countJobLines(file, jobsIdx), 0, ...lines);
      // validate before writing
      const { loadConfig: lc } = await import("./config.js");
      const tmp = file.join("\n");
      try {
        const yaml = await import("js-yaml");
        const doc: any = yaml.load(tmp);
        void doc;
      } catch (e: any) {
        throw new CronError("E_CONFIG", `generated YAML invalid: ${e?.message}`);
      }
      writeLines(dir, file);
      try {
        lc(jobsFile(dir));
      } catch (e: any) {
        throw new CronError("E_CONFIG", `job written but config invalid: ${e?.message}`);
      }
      if (params.prompt) {
        const pd = defaultPromptsDir(dir, id);
        fs.mkdirSync(pd, { recursive: true });
      }
      pokeTasks(ctx);
      return { content: [{ type: "text", text: `Scheduled ${id} @ ${params.schedule}. Validate with validate_config; test with run_job.` }], details: { id } };
    },
  });

function fallbackDescription(id: string): string {
  return id.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Fallback when a job has no timezone (defaults.timezone is applied at load). */
const SYSTEM_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

  pi.registerTool<any, Record<string, unknown>>({
    name: "list_jobs",
    label: "List Jobs",
    description: "List pi-cron jobs with state (YAML vs DB enabled, fails, last run). DB is truth for enabled/fails.",
    parameters: Type.Object({}),
    async execute() {
      let jobs: Job[];
      try {
        jobs = await loadJobs();
      } catch (e: any) {
        throw new CronError("E_CONFIG", e?.message ?? String(e), { next: "run validate_config" });
      }
      if (!jobs.length) return { content: [{ type: "text", text: "No jobs. Use schedule_job or hand-write config/jobs.yaml." }], details: { jobs: [] } };
      const now = new Date();
      const lines = jobs.map((j) => {
        const st = store.state(j.id, j.enabled);
        const icon = st.enabled ? "●" : "⛔";
        const desc = j.description || j.name || fallbackDescription(j.id);
        // T2: explicit YAML vs DB so split-brain is visible. DB wins at runtime.
        const yamlEn = j.enabled ? "YAML:on" : "YAML:off";
        const dbEn = st.enabled ? "DB:on" : "DB:off";
        const drift = j.enabled !== st.enabled ? " ⚠drift" : "";
        let nextStr = "";
        if (st.enabled) {
          try {
            const c = parseCron(j.schedule);
            const next = nextCronDate(c, now, j.timezone ?? SYSTEM_TZ);
            nextStr = ` (next: ${formatNextRun(next, now)})`;
          } catch {
            nextStr = "";
          }
        } else {
          nextStr = st.fails >= 3 ? " (auto-paused)" : " (paused)";
        }
        return `${icon} ${j.id} — ${desc} @ ${j.schedule}${nextStr} [${yamlEn}/${dbEn}${drift}] fails:${st.fails}/3 last:${st.lastRunAt ?? "never"} ${st.lastStatus ?? ""}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });

  pi.registerTool({
    name: "run_job",
    label: "Run Job",
    description: "Immediately run a job by id (one-off, trigger=manual). Use for testing.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const jobs = await loadJobs();
      const job = jobs.find((j) => j.id === params.id);
      if (!job) throw new CronError("E_CONFIG", `job not found: ${params.id}`, { next: "run list_jobs" });
      const r = await fire(job, "manual");
      pokeTasks(ctx);
      return { content: [{ type: "text", text: `${r.ok ? "success" : "FAILED"}: ${r.note}` }], details: {} };
    },
  });

  pi.registerTool({
    name: "remove_job",
    label: "Remove Job",
    description: "Remove a job by id (deletes its YAML block; history retained in SQLite).",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const file = readLines(dir);
      const block = findBlock(file, params.id);
      if (!block) throw new CronError("E_CONFIG", `job not found: ${params.id}`);
      file.splice(block[0], block[1] - block[0]);
      // drop trailing blank line left behind
      if (file[block[0]] === "" && (block[0] === 0 || file[block[0] - 1] === "")) file.splice(block[0], 1);
      writeLines(dir, file);
      pokeTasks(ctx);
      return { content: [{ type: "text", text: `Removed ${params.id}` }], details: {} };
    },
  });

  pi.registerTool({
    name: "update_job",
    label: "Update Job",
    description: "Toggle enabled or replace the schedule line of a job.",
    parameters: Type.Object({
      id: Type.String(),
      enabled: Type.Optional(Type.Boolean()),
      schedule: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const file = readLines(dir);
      const block = findBlock(file, params.id);
      if (!block) throw new CronError("E_CONFIG", `job not found: ${params.id}`);
      if (params.schedule !== undefined) {
        const { parseCron } = await import("./cron.js");
        try {
          parseCron(params.schedule);
        } catch (e: any) {
          throw new CronError("E_SCHEDULE", e?.message ?? String(e));
        }
        let done = false;
        for (let i = block[0]; i < block[1]; i++) {
          if (/^\s*schedule:/.test(file[i])) {
            file[i] = file[i].replace(/schedule:\s*.*$/, `schedule: ${yamlStr(params.schedule)}`);
            done = true;
            break;
          }
        }
        if (!done) throw new CronError("E_CONFIG", `no schedule line in ${params.id} block`);
      }
      if (params.enabled !== undefined) {
        let done = false;
        for (let i = block[0]; i < block[1]; i++) {
          if (/^\s*enabled:/.test(file[i])) {
            file[i] = file[i].replace(/enabled:\s*.*$/, `enabled: ${params.enabled}`);
            done = true;
            break;
          }
        }
        if (!done) file.splice(block[1], 0, `    enabled: ${params.enabled}`);
      }
      writeLines(dir, file);
      if (params.enabled) store.patch(params.id, { enabled: true, fails: 0 });
      if (params.enabled === false) store.patch(params.id, { enabled: false });
      pokeTasks(ctx);
      return { content: [{ type: "text", text: `Updated ${params.id}` }], details: {} };
    },
  });

  pi.registerTool({
    name: "resume_job",
    label: "Resume Job",
    description: "Resume an auto-paused job (reset fail count, re-enable).",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const file = readLines(dir);
      const block = findBlock(file, params.id);
      if (!block) throw new CronError("E_CONFIG", `job not found: ${params.id}`);
      for (let i = block[0]; i < block[1]; i++) {
        if (/^\s*enabled:/.test(file[i])) file[i] = file[i].replace(/enabled:\s*.*$/, `enabled: true`);
      }
      writeLines(dir, file);
      store.patch(params.id, { enabled: true, fails: 0 });
      pokeTasks(ctx);
      return { content: [{ type: "text", text: `Resumed ${params.id}` }], details: {} };
    },
  });

  pi.registerTool<any, Record<string, unknown>>({
    name: "validate_config",
    label: "Validate Config",
    description: "Validate config/jobs.yaml; lists every problem or confirms OK.",
    parameters: Type.Object({}),
    async execute() {
      try {
        const { jobs } = loadConfig(jobsFile(dir));
        return { content: [{ type: "text", text: `OK: ${jobs.length} job(s) valid (${jobsFile(dir)})` }], details: { count: jobs.length } };
      } catch (e: any) {
        return { content: [{ type: "text", text: e instanceof CronError ? e.format() : String(e?.message ?? e) }], details: { ok: false } };
      }
    },
  });

  pi.registerTool({
    name: "job_history",
    label: "Job History",
    description: "Show recent runs for a job (trigger, status, dir). Use failedOnly to show only failed/auth-error/dependency-fail.",
    parameters: Type.Object({
      id: Type.String(),
      limit: Type.Optional(Type.Number({ description: "default 10" })),
      failedOnly: Type.Optional(Type.Boolean({ description: "only non-success runs" })),
    }),
    async execute(_id, params) {
      const rows = store.history(params.id, Math.min((params.limit ?? 10) * 3, 50));
      const filtered = (params as { failedOnly?: boolean }).failedOnly
        ? rows.filter((r) => String(r.status) !== "success")
        : rows;
      const out = filtered.slice(0, Math.min(params.limit ?? 10, 50));
      if (!out.length) return { content: [{ type: "text", text: `No runs for ${params.id}` }], details: {} };
      const lines = out.map(
        (r) => `#${r.id} ${r.started_at} [${r.trigger}] ${r.status} dir=${shortProject(String(r.dir))}`,
      );
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });

  // ── /tasks — toggle a tree view of jobs above the editor ──
  let tasksVisible = false;
  let tasksTimer: ReturnType<typeof setInterval> | undefined;

  // Live lines + host render handle for the callback widget (agents-widget pattern).
  let tasksLines: string[] = [];
  let tasksTui: { requestRender(): void } | undefined;

  async function taskTreeLines(ctx: ExtensionContext): Promise<string[]> {
    // pi-ui web sessions expose no theme object (ctx.ui.theme is undefined there)
    // while classic TUI does — fall back to plain text so the tree renders everywhere.
    const uiTheme = (ctx.ui as unknown as { theme?: { fg: (c: string, s: string) => string } }).theme;
    const theme = uiTheme ?? { fg: (_c: string, s: string) => s };
    let jobs: Job[];
    try {
      jobs = await loadJobs();
    } catch (e: any) {
      return [
        theme.fg("accent", "⏱ pi-cron"),
        theme.fg("dim", "└── ") + theme.fg("error", `config invalid: ${e?.message}`),
      ];
    }
    if (!jobs.length) {
      return [
        theme.fg("accent", "⏱ pi-cron"),
        theme.fg("dim", "└── ") + theme.fg("dim", "no jobs — schedule_job or edit jobs.yaml"),
      ];
    }
    const en = jobs.filter((j) => store.state(j.id, j.enabled).enabled).length;
    const lines: string[] = [theme.fg("accent", "⏱ pi-cron") + theme.fg("dim", `  ${en}/${jobs.length} enabled`)];
    const now = new Date();
    jobs.forEach((j, i) => {
      const st = store.state(j.id, j.enabled);
      const isLast = i === jobs.length - 1;
      const branch = theme.fg("dim", isLast ? "└──" : "├──");
      const icon = st.enabled ? theme.fg("success", "●") : theme.fg("error", "⛔");
      const id = theme.fg(st.enabled ? "text" : "muted", j.id);

      let nextPill: string;
      if (st.enabled) {
        try {
          const c = parseCron(j.schedule);
          const next = nextCronDate(c, now, j.timezone ?? SYSTEM_TZ);
          const timeStr = formatNextRun(next, now);
          nextPill = theme.fg("accent", `(${timeStr})`);
        } catch {
          nextPill = theme.fg("dim", `(@ ${j.schedule})`);
        }
      } else {
        nextPill = st.fails >= 3 ? theme.fg("error", "(auto-paused)") : theme.fg("dim", "(paused)");
      }

      let status: string;
      if (!st.enabled && st.fails >= 3) status = theme.fg("error", "auto-paused");
      else if (st.lastStatus === "failed") status = theme.fg("error", `✗ fails ${st.fails}/3`);
      else if (st.lastStatus === "auth-error") status = theme.fg("error", "⎋ auth (not counted)");
      else if (st.lastStatus === "dependency-fail") status = theme.fg("error", "⇄ dep (not counted)");
      else if (st.lastStatus === "success") status = theme.fg("success", "✓ ok");
      else status = theme.fg("dim", "· never run");

      // Line 1: Main task row with next run countdown
      lines.push(`${branch} ${icon} ${id} ${nextPill} ${status}`);

      // Line 2: Option 3 Hierarchical indented description
      const desc = j.description || j.name || fallbackDescription(j.id);
      const subBranch = theme.fg("dim", isLast ? "    " : "│   ");
      const connector = theme.fg("dim", "└─ ");
      const descText = theme.fg("dim", desc);
      lines.push(`${subBranch}${connector}${descText}`);
    });
    return lines;
  }

  // Returns false when the captured ctx is dead (pi-ui released/replaced the
  // session without this instance seeing session_shutdown) — callers stop polling.
  async function refreshTasks(ctx: ExtensionContext): Promise<boolean> {
    try {
      if (!tasksVisible || ctx.hasUI === false) return true;
      tasksLines = await taskTreeLines(ctx);
      if (tasksTui) {
        // Component already registered (agents-widget pattern) — re-render in place.
        tasksTui.requestRender();
      } else {
        // Callback form with explicit placement, mirroring pi-subagents AgentWidget.
        ctx.ui.setWidget("pi-cron-tasks", (tui: { requestRender(): void }, _theme: unknown) => {
          tasksTui = tui;
          return {
            render: () => tasksLines,
            invalidate: () => { tasksTui = undefined; },
          };
        }, { placement: "aboveEditor" });
      }
      return true;
    } catch {
      return false;
    }
  }

  function stopTasksTimer(): void {
    if (tasksTimer) {
      clearInterval(tasksTimer);
      tasksTimer = undefined;
    }
  }

  /** re-render the tree if it is currently visible (call after job mutations) */
  function pokeTasks(ctx: ExtensionContext): void {
    if (tasksVisible) void refreshTasks(ctx);
  }

  function persistTasksState(pi: ExtensionAPI): void {
    try {
      pi.appendEntry("pi-cron-tasks-state", { visible: tasksVisible });
    } catch {}
  }

  async function showTasks(ctx: ExtensionContext): Promise<void> {
    tasksVisible = true;
    await refreshTasks(ctx);
    stopTasksTimer();
    tasksTimer = setInterval(() => {
      void refreshTasks(ctx).then((alive) => {
        if (!alive) {
          stopTasksTimer();
          tasksVisible = false;
          tasksTui = undefined;
        }
      });
    }, 20000);
  }

  function hideTasks(ctx: ExtensionContext): void {
    tasksVisible = false;
    stopTasksTimer();
    tasksTui = undefined;
    ctx.ui.setWidget("pi-cron-tasks", undefined);
  }

  pi.registerCommand("tasks", {
    description: "pi-cron tasks. Usage: /tasks [on|off|toggle|run <id>|logs <id>|info <id>|enable <id>|disable <id>]",
    handler: async (args, ctx) => {
      const raw = (args ?? "").trim();
      const parts = raw.split(/\s+/);
      const sub = parts[0]?.toLowerCase() || "";
      const targetId = parts[1];

      try {
        if (sub === "off" || sub === "hide") {
          hideTasks(ctx);
          ctx.ui.notify("Task tree hidden (/tasks to show again)", "info");
        } else if (sub === "on" || sub === "show") {
          await showTasks(ctx);
          const n = (await loadJobs()).length;
          ctx.ui.notify(`Task tree shown (${n} job${n === 1 ? "" : "s"}, refreshes every 20s)`, "info");
        } else if (sub === "toggle") {
          if (tasksVisible) {
            hideTasks(ctx);
            ctx.ui.notify("Task tree hidden", "info");
          } else {
            await showTasks(ctx);
            ctx.ui.notify("Task tree shown", "info");
          }
        } else if (sub === "run") {
          if (!targetId) {
            ctx.ui.notify("Usage: /tasks run <job-id>", "error");
            return;
          }
          const jobs = await loadJobs();
          const job = jobs.find((j) => j.id === targetId);
          if (!job) {
            ctx.ui.notify(`Job not found: ${targetId}`, "error");
            return;
          }
          ctx.ui.notify(`Starting run for ${targetId}...`, "info");
          const r = await fire(job, "manual");
          pokeTasks(ctx);
          ctx.ui.notify(r.ok ? `Job ${targetId} completed: ${r.note}` : `Job ${targetId} failed: ${r.note}`, r.ok ? "info" : "error");
        } else if (sub === "logs" || sub === "log") {
          if (!targetId) {
            ctx.ui.notify("Usage: /tasks logs <job-id> [--tail N]", "error");
            return;
          }
          const tailIdx = parts.indexOf("--tail");
          const n = tailIdx !== -1 && parts[tailIdx + 1] ? parseInt(parts[tailIdx + 1], 10) : 20;
          const rows = store.history(targetId, 1);
          if (!rows.length) {
            ctx.ui.notify(`No runs found for ${targetId}`, "warning");
            return;
          }
          const tfile = `${String(rows[0].dir)}/transcript.jsonl`;
          if (!fs.existsSync(tfile)) {
            ctx.ui.notify(`Transcript file not found: ${tfile}`, "error");
            return;
          }
          const lines = fs.readFileSync(tfile, "utf8").trim().split("\n").slice(-n);
          ctx.ui.notify(lines.join("\n").slice(-3000), "info");
        } else if (sub === "info") {
          if (!targetId) {
            ctx.ui.notify("Usage: /tasks info <job-id>", "error");
            return;
          }
          const jobs = await loadJobs();
          const job = jobs.find((j) => j.id === targetId);
          if (!job) {
            ctx.ui.notify(`Job not found: ${targetId}`, "error");
            return;
          }
          const st = store.state(job.id, job.enabled);
          const desc = job.description || job.name || fallbackDescription(job.id);
          const c = parseCron(job.schedule);
          const next = nextCronDate(c, new Date(), job.timezone ?? SYSTEM_TZ);
          const nextStr = formatNextRun(next, new Date());
          const infoLines = [
            `Task: ${job.id}`,
            `Description: ${desc}`,
            `Schedule: ${job.schedule} (${job.timezone ?? SYSTEM_TZ})`,
            `Next Run: ${next ? next.toLocaleString() : "none"} (${nextStr})`,
            `State: ${st.enabled ? "enabled" : "disabled"} | Fails: ${st.fails}/3 | Last: ${st.lastStatus ?? "never"}`,
            `Last Run At: ${st.lastRunAt ?? "never"}`,
            `Steps (${job.steps.length}): ${job.steps.map((s) => s.name).join(" -> ")}`,
            `Cwd: ${job.cwd ?? "default"}`,
          ];
          ctx.ui.notify(infoLines.join("\n"), "info");
        } else if (sub === "enable" || sub === "disable") {
          if (!targetId) {
            ctx.ui.notify(`Usage: /tasks ${sub} <job-id>`, "error");
            return;
          }
          const isEnable = sub === "enable";
          const file = readLines(dir);
          const block = findBlock(file, targetId);
          if (!block) {
            ctx.ui.notify(`Job not found in YAML: ${targetId}`, "error");
            return;
          }
          for (let i = block[0]; i < block[1]; i++) {
            if (/^\s*enabled:/.test(file[i])) file[i] = file[i].replace(/enabled:\s*.*$/, `enabled: ${isEnable}`);
          }
          writeLines(dir, file);
          store.patch(targetId, { enabled: isEnable, fails: isEnable ? 0 : undefined });
          pokeTasks(ctx);
          ctx.ui.notify(`Job ${targetId} is now ${isEnable ? "enabled" : "disabled"}.`, "info");
        } else {
          // Default: toggle visibility or show if hidden
          if (tasksVisible) {
            hideTasks(ctx);
            ctx.ui.notify("Task tree hidden", "info");
          } else {
            await showTasks(ctx);
            let n = 0;
            try { n = (await loadJobs()).length; } catch {}
            ctx.ui.notify(`Task tree shown (${n} job${n === 1 ? "" : "s"}, refreshes every 20s)`, "info");
          }
        }
        persistTasksState(pi);
      } catch (e: any) {
        ctx.ui.notify(`pi-cron /tasks failed: ${e?.message ?? e}`, "error");
      }
    },
  });

  pi.registerCommand("jobs", {
    description: "pi-cron jobs. Usage: /jobs | /jobs logs <id> [--tail N] | /jobs resume <id>",
    handler: async (args, ctx) => {
      const a = (args ?? "").trim();
      if (a.startsWith("logs ")) {
        const [, id, tailArg] = a.split(/\s+/);
        const rows = store.history(id, 1);
        if (!rows.length) {
          ctx.ui.notify(`No runs for ${id}`, "error");
          return;
        }
        const tfile = `${String(rows[0].dir)}/transcript.jsonl`;
        if (!fs.existsSync(tfile)) {
          ctx.ui.notify(`Transcript missing: ${tfile}`, "error");
          return;
        }
        const n = tailArg === "--tail" ? 30 : 15;
        const lines = fs.readFileSync(tfile, "utf8").trim().split("\n").slice(-n);
        ctx.ui.notify(lines.join("\n").slice(-3000), "info");
        return;
      }
      if (a.startsWith("resume ")) {
        const id = a.slice(7).trim();
        store.patch(id, { enabled: true, fails: 0 });
        ctx.ui.notify(`Resumed ${id} (YAML enabled flag untouched — check it too)`, "info");
        return;
      }
      try {
        const jobs = await loadJobs();
        if (!jobs.length) {
          ctx.ui.notify("No jobs.", "info");
          return;
        }
        ctx.ui.notify(
          jobs
            .map((j) => {
              const st = store.state(j.id, j.enabled);
              return `${st.enabled ? "●" : "⛔"} ${j.id} @ ${j.schedule} fails:${st.fails}/3 last:${st.lastStatus ?? "never"}`;
            })
            .join("\n"),
          "info",
        );
      } catch (e: any) {
        ctx.ui.notify(`config invalid: ${e?.message}`, "error");
      }
    },
  });
}

function countJobLines(file: string[], jobsIdx: number): number {
  // lines belonging to existing job blocks after the `jobs:` header
  let n = 0;
  for (let i = jobsIdx + 1; i < file.length; i++) {
    if (/^[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(file[i])) break; // next top-level key
    n++;
  }
  return n;
}
