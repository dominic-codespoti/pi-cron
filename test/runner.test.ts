import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runJob } from "../src/runner.js";
import { Store } from "../src/store.js";
import type { Job } from "../src/types.js";

let tmp: string;
let store: Store;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "picron-run-"));
  store = new Store(path.join(tmp, "state.db"));
});

function job(over: Partial<Job> = {}): Job {
  return {
    id: "demo",
    schedule: "* * * * *",
    enabled: true,
    steps: [{ name: "hello", run: { type: "exec", command: "echo hi-from-step" } }],
    ...over,
  };
}

const ctx = () => ({ dataDir: tmp, store, piBin: "pi", trigger: "manual" as const, defaults: {} });

describe("runner", () => {
  it("runs exec steps and captures stdout", async () => {
    const s = await runJob(job(), ctx());
    expect(s.success).toBe(true);
    expect(s.steps[0].stdout.trim()).toBe("hi-from-step");
    expect(fs.existsSync(path.join(s.runDir, "transcript.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(s.runDir, "RUN.yaml"))).toBe(true);
  });
  it("skips on false condition", async () => {
    const s = await runJob(job({ steps: [{ name: "gated", condition: "exit 3", run: { type: "exec", command: "echo no" } }] }), ctx());
    expect(s.success).toBe(true);
    expect(s.steps[0].skipped).toMatch(/condition/);
  });
  it("abort stops later steps; continue proceeds", async () => {
    const steps = [
      { name: "fail", run: { type: "exec", command: "exit 7" } },
      { name: "after", run: { type: "exec", command: "echo after" } },
    ] as Job["steps"];
    const aborted = await runJob(job({ steps }), ctx());
    expect(aborted.success).toBe(false);
    expect(aborted.steps[1].skipped).toMatch(/aborted/);
    const continued = await runJob(
      job({ steps: [{ ...steps[0], onFail: "continue" }, steps[1]] }),
      ctx(),
    );
    expect(continued.steps[1].stdout.trim()).toBe("after");
  });
  it("missing prompt file is a clear config error", async () => {
    const s = await runJob(job({ steps: [{ name: "t", run: { type: "llm", prompt: "nope.md" } }] }), ctx());
    expect(s.success).toBe(false);
    expect(s.steps[0].stdout).toMatch(/prompt file not found/);
  });
  it("records runs in sqlite", async () => {
    await runJob(job(), ctx());
    const h = store.history("demo", 5);
    expect(h.length).toBe(1);
    expect(h[0].status).toBe("success");
    expect(h[0].trigger).toBe("manual");
  });
});

describe("usage observability", () => {
  it("sessionDirFor matches Pi slug layout", async () => {
    const { sessionDirFor, lastUsage } = await import("../src/runner.js");
    expect(sessionDirFor("/home/dom/.local/share/pi-cron")).toMatch(/--home-dom-\.local-share-pi-cron--$/);
    expect(lastUsage("/tmp/definitely-not-a-pi-cwd", "nope")).toBeUndefined();
  });
  it("extractUsage handles nested cost objects", async () => {
    const { extractUsage } = await import("../src/runner.js");
    const line = 'x"usage":{"input":4459,"output":34,"cacheRead":0,"reasoning":15,"totalTokens":4493,"cost":{"input":0.0004,"total":0.0004527}}y';
    expect(extractUsage(line)).toBe("input=4459 output=34 reasoning=15 $0.0005");
    expect(extractUsage("no usage here")).toBeUndefined();
  });
});
