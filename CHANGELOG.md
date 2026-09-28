# Changelog

## Unreleased
- One-shot jobs: `once: true` + `runAt` (ISO datetime) fire a single time and
  auto-disable (at-most-once; re-enable won't refire). `schedule` is forbidden
  on once-jobs. `graceMs` (default 24h, `0` = unlimited) bounds late catch-up
  after downtime; older is marked `missed`. Manual `--run` does not consume.
  List/tree/info views show `once <runAt>` with countdown.
- `extensions` (defaults / job / step): lean mode for llm steps — pi runs with
  `--no-extensions --no-skills --no-prompt-templates` plus only the listed `-e`
  files. llm steps get `PI_CRON_JOB`, `PI_CRON_STEP`, `PI_CRON_SCRATCH`, `PI_CRON_DIR`.
- `extensions/cron-guard.ts`: deterministic tool-call policy for unattended steps
  (secret paths, write roots, protected paths, per-step bash deny/allowlist/open),
  configured by `<data-dir>/config/cron-guard.json`.
- `defaults.onFailure: <job-id>`: the daemon runs that job after any failed run
  (remediation ticket is always filed; previously a job named `pi-sentinel` was hard-coded).
- `/tasks` widget stops polling when its session context goes stale (no more
  unhandled "extension ctx is stale" rejections in pi-ui).
- Display timezone falls back to the system zone; job descriptions come only
  from YAML (no built-in job-name table).
- Repo ships only the reusable extension, daemon, examples and tests; job
  prompts/scripts belong in your own instance directory.

## 0.1.0 — 2026-09-03
- Initial release: YAML job definitions, exec + llm step engine, prompt files
  with `{{vars}}`, per-run transcript dirs, SQLite state/history/lock,
  file report sinks, cron scheduler with single-flight, typed errors.
- Replaces the `pi-inbox` weekly-chat reporting model with file sinks.
