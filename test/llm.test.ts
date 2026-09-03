import { describe, it, expect } from "vitest";
import { buildPrintCommand, sessionArgs } from "../src/llm.js";

describe("sessionArgs", () => {
  it("defaults to week scope", () => {
    expect(sessionArgs(undefined, "brief", "2026-W36", "x")).toEqual({ sessionId: "brief-2026-W36" });
  });
  it("run / none / custom", () => {
    expect(sessionArgs("run", "brief", "2026-W36", "2026-09-04T06-45")).toEqual({ sessionId: "brief-2026-09-04T06-45" });
    expect(sessionArgs("none", "brief", "2026-W36", "x")).toEqual({ noSession: true });
    expect(sessionArgs("project-thread", "brief", "2026-W36", "x")).toEqual({ sessionId: "project-thread" });
  });
});

describe("buildPrintCommand", () => {
  it("builds golden argv for a week-scoped triage step", () => {
    const b = buildPrintCommand(
      { type: "llm", prompt: "triage.md", thinking: "high", tools: ["read", "bash"], skills: ["/s/obsidian-vault"] },
      {
        piBin: "/home/dom/.local/bin/pi",
        promptFile: "/tmp/r/01-triage.prompt.rendered.md",
        cwd: "/home/dom/vaults/Notes",
        sessionId: "brief-2026-W36",
        model: "opencode-go/muse-spark-1.3-contributor",
        thinking: "high",
        tools: ["read", "bash"],
        skills: ["/s/obsidian-vault"],
        approve: true,
      },
    );
    expect(b).toEqual({
      cmd: "/home/dom/.local/bin/pi",
      cwd: "/home/dom/vaults/Notes",
      args: [
        "--print",
        "--session-id",
        "brief-2026-W36",
        "--model",
        "opencode-go/muse-spark-1.3-contributor",
        "--thinking",
        "high",
        "-t",
        "read,bash",
        "--skill",
        "/s/obsidian-vault",
        "--approve",
        "@/tmp/r/01-triage.prompt.rendered.md",
      ],
    });
  });
  it("one-shot uses --no-session and skips optionals", () => {
    const b = buildPrintCommand(
      { type: "llm", prompt: "p.md" },
      { piBin: "pi", promptFile: "/tmp/p.md", cwd: "/tmp", noSession: true },
    );
    expect(b.args).toEqual(["--print", "--no-session", "--approve", "@/tmp/p.md"]);
  });
});
