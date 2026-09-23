/** Shared failure taxonomy: auth / dependency / code.
 * auth-error + dependency-fail never increment `fails` and never auto-pause.
 * Only `failed` (code bug) counts toward the 3-strike circuit breaker. */

export type FailureKind = "success" | "failed" | "auth-error" | "dependency-fail";

export const AUTH_SIGS = [
  "invalid_grant",
  "invalid grant",
  "authentication failed",
  "failed to get token",
  "unauthorized",
  " 401",
  "reauth",
  "auth login",
  "token has been expired",
  "token revoked",
];

export const DEPENDENCY_SIGS = [
  "econnrefused",
  "econnreset",
  "etimedout",
  "socket hang up",
  "bad gateway",
  "service unavailable",
  "gateway timeout",
  "temporarily unavailable",
  "eai_again",
  "enotfound",
  "timed out",
  "timeout",
  " 429",
  " 502",
  " 503",
  " 504",
  "network",
  "offline",
  "econnaborted",
  "ehostunreach",
  "restic",
  "failed to fetch",
  "mcp",
  "azure",
  "r2",
];

export function classifyFailure(text: string): Exclude<FailureKind, "success"> {
  const t = (text ?? "").toLowerCase();
  if (!t) return "failed";
  if (AUTH_SIGS.some((s) => t.includes(s))) return "auth-error";
  if (DEPENDENCY_SIGS.some((s) => t.includes(s))) return "dependency-fail";
  return "failed";
}

/** true when this kind counts toward the 3-strike auto-pause breaker */
export function countsTowardAutoPause(kind: FailureKind): boolean {
  return kind === "failed";
}
