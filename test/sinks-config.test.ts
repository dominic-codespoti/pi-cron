import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applySink } from "../src/sinks.js";
import { loadConfig } from "../src/config.js";
import { fileURLToPath } from "node:url";

const EXAMPLE = fileURLToPath(new URL("../../config/jobs.yaml.example", import.meta.url));

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "picron-"));
});

describe("sinks", () => {
  it("file-append is idempotent via marker", () => {
    const sink = { mode: "file-append" as const, path: path.join(tmp, "w.md"), marker: "brief-{{DATE}}" };
    const ctx = { jobId: "brief", vars: { DATE: "2026-09-04" } };
    const n1 = applySink(sink, "hello", ctx);
    const n2 = applySink(sink, "hello", ctx);
    expect(n1).toMatch(/appended/);
    expect(n2).toMatch(/skipped/);
    expect(fs.readFileSync(path.join(tmp, "w.md"), "utf8")).toContain("brief-2026-09-04");
  });
  it("file-write overwrites", () => {
    const sink = { mode: "file-write" as const, path: path.join(tmp, "o.md") };
    applySink(sink, "one", { jobId: "j", vars: {} });
    applySink(sink, "two", { jobId: "j", vars: {} });
    expect(fs.readFileSync(path.join(tmp, "o.md"), "utf8")).toBe("two");
  });
  it("creates parent dirs", () => {
    applySink({ mode: "file-append", path: path.join(tmp, "a", "b", "c.md") }, "x", { jobId: "j", vars: { DATE: "d" } });
    expect(fs.existsSync(path.join(tmp, "a", "b", "c.md"))).toBe(true);
  });
});

describe("config", () => {
  it("loads the example config", () => {
    const { jobs } = loadConfig(EXAMPLE);
    expect(jobs.length).toBe(3);
    expect(jobs[1].steps.map((s) => s.name)).toEqual(["gather", "triage", "write", "intentions"]);
  });
  it("rejects unknown keys, bad cron, empty steps", () => {
    const f = path.join(tmp, "bad.yaml");
    fs.writeFileSync(f, "jobs:\n  - id: x\n    schedule: nope\n    bogus: 1\n    steps: []\n");
    expect(() => loadConfig(f)).toThrow(/problem\(s\)/);
    try {
      loadConfig(f);
    } catch (e: any) {
      expect(e.message).toMatch(/unknown key "bogus"/);
      expect(e.message).toMatch(/non-empty list/);
    }
  });
  it("rejects duplicate ids", () => {
    const f = path.join(tmp, "dup.yaml");
    fs.writeFileSync(f, "jobs:\n  - id: a\n    schedule: '* * * * *'\n    steps:\n      - {name: s, run: {type: exec, command: 'true'}}\n  - id: a\n    schedule: '* * * * *'\n    steps:\n      - {name: s, run: {type: exec, command: 'true'}}\n");
    expect(() => loadConfig(f)).toThrow(/duplicate job id/);
  });
});
