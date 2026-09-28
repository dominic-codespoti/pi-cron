/**
 * cron-guard.ts — deterministic tool-call policy for unattended pi-cron LLM steps.
 *
 * Load it only from pi-cron (`defaults.extensions` / `-e`, lean mode) — keep it out
 * of ~/.pi/agent/extensions so interactive sessions never load it. Unattended
 * steps often read untrusted text (email, feeds, CI logs), so this blocks, before
 * the tool runs and with no model judgement involved:
 *   1. any read/list/search/write/edit/bash that touches a secret path;
 *   2. writes outside the step's write roots (run scratch + /tmp/pi-cron + policy roots);
 *   3. writes to protected paths (pi config, pi-cron data/config, this checkout, shell rc);
 *   4. bash, per step: "deny" (default) | { allow: [binaries] } (one simple command,
 *      no shell metacharacters, every operand inside the write roots) | "open"
 *      (secret paths and raw network tools still blocked).
 * Policy: <data-dir>/config/cron-guard.json (data dir from PI_CRON_DIR, default
 * ~/.local/share/pi-cron):
 *   { "defaults": { "writeRoots": [], "secretPaths": [], "protectedPaths": [] },
 *     "steps": { "<job>/<step>": { "bash": ..., "writeRoots": [] }, "<job>": { ... } } }
 * pi-cron sets PI_CRON_JOB / PI_CRON_STEP / PI_CRON_SCRATCH / PI_CRON_DIR for each
 * llm step. Missing policy ⇒ strictest behaviour. Every block is logged to
 * <data-dir>/state/cron-guard.log.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HOME = os.homedir();
const CHECKOUT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

type BashPolicy = "deny" | "open" | { allow: string[] };
interface StepPolicy {
  bash?: BashPolicy;
  /** extra write roots (absolute or ~/...) on top of the defaults */
  writeRoots?: string[];
}
interface PolicyFile {
  defaults?: { writeRoots?: string[]; secretPaths?: string[]; protectedPaths?: string[]; denyPaths?: string[] };
  steps?: Record<string, StepPolicy>;
}

// Common credential locations; instances add their own via defaults.secretPaths.
const BUILTIN_SECRETS = [
  "~/.pi/agent/auth.json",
  "~/.pi/agent/secrets.json",
  "~/.pi/agent/models-store.json",
  "~/.ssh",
  "~/.gnupg",
  "~/.aws",
  "~/.azure",
  "~/.config/gcloud",
  "~/.config/gh",
  "~/.docker/config.json",
  "~/.kube",
  "~/.netrc",
  "~/.git-credentials",
  "~/.npmrc",
  "~/.cloudflared",
  "~/.wrangler",
  "~/.config/.wrangler",
];
const SECRET_NAME = /(^|\/)\.env(\.[\w-]+)?$|\.(pem|key|p12|pfx)$/i;

// Writing here would let injected text persist (extensions, jobs, skills, units, shell init).
const BUILTIN_PROTECTED = ["~/.pi", "~/.config", "~/.local/bin", "~/.bashrc", "~/.zshrc", "~/.profile", "~/.bash_profile"];

const NETWORK_BINARIES = new Set(["curl", "wget", "nc", "ncat", "netcat", "socat", "ssh", "scp", "sftp", "rsync", "telnet", "ftp"]);
// Allowlist mode: one simple command — no chaining, substitution, redirection, globbing or escapes.
const SHELL_META = /[;&|`$<>(){}\n\\*?]/;

/** Split a simple command into words honouring '...' and "..." (no escapes — `\` is rejected upstream). */
function words(command: string): string[] | undefined {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  let started = false;
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || cur) out.push(cur);
      cur = "";
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (quote) return undefined;
  if (started || cur) out.push(cur);
  return out;
}

function expand(p: string, cwd: string): string {
  const e = p.startsWith("~/") ? path.join(HOME, p.slice(2)) : p === "~" ? HOME : p;
  return path.resolve(cwd, e);
}

/** Resolve symlinks for the deepest existing ancestor so links can't escape a root. */
function real(p: string): string {
  let cur = p;
  const rest: string[] = [];
  while (cur !== path.dirname(cur)) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse());
    } catch {
      rest.push(path.basename(cur));
      cur = path.dirname(cur);
    }
  }
  return p;
}

const within = (p: string, root: string) => p === root || p.startsWith(root + path.sep);

function loadPolicy(dataDir: string): PolicyFile {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, "config", "cron-guard.json"), "utf8")) as PolicyFile;
  } catch {
    return {};
  }
}

export default function (pi: ExtensionAPI) {
  const job = process.env.PI_CRON_JOB ?? "unknown";
  const step = process.env.PI_CRON_STEP ?? "unknown";
  const scratch = process.env.PI_CRON_SCRATCH;
  const dataDir = expand(process.env.PI_CRON_DIR ?? "~/.local/share/pi-cron", HOME);
  const LOG = path.join(dataDir, "state", "cron-guard.log");
  const file = loadPolicy(dataDir);
  const policy = file.steps?.[`${job}/${step}`] ?? file.steps?.[job] ?? {};
  const bashPolicy: BashPolicy = policy.bash ?? "deny";
  const abs = (list: string[] | undefined) => (list ?? []).map((p) => expand(p, HOME));
  const SECRET_PATHS = [...abs(BUILTIN_SECRETS), ...abs(file.defaults?.secretPaths)];
  const DENY_PATHS = file.defaults?.denyPaths ?? [];
  const NEVER_WRITE = [
    ...abs(BUILTIN_PROTECTED),
    ...["config", "state", "scripts", "prompts"].map((d) => path.join(dataDir, d)),
    CHECKOUT,
    ...abs(file.defaults?.protectedPaths),
  ];
  const isSecret = (p: string) => SECRET_NAME.test(p) || SECRET_PATHS.some((s) => within(p, s) || within(s, p));
  const writeRoots = [
    "/tmp/pi-cron",
    ...(scratch ? [scratch] : []),
    ...abs(file.defaults?.writeRoots),
    ...abs(policy.writeRoots),
  ].map(real);

  const deny = (tool: string, reason: string) => {
    try {
      fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${job}/${step} BLOCKED ${tool}: ${reason}\n`);
    } catch {
      /* log dir missing — still block */
    }
    return { block: true, reason: `cron-guard: ${reason}` };
  };

  const checkWrite = (tool: string, p: string) => {
    if (isSecret(p)) return deny(tool, `secret path ${p}`);
    if (NEVER_WRITE.some((n) => within(p, n))) return deny(tool, `protected path ${p}`);
    if (!writeRoots.some((r) => within(p, r))) return deny(tool, `write outside allowed roots: ${p}`);
    return undefined;
  };

  pi.on("tool_call", async (event) => {
    const input = event.input as Record<string, unknown>;
    const cwd = process.cwd();
    const tool = event.toolName;

    const deniedPath = (value: string) => {
      const candidate = real(expand(value, cwd));
      return DENY_PATHS.some((prefix) => within(candidate, real(expand(prefix, cwd))));
    };
    for (const key of ["path", "file_path", "paths"]) {
      const value = input[key];
      const candidates = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
      for (const candidate of candidates) {
        if (deniedPath(candidate)) return deny(tool, `denied path ${candidate}`);
      }
    }
    if (tool === "bash" && typeof input.command === "string") {
      const command = input.command.replace(/~(?=\/)/g, HOME);
      for (const prefix of DENY_PATHS) {
        const absolute = real(expand(prefix, cwd));
        if (command.includes(prefix) || command.includes(absolute)) return deny(tool, `command references denied path ${prefix}`);
      }
    }

    if (tool === "read" || tool === "grep" || tool === "find" || tool === "ls") {
      const p = real(expand(typeof input.path === "string" && input.path ? input.path : ".", cwd));
      if (isSecret(p)) return deny(tool, `secret path ${p}`);
      // Searching a directory that contains secrets (e.g. ~ or ~/.config) is also refused.
      if (tool !== "read" && SECRET_PATHS.some((s) => within(s, p))) return deny(tool, `search scope contains secrets: ${p}`);
      return;
    }

    if (tool === "write" || tool === "edit") {
      if (typeof input.path !== "string") return deny(tool, "missing path");
      return checkWrite(tool, real(expand(input.path, cwd)));
    }

    if (tool === "bash") {
      const command = typeof input.command === "string" ? input.command : "";
      if (bashPolicy === "deny") return deny(tool, "bash is disabled for this step");
      const lowered = command.replace(/~(?=\/)/g, HOME);
      for (const s of SECRET_PATHS) {
        // absolute form, and the home-relative form (e.g. `cat .ssh/id_ed25519` from ~)
        const rel = s.startsWith(HOME + "/") ? s.slice(HOME.length + 1) : s;
        if (lowered.includes(s) || command.includes(rel)) return deny(tool, `command references secret path ${s}`);
      }
      if (SECRET_NAME.test(command) || /\bsecrets?\.json\b|\bauth\.json\b/.test(command)) {
        return deny(tool, "command references a secret file");
      }
      const argv = words(command) ?? command.trim().split(/\s+/);
      if (argv.some((w) => NETWORK_BINARIES.has(path.basename(w)))) return deny(tool, "raw network tools are blocked");
      if (bashPolicy === "open") return;

      if (SHELL_META.test(command)) return deny(tool, "only a single simple command is allowed (no ; | & $ ` < > * ? etc.)");
      if (!words(command)) return deny(tool, "unbalanced quotes");
      const bin = path.basename(argv[0] ?? "");
      if (!bashPolicy.allow.includes(bin)) return deny(tool, `command "${bin}" not in allowlist [${bashPolicy.allow.join(", ")}]`);
      // Every operand (and --flag=value) must resolve inside the write roots — keeps the step in its lane.
      for (const arg of argv.slice(1)) {
        const operand = arg.startsWith("-") ? (arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : "") : arg;
        if (!operand) continue;
        const p = real(expand(operand, cwd));
        if (isSecret(p)) return deny(tool, `secret path ${p}`);
        if (!writeRoots.some((r) => within(p, r))) return deny(tool, `path outside allowed roots: ${p}`);
      }
      return;
    }
  });
}
