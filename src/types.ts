/** Shared types for pi-cron. Config shape mirrors config/jobs.yaml 1:1. */

export type OverlapPolicy = "skip" | "parallel";
export type FailPolicy = "abort" | "continue";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
/** "week" | "run" | "none" | explicit session id */
export type SessionScope = string;

export interface ExecRun {
  type: "exec";
  command: string;
}

export interface LlmRun {
  type: "llm";
  /** prompt file, relative to job promptsDir (or absolute) */
  prompt: string;
  model?: string;
  thinking?: ThinkingLevel;
  /** tool allowlist passed as pi -t */
  tools?: string[];
  /** --skill paths (absolute or ~/..) */
  skills?: string[];
  /** lean extension set: when set, pi runs with --no-extensions --no-skills
   *  --no-prompt-templates and loads only these -e paths. Overrides job/defaults. */
  extensions?: string[];
  /** default "week" */
  session?: SessionScope;
  /** pass --approve so project-local files are trusted. default true */
  approve?: boolean;
}

export interface Step {
  name: string;
  /** bash snippet: exit 0 runs the step. evaluated after scheduling. */
  condition?: string;
  timeoutMs?: number;
  onFail?: FailPolicy;
  run: ExecRun | LlmRun;
}

export type SinkMode = "file-append" | "file-write" | "stdout" | "none";

export interface ReportSink {
  mode: SinkMode;
  /** required for file-* modes. supports {WEEK} {DATE} ${ENV} ~ */
  path?: string;
  /** idempotency marker for file-append. default <!-- pi-cron:<job>:<DATE> --> */
  marker?: string;
}

export interface Job {
  id: string;
  name?: string;
  description?: string;
  /** cron expression; required unless `once` is true (then it must be absent). */
  schedule?: string;
  /**
   * Ephemeral one-shot: fire once at `runAt`, then auto-disable.
   * Requires `runAt`; forbids `schedule`.
   */
  once?: boolean;
  /** Absolute fire time for one-shots (ISO datetime, offset or Z required). */
  runAt?: string;
  /**
   * Late-fire grace for one-shots: fire if the daemon was down at `runAt`
   * but back within this window; older than this is marked missed.
   * Default 86_400_000 (24h); 0 = unlimited catch-up.
   */
  graceMs?: number;
  timezone?: string;
  /** cwd for exec steps and default pi cwd. default: data dir */
  cwd?: string;
  /** base dir for relative prompt paths. default: <data>/prompts/<id> */
  promptsDir?: string;
  overlap?: OverlapPolicy;
  timeoutMs?: number;
  model?: string;
  thinking?: ThinkingLevel;
  /** lean extension set for this job's llm steps (see LlmRun.extensions) */
  extensions?: string[];
  enabled: boolean;
  steps: Step[];
  report?: ReportSink;
}

export interface Defaults {
  timezone?: string;
  overlap?: OverlapPolicy;
  timeoutMs?: number;
  model?: string;
  thinking?: ThinkingLevel;
  /** default lean extension set for llm steps (see LlmRun.extensions) */
  extensions?: string[];
  /** job id the daemon runs after any failed run (e.g. a sentinel); unset = ticket only */
  onFailure?: string;
  piBin?: string;
}

export interface FileConfig {
  defaults?: Defaults;
  jobs: Job[];
}

/** runtime state, stored in SQLite (never in the YAML) */
export interface JobState {
  enabled: boolean;
  fails: number;
  lastRunAt?: string;
  lastStatus?: "success" | "failed" | "auth-error" | "dependency-fail" | "skipped";
  lastFireMinute?: string;
}

export type Trigger = "cron" | "manual";

export interface StepResult {
  name: string;
  skipped?: string;
  exitCode?: number;
  stdout: string;
  durationMs: number;
  renderedPromptPath?: string;
}
