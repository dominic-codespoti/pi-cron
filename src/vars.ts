/** Minimal {{VAR}} / {{VAR:-default}} renderer. Closed var set, unknown = hard error. */
import { CronError } from "./errors.js";

const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\s*\}\}/g;

export function renderVars(template: string, vars: Record<string, string>): string {
  return template.replace(VAR_RE, (_m, name: string, def: string | undefined) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
    if (def !== undefined) return def;
    throw new CronError("E_CONFIG", `unknown template variable {{${name}}} (no default given)`);
  });
}

export interface TzParts {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  /** ISO day: Mon=1..Sun=7 */
  dow: number;
}

/** date/time parts in a tz, via Intl (no date libs needed) */
export function partsInTz(date: Date, timeZone: string): TzParts {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  const dowMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  let hh = parseInt(parts.hour, 10);
  if (hh === 24) hh = 0; // midnight edge in some ICU versions
  return {
    y: parseInt(parts.year, 10),
    m: parseInt(parts.month, 10),
    d: parseInt(parts.day, 10),
    hh,
    mm: parseInt(parts.minute, 10),
    dow: dowMap[parts.weekday] ?? 1,
  };
}

const pad = (n: number, l = 2) => String(n).padStart(l, "0");

/** ISO week id YYYY-Www from tz-local calendar date */
export function weekIdFor(y: number, m: number, d: number): string {
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${pad(week)}`;
}

const DAYNAMES = ["", "mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAYFULL = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** base template vars for a run; caller adds SCRATCH/RUNDIR/JOB/STEP */
export function baseVars(date: Date, timeZone: string): Record<string, string> {
  const p = partsInTz(date, timeZone);
  const ds = `${p.y}-${pad(p.m)}-${pad(p.d)}`;
  return {
    DATE: ds,
    TIME: `${pad(p.hh)}:${pad(p.mm)}`,
    WEEK: weekIdFor(p.y, p.m, p.d),
    DAY: DAYNAMES[p.dow],
    DAYNAME: DAYFULL[p.dow],
  };
}
