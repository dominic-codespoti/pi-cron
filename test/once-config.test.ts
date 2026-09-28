import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadOnceJobs, mergeJobLists, loadConfig } from "../src/config.js";
import type { Job } from "../src/types.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "picron-once-"));
});

function writeOnce(content: string): string {
  const file = path.join(tmp, "jobs.once.yaml");
  fs.writeFileSync(file, content);
  return file;
}

const ONCE_JOB = `jobs:
  - id: once-demo
    once: true
    runAt: "2026-10-02T09:00:00+10:00"
    enabled: true
    steps:
      - name: ping
        run: { type: exec, command: "echo once" }
`;

describe("jobs.once.yaml loader", () => {
  it("loads valid one-shots", () => {
    const jobs = loadOnceJobs(writeOnce(ONCE_JOB));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: "once-demo", once: true, runAt: "2026-10-02T09:00:00+10:00" });
  });

  it("missing or empty file means no pending one-shots", () => {
    expect(loadOnceJobs(path.join(tmp, "jobs.once.yaml"))).toEqual([]);
    expect(loadOnceJobs(writeOnce(""))).toEqual([]);
    expect(loadOnceJobs(writeOnce("jobs:\n"))).toEqual([]);
    expect(loadOnceJobs(writeOnce("# nothing here\n"))).toEqual([]);
  });

  it("rejects recurring jobs in the once file", () => {
    const file = writeOnce(`jobs:
  - id: cron-job
    schedule: "0 9 * * *"
    enabled: true
    steps:
      - name: ping
        run: { type: exec, command: "echo hi" }
`);
    expect(() => loadOnceJobs(file)).toThrow(/must set "once: true"/);
  });

  it("rejects bad runAt, schedule+once combos, and duplicates", () => {
    const badDate = writeOnce(ONCE_JOB.replace("2026-10-02T09:00:00+10:00", "someday"));
    expect(() => loadOnceJobs(badDate)).toThrow(/runAt/);
    const withSchedule = writeOnce(ONCE_JOB.replace("    once: true\n", '    once: true\n    schedule: "0 9 * * *"\n'));
    expect(() => loadOnceJobs(withSchedule)).toThrow(/must not be set/);
    const dup = writeOnce(
      ONCE_JOB +
        '  - id: once-demo\n    once: true\n    runAt: "2026-10-03T09:00:00+10:00"\n    enabled: true\n    steps:\n      - name: ping\n        run: { type: exec, command: "echo twice" }\n'
    );
    expect(() => loadOnceJobs(dup)).toThrow(/duplicate job id/);
  });

  it("main loader still rejects once-keys without once:true", () => {
    const file = path.join(tmp, "jobs.yaml");
    fs.writeFileSync(file, ONCE_JOB.replace("    once: true\n", ""));
    expect(() => loadConfig(file)).toThrow(/schedule/);
  });
});

describe("mergeJobLists", () => {
  const main: Job[] = [{ id: "daily", schedule: "0 9 * * *", enabled: true, steps: [] }];
  const once: Job[] = [{ id: "once-x", once: true, runAt: "2026-10-02T09:00:00+10:00", enabled: true, steps: [] }];

  it("merges without collision", () => {
    expect(mergeJobLists(main, once).map((j) => j.id)).toEqual(["daily", "once-x"]);
  });

  it("duplicate ids across files are an error", () => {
    expect(() => mergeJobLists(main, [{ ...once[0], id: "daily" }])).toThrow(/duplicate job id "daily"/);
  });
});
