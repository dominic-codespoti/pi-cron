/** jobs.yaml load + strict validate. The runner never writes this file. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import yaml from "js-yaml";
import { CronError } from "./errors.js";
import { parseCron } from "./cron.js";
import type { Defaults, FileConfig, Job, Step } from "./types.js";

export function expandPath(p: string): string {
  let s = p;
  if (s.startsWith("~/")) s = path.join(os.homedir(), s.slice(2));
  s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a: string, b: string) => {
    const v = process.env[a ?? b];
    if (v === undefined) throw new CronError("E_CONFIG", `undefined env var in path: ${p}`);
    return v;
  });
  return s;
}

const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkKeys(obj: Record<string, unknown>, allowed: string[], where: string, errors: string[]) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) errors.push(`${where}: unknown key "${k}"`);
  }
}

function reqStr(obj: Record<string, unknown>, key: string, where: string, errors: string[]): string {
  const v = obj[key];
  if (typeof v !== "string" || v.trim() === "") {
    errors.push(`${where}: "${key}" must be a non-empty string`);
    return "";
  }
  return v;
}

function optStr(obj: Record<string, unknown>, key: string, where: string, errors: string[]): string | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") {
    errors.push(`${where}: "${key}" must be a string`);
    return undefined;
  }
  return v;
}

function validateStep(raw: unknown, i: number, jobId: string, errors: string[]): Step | undefined {
  const where = `job "${jobId}" step[${i}]`;
  if (!isObj(raw)) {
    errors.push(`${where}: must be a mapping`);
    return undefined;
  }
  checkKeys(raw, ["name", "condition", "timeoutMs", "onFail", "run"], where, errors);
  const name = reqStr(raw, "name", where, errors);
  if (raw.timeoutMs !== undefined && (!Number.isInteger(raw.timeoutMs) || (raw.timeoutMs as number) <= 0)) {
    errors.push(`${where}: timeoutMs must be a positive integer (ms)`);
  }
  if (raw.onFail !== undefined && raw.onFail !== "abort" && raw.onFail !== "continue") {
    errors.push(`${where}: onFail must be abort|continue`);
  }
  const run = raw.run;
  if (!isObj(run)) {
    errors.push(`${where}: run must be a mapping with type exec|llm`);
    return undefined;
  }
  if (run.type === "exec") {
    checkKeys(run, ["type", "command"], `${where}.run`, errors);
    reqStr(run as Record<string, unknown>, "command", `${where}.run`, errors);
  } else if (run.type === "llm") {
    checkKeys(run, ["type", "prompt", "model", "thinking", "tools", "skills", "session", "approve"], `${where}.run`, errors);
    reqStr(run as Record<string, unknown>, "prompt", `${where}.run`, errors);
    if (run.thinking !== undefined && !THINKING.has(run.thinking as string)) {
      errors.push(`${where}.run: thinking must be one of ${[...THINKING].join("|")}`);
    }
    for (const k of ["tools", "skills"]) {
      const v = (run as Record<string, unknown>)[k];
      if (v !== undefined && (!Array.isArray(v) || !(v as unknown[]).every((x) => typeof x === "string"))) {
        errors.push(`${where}.run: ${k} must be a string list`);
      }
    }
  } else {
    errors.push(`${where}.run: type must be exec|llm`);
    return undefined;
  }
  return raw as unknown as Step;
}

function validateJob(raw: unknown, i: number, errors: string[]): Job | undefined {
  const where = `jobs[${i}]`;
  if (!isObj(raw)) {
    errors.push(`${where}: must be a mapping`);
    return undefined;
  }
  checkKeys(
    raw,
    ["id", "schedule", "timezone", "cwd", "promptsDir", "overlap", "timeoutMs", "model", "thinking", "enabled", "steps", "report"],
    where,
    errors,
  );
  const id = reqStr(raw, "id", where, errors);
  const schedule = reqStr(raw, "schedule", where, errors);
  if (schedule) {
    try {
      parseCron(schedule);
    } catch (e: any) {
      errors.push(`job "${id || i}": ${e?.message ?? String(e)}`);
    }
  }
  if (raw.overlap !== undefined && raw.overlap !== "skip" && raw.overlap !== "parallel") {
    errors.push(`job "${id || i}": overlap must be skip|parallel`);
  }
  if (raw.thinking !== undefined && !THINKING.has(raw.thinking as string)) {
    errors.push(`job "${id || i}": thinking must be one of ${[...THINKING].join("|")}`);
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    errors.push(`job "${id || i}": enabled must be boolean`);
  }
  const stepsRaw = raw.steps;
  const steps: Step[] = [];
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
    errors.push(`job "${id || i}": steps must be a non-empty list`);
  } else {
    const names = new Set<string>();
    stepsRaw.forEach((s, si) => {
      const step = validateStep(s, si, id || String(i), errors);
      if (step) {
        if (names.has(step.name)) errors.push(`job "${id || i}": duplicate step name "${step.name}"`);
        names.add(step.name);
        steps.push(step);
      }
    });
  }
  const report = raw.report;
  if (report !== undefined) {
    if (!isObj(report)) errors.push(`job "${id || i}": report must be a mapping`);
    else {
      checkKeys(report, ["mode", "path", "marker"], `job "${id || i}".report`, errors);
      const mode = (report as Record<string, unknown>).mode;
      if (!["file-append", "file-write", "stdout", "none"].includes(mode as string)) {
        errors.push(`job "${id || i}".report: mode must be file-append|file-write|stdout|none`);
      }
      if ((mode === "file-append" || mode === "file-write") && typeof (report as Record<string, unknown>).path !== "string") {
        errors.push(`job "${id || i}".report: path required for file-* modes`);
      }
    }
  }
  return raw as unknown as Job;
}

export interface LoadedConfig {
  defaults: Defaults;
  jobs: Job[];
}

/** load + validate; throws CronError listing all problems (fail-fast with full detail) */
export function loadConfig(file: string): LoadedConfig {
  let doc: unknown;
  try {
    doc = yaml.load(fs.readFileSync(file, "utf8"));
  } catch (e: any) {
    throw new CronError("E_CONFIG", `cannot parse ${file}: ${e?.message ?? String(e)}`, { next: "run validate_config" });
  }
  const errors: string[] = [];
  if (!isObj(doc)) throw new CronError("E_CONFIG", `${file}: top level must be a mapping`);
  checkKeys(doc, ["defaults", "jobs"], "config", errors);
  const defaults = (isObj(doc.defaults) ? (doc.defaults as Defaults) : {}) ?? {};
  if (!Array.isArray(doc.jobs)) {
    errors.push("config: jobs must be a list");
  }
  const jobs: Job[] = [];
  const ids = new Set<string>();
  if (Array.isArray(doc.jobs)) {
    doc.jobs.forEach((j, i) => {
      const job = validateJob(j, i, errors);
      if (job) {
        if (ids.has(job.id)) errors.push(`duplicate job id "${job.id}"`);
        ids.add(job.id);
        jobs.push(applyDefaults(job, defaults));
      }
    });
  }
  if (errors.length) {
    throw new CronError("E_CONFIG", `${file}: ${errors.length} problem(s):\n- ` + errors.join("\n- "), {
      next: "run validate_config",
    });
  }
  return { defaults, jobs };
}

function applyDefaults(job: Job, d: Defaults): Job {
  return {
    ...job,
    // explicit job fields win; fill only what job lacks
    timezone: job.timezone ?? d.timezone,
    overlap: job.overlap ?? d.overlap ?? "skip",
    timeoutMs: job.timeoutMs ?? d.timeoutMs ?? 300_000,
    model: job.model ?? d.model,
    thinking: job.thinking ?? d.thinking,
    enabled: job.enabled ?? true,
  };
}

/** resolve a config-relative path (prompts, cwd, sink paths): ${ENV}, ~, or relative-to-base */
export function resolveConfigPath(p: string, baseDir: string): string {
  const expanded = expandPath(p);
  if (path.isAbsolute(expanded)) return expanded;
  return path.join(baseDir, expanded);
}
