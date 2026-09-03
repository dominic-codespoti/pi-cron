import { describe, it, expect } from "vitest";
import { parseCron, cronMatches } from "../src/cron.js";

const at = (iso: string) => new Date(iso);

describe("parseCron", () => {
  it("accepts standard schedules", () => {
    expect(() => parseCron("45 6 * * *")).not.toThrow();
    expect(() => parseCron("0 9 * * mon-fri")).not.toThrow();
    expect(() => parseCron("*/15 8-18 * * *")).not.toThrow();
  });
  it("rejects bad field counts and values", () => {
    expect(() => parseCron("45 6 * *")).toThrow(/5 fields/);
    expect(() => parseCron("61 * * * *")).toThrow(/out of range/);
    expect(() => parseCron("* * * * * *")).toThrow(/5 fields/);
    expect(() => parseCron("x * * * *")).toThrow(/bad token/);
  });
  it("treats 7 as Sunday", () => {
    const c = parseCron("0 0 * * 7");
    expect(c.dow.has(0)).toBe(true);
  });
});

describe("cronMatches", () => {
  const TZ = "Australia/Melbourne";
  it("matches a Melbourne morning", () => {
    // Thu 06:45 AEST = Wed 20:45 UTC
    const c = parseCron("45 6 * * *");
    expect(cronMatches(c, at("2026-09-02T20:45:00Z"), TZ)).toBe(true);
    expect(cronMatches(c, at("2026-09-02T20:46:00Z"), TZ)).toBe(false);
  });
  it("matches Monday-only via dow name", () => {
    const c = parseCron("0 9 * * mon");
    expect(cronMatches(c, at("2026-09-06T23:00:00Z"), TZ)).toBe(true); // Mon 09:00 AEST
    expect(cronMatches(c, at("2026-09-07T23:00:00Z"), TZ)).toBe(false); // Tue
  });
});
