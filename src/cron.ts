/** Minimal 5-field cron matcher (min hour dom month dow). No dependencies.
 *  Supports *, *\/n, a-b, a-b/n, lists, and mon-sun / jan-dec names.
 *  Seconds, L/W/# and year fields are rejected at parse time.
 */
import { CronError } from "./errors.js";
import { partsInTz } from "./vars.js";

const DOW_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MON_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function num(tok: string, names: Record<string, number> | undefined, min: number, max: number, field: string): number {
  const low = tok.toLowerCase();
  if (names && low in names) return names[low];
  const n = parseInt(tok, 10);
  if (!Number.isInteger(n) || isNaN(n)) throw new CronError("E_SCHEDULE", `bad token "${tok}" in ${field}`);
  if (n < min || n > max) throw new CronError("E_SCHEDULE", `value ${n} out of range ${min}-${max} in ${field}`);
  return n; // note: 7->0 Sunday normalization happens at set level in parseField
}

function parseField(field: string, min: number, max: number, names: Record<string, number> | undefined, label: string): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr === undefined ? 1 : parseInt(stepStr, 10);
    if (!Number.isInteger(step) || step < 1) throw new CronError("E_SCHEDULE", `bad step "${part}" in ${label}`);
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = num(a, names, min, max, label);
      hi = num(b, names, min, max, label);
      if (hi < lo) throw new CronError("E_SCHEDULE", `reversed range "${part}" in ${label}`);
    } else {
      lo = hi = num(range, names, min, max, label);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (label === "day-of-week" && out.has(7)) {
    out.delete(7); // 0 and 7 are both Sunday
    out.add(0);
  }
  return out;
}

export interface ParsedCron {
  min: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  mon: Set<number>;
  dow: Set<number>;
}

export function parseCron(schedule: string): ParsedCron {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronError(
      "E_SCHEDULE",
      `expected 5 fields (min hour dom month dow), got ${fields.length} in "${schedule}"`,
    );
  }
  const [mi, h, dom, mon, dow] = fields;
  return {
    min: parseField(mi, 0, 59, undefined, "minute"),
    hour: parseField(h, 0, 23, undefined, "hour"),
    dom: parseField(dom, 1, 31, undefined, "day-of-month"),
    mon: parseField(mon, 1, 12, MON_NAMES, "month"),
    dow: parseField(dow, 0, 7, DOW_NAMES, "day-of-week"),
  };
}

/** cron AND-semantics across all five fields (Vixie `day` OR-behaviour intentionally NOT implemented;
 *  day-restricted jobs should use `condition: test $(date +%u) -eq N` for explicit OR logic) */
export function cronMatches(c: ParsedCron, date: Date, timeZone: string): boolean {
  const p = partsInTz(date, timeZone);
  const cronDow = p.dow % 7; // ISO Mon=1..Sun=7 -> cron Sun=0..Sat=6
  return c.min.has(p.mm) && c.hour.has(p.hh) && c.dom.has(p.d) && c.mon.has(p.m) && c.dow.has(cronDow);
}

/** minute key for dedupe ("fire once per matching minute") */
export function minuteKey(date: Date, timeZone: string): string {
  const p = partsInTz(date, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.hh)}:${pad(p.mm)}`;
}

/** Calculate the next matching Date for a parsed cron expression within maxDays (default 35 days) */
export function nextCronDate(c: ParsedCron, fromDate: Date = new Date(), timeZone: string, maxDays = 35): Date | null {
  const startMs = Math.floor(fromDate.getTime() / 60000) * 60000 + 60000;
  const maxMs = startMs + maxDays * 24 * 3600 * 1000;
  for (let ms = startMs; ms <= maxMs; ms += 60000) {
    const d = new Date(ms);
    if (cronMatches(c, d, timeZone)) return d;
  }
  return null;
}

/** Format time delta to next run in concise human format: "in 16h 58m", "in 45m", "in 5d 16h", "due now" */
export function formatNextRun(targetDate: Date | null, now: Date = new Date()): string {
  if (!targetDate) return "no upcoming run";
  const diffMs = targetDate.getTime() - now.getTime();
  if (diffMs <= 0) return "due now";
  const diffMins = Math.round(diffMs / 60000);
  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remH = hours % 24;
    return remH > 0 ? `in ${days}d ${remH}h` : `in ${days}d`;
  }
  if (hours > 0) {
    return mins > 0 ? `in ${hours}h ${mins}m` : `in ${hours}h`;
  }
  return `in ${mins}m`;
}

