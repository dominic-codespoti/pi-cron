/** pi --print command builder. Pure function — golden-tested, no side effects. */
import * as path from "node:path";
import type { LlmRun } from "./types.js";

export interface LlmCtx {
  piBin: string;
  promptFile: string; // already-rendered absolute path
  cwd: string;
  sessionId?: string; // omit + noSession => --no-session
  noSession?: boolean;
  model?: string;
  thinking?: LlmRun["thinking"];
  tools?: string[];
  skills?: string[];
  approve?: boolean;
}

export interface BuiltCommand {
  cmd: string;
  args: string[];
  cwd: string;
}

/** resolve session scope to --session-id / --no-session args */
export function sessionArgs(scope: string | undefined, jobId: string, week: string, runStamp: string): { sessionId?: string; noSession?: boolean } {
  const s = scope ?? "week";
  if (s === "none") return { noSession: true };
  if (s === "run") return { sessionId: `${jobId}-${runStamp}` };
  if (s === "week") return { sessionId: `${jobId}-${week}` };
  return { sessionId: s }; // explicit id passthrough
}

export function buildPrintCommand(step: LlmRun, ctx: LlmCtx): BuiltCommand {
  const args = ["--print"];
  if (ctx.noSession) args.push("--no-session");
  else if (ctx.sessionId) args.push("--session-id", ctx.sessionId);
  if (ctx.model) args.push("--model", ctx.model);
  if (ctx.thinking) args.push("--thinking", ctx.thinking);
  if (ctx.tools && ctx.tools.length) args.push("-t", ctx.tools.join(","));
  for (const s of ctx.skills ?? []) args.push("--skill", s);
  if (ctx.approve !== false) args.push("--approve");
  args.push("@" + ctx.promptFile);
  return { cmd: ctx.piBin, args, cwd: ctx.cwd };
}

/** default prompts dir for a job: <dataDir>/prompts/<jobId> */
export function defaultPromptsDir(dataDir: string, jobId: string): string {
  return path.join(dataDir, "prompts", jobId);
}
