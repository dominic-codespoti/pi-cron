/** Typed errors. Every surfaced error renders as what / where / next. */

export type ErrorCode =
  | "E_CONFIG"
  | "E_SCHEDULE"
  | "E_COND"
  | "E_TIMEOUT"
  | "E_STEP"
  | "E_LLM"
  | "E_SINK"
  | "E_LOCK"
  | "E_STATE";

export class CronError extends Error {
  code: ErrorCode;
  /** path to run transcript / log, when one exists */
  where?: string;
  /** suggested next command */
  next?: string;
  constructor(code: ErrorCode, message: string, opts?: { where?: string; next?: string }) {
    super(message);
    this.name = "CronError";
    this.code = code;
    this.where = opts?.where;
    this.next = opts?.next;
  }
  /** one-line human rendering for tool output */
  format(): string {
    let s = `[${this.code}] ${this.message}`;
    if (this.where) s += `\ntranscript: ${this.where}`;
    if (this.next) s += `\nnext: ${this.next}`;
    return s;
  }
}
