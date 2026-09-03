/** Report sinks. File sinks are plain file ops — Obsidian-agnostic by construction. */
import * as fs from "node:fs";
import * as path from "node:path";
import { CronError } from "./errors.js";
import { renderVars } from "./vars.js";
import { expandPath } from "./config.js";
import type { ReportSink } from "./types.js";

export interface SinkCtx {
  jobId: string;
  vars: Record<string, string>;
}

function resolveSinkPath(p: string, vars: Record<string, string>): string {
  const rendered = renderVars(p, vars); // supports {WEEK} {DATE} in paths
  return expandPath(rendered);
}

export function defaultMarker(jobId: string, vars: Record<string, string>): string {
  return `<!-- pi-cron:${jobId}:${vars.DATE ?? "nodate"} -->`;
}

/**
 * Apply a sink. Returns a note for the transcript ("appended ...", "marker present, skipped", ...).
 * file-append is idempotent via marker comment.
 */
export function applySink(sink: ReportSink | undefined, content: string, ctx: SinkCtx): string {
  if (!sink || sink.mode === "none") return "report: none";
  if (sink.mode === "stdout") return "report: stdout only (see transcript)";
  if (sink.mode !== "file-append" && sink.mode !== "file-write") {
    throw new CronError("E_CONFIG", `unknown report mode "${(sink as any).mode}"`);
  }
  if (!sink.path) throw new CronError("E_CONFIG", `report mode ${sink.mode} requires path`);
  const file = resolveSinkPath(sink.path, ctx.vars);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (sink.mode === "file-write") {
    fs.writeFileSync(file, content);
    return `report: wrote ${file}`;
  }
  const marker = renderVars(sink.marker ?? defaultMarker(ctx.jobId, ctx.vars), ctx.vars);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (marker && existing.includes(marker)) return `report: marker present in ${file}, skipped (idempotent)`;
  const block = `${marker}\n\n${content.trim()}\n`;
  fs.appendFileSync(file, (existing.endsWith("\n") || existing === "" ? "" : "\n") + block);
  return `report: appended to ${file}`;
}
