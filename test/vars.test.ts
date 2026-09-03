import { describe, it, expect } from "vitest";
import { renderVars, partsInTz, weekIdFor, baseVars } from "../src/vars.js";

describe("renderVars", () => {
  it("replaces known vars", () => {
    expect(renderVars("a {{DATE}} b", { DATE: "2026-09-04" })).toBe("a 2026-09-04 b");
  });
  it("supports defaults", () => {
    expect(renderVars("a{{MISSING:-dflt}}b", {})).toBe("adfltb");
    expect(renderVars("a{{DATE:-dflt}}b", { DATE: "x" })).toBe("axb");
  });
  it("throws on unknown without default", () => {
    expect(() => renderVars("{{NOPE}}", {})).toThrow(/unknown template variable/);
  });
  it("throws on unknown in sink paths too", () => {
    expect(() => renderVars("/x/{{WEEK}}.md", { DATE: "d" })).toThrow();
  });
});

describe("tz parts", () => {
  it("computes Melbourne parts from UTC", () => {
    // 2026-09-03 11:13 UTC = 21:13 AEST Thursday
    const p = partsInTz(new Date("2026-09-03T11:13:30Z"), "Australia/Melbourne");
    expect(p).toMatchObject({ y: 2026, m: 9, d: 3, hh: 21, mm: 13, dow: 4 });
  });
  it("week id", () => {
    expect(weekIdFor(2026, 9, 3)).toBe("2026-W36");
    expect(weekIdFor(2026, 9, 7)).toBe("2026-W37");
  });
  it("baseVars", () => {
    const v = baseVars(new Date("2026-09-03T11:13:30Z"), "Australia/Melbourne");
    expect(v).toMatchObject({ DATE: "2026-09-03", WEEK: "2026-W36", DAY: "thu", DAYNAME: "Thursday" });
  });
});
