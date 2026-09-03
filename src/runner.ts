/** Step engine. Shell via child_process only — pi.exec is never used, so runs
 *  cannot die from stale extension contexts. */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { CronError } from "./errors.js";
import { renderVars, baseVars } from "./vars.js";
import { expandPath, resolveConfigPath } from "./config.js";
import { buildPrintCommand, defaultPromptsDir, sessionArgs } from "./llm.js";
import { applySink } from "./sinks.js";
import type { Defaults, Job, Step, StepResult, Trigger } from "./types.js";
import type { Store } from "./store.js";

export interface RunCtx {
  dataDir: string;
  store: Store;
  piBin: string;
  trigger: Trigger;
  defaults: Defaults;
  dryRun?: boolean; // gather plan without executing (validate path)
}

export interface RunSummary {
  jobId: string;
  trigger: Trigger;
  runDir: string;
  success: boolean;
  steps: StepResult[];
  reportNote: string;
}

const MAX_OUTPUT = 50 * 1024 * 1024;

function execBash(cmd: string[], opts: { cwd: string; timeoutMs: number }): Promise<{ stdout: string; stderr: string; code: number | undefined; killed: boolean }> {
  return new Promise((resolve) => {
    // stdio stdin:ignore is load-bearing — `pi --print` blocks forever on an open stdin pipe
    const child = spawn(cmd[0], cmd.slice(1), { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill("SIGKILL");
      } catch {}
    }, opts.timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + String(e?.message ?? e), code: 1, killed });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? (killed ? 124 : 1), killed });
    });
  });
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function runJob(job: Job, ctx: RunCtx): Promise<RunSummary> {
  const now = new Date();
  const tz = job.timezone ?? ctx.defaults.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const vars: Record<string, string> = {
    ...baseVars(now, tz),
    JOB: job.id,
    RUNDIR: "",
    SCRATCH: "",
    STEP: "",
  };
  const runDir = path.join(ctx.dataDir, "runs", `${job.id}-${stamp()}`);
  const scratch = path.join(runDir, "scratch");
  fs.mkdirSync(scratch, { recursive: true });
  vars.RUNDIR = runDir;
  vars.SCRATCH = scratch;

  const cwd = job.cwd ? expandPath(job.cwd) : ctx.dataDir;
  const promptsDir = job.promptsDir ? resolveConfigPath(job.promptsDir, ctx.dataDir) : defaultPromptsDir(ctx.dataDir, job.id);
  const week = vars.WEEK;
  const runStamp = `${vars.DATE}T${vars.TIME.replace(":", "-")}`;
  const runId = ctx.store.recordRun(job.id, week, ctx.trigger, runDir);

  const transcript: string[] = [];
  const log = (line: string) => transcript.push(`[${new Date().toISOString()}] ${line}`);
  log(`run start trigger=${ctx.trigger} tz=${tz} cwd=${cwd}`);

  // freeze resolved config for reproducibility
  fs.writeFileSync(path.join(runDir, "RUN.yaml"), JSON.stringify({ job, vars, trigger: ctx.trigger }, null, 2));

  const steps: StepResult[] = [];
  let aborted = false;
  let stepIdx = 0;

  for (const step of job.steps) {
    stepIdx += 1;
    const tag = String(stepIdx).padStart(2, "0") + "-" + step.name.replace(/[^a-z0-9-_]+/gi, "-");
    const stepVars = { ...vars, STEP: step.name };
    const timeoutMs = step.timeoutMs ?? job.timeoutMs ?? 300_000;

    // condition gate (after scheduling — cheap gates first by convention)
    if (step.condition && !aborted) {
      const c = await execBash(["bash", "-lc", step.condition], { cwd, timeoutMs: 5_000 });
      if (c.code !== 0) {
        log(`step ${step.name}: condition false (exit ${c.code}), skipped`);
        steps.push({ name: step.name, skipped: `condition exit ${c.code}`, stdout: "", durationMs: 0 });
        continue;
      }
    }
    if (aborted) {
      steps.push({ name: step.name, skipped: "previous step aborted", stdout: "", durationMs: 0 });
      continue;
    }

    const start = Date.now();
    try {
      if (step.run.type === "exec") {
        if (ctx.dryRun) {
          steps.push({ name: step.name, skipped: "dry-run", stdout: "", durationMs: 0 });
          continue;
        }
        const r = await execBash(["bash", "-lc", step.run.command], { cwd, timeoutMs });
        const dur = Date.now() - start;
        fs.writeFileSync(path.join(runDir, `${tag}.stdout.log`), r.stdout);
        if (r.stderr) fs.writeFileSync(path.join(runDir, `${tag}.stderr.log`), r.stderr);
        log(`step ${step.name}: exit=${r.code} killed=${r.killed} ${dur}ms`);
        if (r.killed) throw new CronError("E_TIMEOUT", `step "${step.name}" exceeded ${timeoutMs}ms`);
        if (r.code !== 0) throw new CronError("E_STEP", `step "${step.name}" exited ${r.code}: ${r.stderr.slice(0, 500)}`);
        steps.push({ name: step.name, exitCode: r.code ?? 0, stdout: r.stdout, durationMs: dur });
      } else {
        // llm step: render prompt file -> pi --print @rendered
        const srcPrompt = path.isAbsolute(step.run.prompt) ? step.run.prompt : path.join(promptsDir, step.run.prompt);
        if (!fs.existsSync(srcPrompt)) {
          throw new CronError("E_CONFIG", `step "${step.name}": prompt file not found: ${srcPrompt}`, {
            next: `create ${srcPrompt} or fix promptsDir`,
          });
        }
        const rendered = renderVars(fs.readFileSync(srcPrompt, "utf8"), stepVars);
        const renderedPath = path.join(runDir, `${tag}.prompt.rendered.md`);
        fs.writeFileSync(renderedPath, rendered);
        if (ctx.dryRun) {
          steps.push({ name: step.name, skipped: "dry-run", stdout: "", durationMs: 0, renderedPromptPath: renderedPath });
          continue;
        }
        const sess = sessionArgs(step.run.session, job.id, week, runStamp);
        const built = buildPrintCommand(step.run, {
          piBin: ctx.piBin,
          promptFile: renderedPath,
          cwd,
          sessionId: sess.sessionId,
          noSession: sess.noSession,
          model: step.run.model ?? job.model,
          thinking: step.run.thinking ?? job.thinking,
          tools: step.run.tools,
          skills: (step.run.skills ?? []).map(expandPath),
          approve: step.run.approve,
        });
        log(`step ${step.name}: ${built.cmd} ${built.args.join(" ")}`);
        const r = await execBash([built.cmd, ...built.args], { cwd: built.cwd, timeoutMs });
        const dur = Date.now() - start;
        fs.writeFileSync(path.join(runDir, `${tag}.stdout.log`), r.stdout);
        if (r.stderr) fs.writeFileSync(path.join(runDir, `${tag}.stderr.log`), r.stderr);
        log(`step ${step.name}: exit=${r.code} killed=${r.killed} ${dur}ms`);
        if (r.killed) throw new CronError("E_TIMEOUT", `step "${step.name}" exceeded ${timeoutMs}ms`);
        if (r.code !== 0) throw new CronError("E_LLM", `step "${step.name}" pi exited ${r.code}: ${r.stderr.slice(0, 500)}`);
        steps.push({ name: step.name, exitCode: r.code ?? 0, stdout: r.stdout, durationMs: dur, renderedPromptPath: renderedPath });
      }
    } catch (e: any) {
      const dur = Date.now() - start;
      const msg = e instanceof CronError ? e.format() : String(e?.message ?? e);
      log(`step ${step.name} FAILED: ${msg}`);
      steps.push({ name: step.name, exitCode: 1, stdout: msg, durationMs: dur });
      if ((step.onFail ?? "abort") === "abort") aborted = true;
      else log(`step ${step.name}: onFail=continue, proceeding`);
    }
  }

  const success = steps.every((s) => s.skipped !== undefined || s.exitCode === 0);
  // report from transcript tail (last step outputs, capped)
  const tail = steps
    .filter((s) => !s.skipped)
    .map((s) => `## ${s.name}\n\n${s.stdout.slice(-3000)}`)
    .join("\n\n");
  let reportNote = "report: none";
  try {
    reportNote = applySink(job.report, tail || "(no step output)", { jobId: job.id, vars });
  } catch (e: any) {
    reportNote = `report FAILED: ${e?.message ?? String(e)}`;
    log(reportNote);
  }
  fs.writeFileSync(path.join(runDir, "transcript.jsonl"), transcript.join("\n") + "\n");
  ctx.store.finishRun(runId, success ? "success" : "failed");
  log(`run end success=${success}; ${reportNote}`);
  fs.appendFileSync(path.join(runDir, "transcript.jsonl"), transcript.slice(-3).join("\n") + "\n");
  return { jobId: job.id, trigger: ctx.trigger, runDir, success, steps, reportNote };
}
