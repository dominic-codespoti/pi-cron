import { describe, it, expect } from "vitest";
import { Scheduler, ONCE_FIRED_MINUTE, DEFAULT_ONCE_GRACE_MS } from "../src/scheduler.js";
import type { Job } from "../src/types.js";

/** In-memory Store double: seeded enabled, records patches. */
function fakeStore(seedEnabled = true) {
  const rows = new Map<string, { enabled: boolean; lastFireMinute?: string; lastStatus?: string }>();
  const patches: Array<{ id: string; p: Record<string, unknown> }> = [];
  return {
    patches,
    rows,
    store: {
      state: (id: string, enabledDefault: boolean) => {
        let row = rows.get(id);
        if (!row) {
          row = { enabled: enabledDefault && seedEnabled };
          rows.set(id, row);
        }
        return { enabled: row.enabled, fails: 0, lastFireMinute: row.lastFireMinute, lastStatus: row.lastStatus };
      },
      patch: (id: string, p: Record<string, unknown>) => {
        patches.push({ id, p });
        const row = rows.get(id) ?? { enabled: true };
        if (p.enabled !== undefined) row.enabled = p.enabled as boolean;
        if (p.lastFireMinute !== undefined) row.lastFireMinute = p.lastFireMinute as string;
        if (p.lastStatus !== undefined) row.lastStatus = p.lastStatus as string;
        rows.set(id, row);
      },
      acquireLock: () => true,
      heartbeat: () => {},
    },
  };
}

function onceJob(over: Partial<Job> = {}): Job {
  return {
    id: "once-demo",
    once: true,
    runAt: "2026-10-02T09:00:00+10:00",
    enabled: true,
    steps: [{ name: "ping", run: { type: "exec", command: "echo once" } }],
    ...over,
  };
}

function schedulerFor(jobs: Job[], fx: ReturnType<typeof fakeStore>, fired: string[]) {
  return new Scheduler({
    store: fx.store as never,
    loadJobs: async () => jobs,
    fire: async (job: Job) => {
      fired.push(job.id);
    },
    running: new Set<string>(),
    ownerId: "test-owner",
  });
}

describe("one-shot jobs", () => {
  it("fires once when due, then auto-disables", async () => {
    const fx = fakeStore();
    const fired: string[] = [];
    const sched = schedulerFor([onceJob()], fx, fired);
    const due = new Date("2026-10-02T09:00:30+10:00");
    await sched.tick(due);
    expect(fired).toEqual(["once-demo"]);
    expect(fx.rows.get("once-demo")?.enabled).toBe(false);
    expect(fx.rows.get("once-demo")?.lastFireMinute).toBe(ONCE_FIRED_MINUTE);
    // second tick: no refire
    await sched.tick(new Date("2026-10-02T09:00:45+10:00"));
    expect(fired).toEqual(["once-demo"]);
  });

  it("does not fire before runAt", async () => {
    const fx = fakeStore();
    const fired: string[] = [];
    const sched = schedulerFor([onceJob()], fx, fired);
    await sched.tick(new Date("2026-10-01T09:00:00+10:00"));
    expect(fired).toEqual([]);
    expect(fx.rows.get("once-demo")?.enabled).toBe(true);
  });

  it("fires late within grace, marks missed past grace", async () => {
    const fx = fakeStore();
    const fired: string[] = [];
    const sched = schedulerFor([onceJob()], fx, fired);
    // 1h late, default 24h grace
    await sched.tick(new Date("2026-10-02T10:00:00+10:00"));
    expect(fired).toEqual(["once-demo"]);

    const fx2 = fakeStore();
    const fired2: string[] = [];
    const sched2 = schedulerFor([onceJob({ id: "once-late" })], fx2, fired2);
    // 48h late: missed, no fire, disabled
    await sched2.tick(new Date("2026-10-04T09:00:00+10:00"));
    expect(fired2).toEqual([]);
    expect(fx2.rows.get("once-late")?.enabled).toBe(false);
    expect(fx2.rows.get("once-late")?.lastStatus).toBe("missed");
  });

  it("graceMs: 0 means unlimited catch-up; custom grace respected", async () => {
    const fx = fakeStore();
    const fired: string[] = [];
    const sched = schedulerFor([onceJob({ graceMs: 0 })], fx, fired);
    await sched.tick(new Date("2027-01-01T00:00:00+10:00"));
    expect(fired).toEqual(["once-demo"]);

    const fx2 = fakeStore();
    const fired2: string[] = [];
    const sched2 = schedulerFor([onceJob({ id: "once-tight", graceMs: 60_000 })], fx2, fired2);
    await sched2.tick(new Date("2026-10-02T09:05:00+10:00"));
    expect(fired2).toEqual([]);
    expect(fx2.rows.get("once-tight")?.lastStatus).toBe("missed");
  });

  it("skips invalid runAt without breaking the tick", async () => {
    const fx = fakeStore();
    const fired: string[] = [];
    const sched = schedulerFor([onceJob({ runAt: "not-a-date" })], fx, fired);
    await sched.tick(new Date("2026-10-02T09:00:30+10:00"));
    expect(fired).toEqual([]);
  });

  it("re-enable after consumption does not refire", async () => {
    const fx = fakeStore();
    const fired: string[] = [];
    const sched = schedulerFor([onceJob()], fx, fired);
    await sched.tick(new Date("2026-10-02T09:00:30+10:00"));
    expect(fired).toEqual(["once-demo"]);
    // operator re-enables (e.g. resume_job): still consumed
    fx.rows.get("once-demo")!.enabled = true;
    await sched.tick(new Date("2026-10-02T09:01:00+10:00"));
    expect(fired).toEqual(["once-demo"]);
  });

  it("does not claim the minute lock when idle", async () => {
    // lock is only acquired on the fire path; assert via patch count on idle tick
    const fx = fakeStore();
    const fired: string[] = [];
    const sched = schedulerFor([onceJob()], fx, fired);
    await sched.tick(new Date("2026-10-01T00:00:00+10:00"));
    expect(fx.patches).toEqual([]);
  });

  it("exposes the default grace constant", () => {
    expect(DEFAULT_ONCE_GRACE_MS).toBe(86_400_000);
  });
});
