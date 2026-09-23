# pi-cron

Scheduled shell + LLM jobs for the [Pi coding agent](https://github.com/thed24/pi-ui).
Declarative YAML, prompt files, SQLite state. **Zero runtime dependencies**
(`node:sqlite` and `Intl` are built in; `js-yaml` is the single install).

## Install

```bash
pi install git:github.com/<you>/pi-cron
# or local dev:
ln -s ~/Projects/pi-cron ~/.pi/agent/extensions/pi-cron
```

Requires Node 24+ (Pi's runtime) for `node:sqlite`.

## Quick start

```bash
cp config/jobs.yaml.example ~/.local/share/pi-cron/config/jobs.yaml
# edit it, then in any Pi session:
validate_config
run_job { "id": "sessions-maintenance" }
```

## How it works

```
schedule (cron) → condition gates → steps → report sink
```

- **Steps** are `exec` (plain shell, no LLM) or `llm` (a prompt file run via
  `pi --print` with its own model/thinking/tools/skills). Gather with scripts,
  think with models — never pay for file listings.
- **Prompts** live in `prompts/<job>/<step>.md` with `{{DATE}} {{WEEK}} {{SCRATCH}}`
  variables (plus `{{VAR:-default}}`). The rendered prompt is saved per run.
- **State** (enabled, fail counts, run history, scheduler lock) lives in
  `state/state.db`. The YAML is never written by the runner — hand-edit freely.
- **Reports** go to file sinks (`file-append` with idempotency markers,
  `file-write`, `stdout`, `none`). A weekly-note briefing and a log line use
  the same code path. No chat sessions, no inbox projects.
- **LLM steps** chain via `--session-id <job>-<WEEK>` by default
  (`session: run|none|<custom>` overrides). Scratch-dir JSON is the parseable
  handoff; session memory is context, never contract.

## Day-conditional steps

No special field — plain conditions:

```yaml
- name: intentions
  condition: test $(date +%u) -eq 1   # Mondays only
```

## Tools / commands

`schedule_job` (single-step quick adds; complex jobs belong in YAML),
`list_jobs`, `run_job`, `remove_job`, `update_job`, `resume_job`,
`validate_config`, `job_history`. Commands: `/jobs`, `/jobs logs <id>`, `/jobs resume <id>`, and `/tasks` (toggle a live tree view of jobs above the editor; `/tasks on|off` to force).

Data dir: `~/.local/share/pi-cron`, override with `PI_CRON_DIR`.

## Security

Jobs run as your user with your environment — treat `jobs.yaml`, prompt files,
and step scripts as code (review them like scripts). No secrets in YAML (use
`${ENV}` references). `llm` steps get `--approve` by default; read-only steps
should omit `edit,write` from `tools`. No telemetry, no network calls of its
own — everything a job touches is declared in its steps.

### Untrusted input: lean mode + cron-guard

Unattended llm steps that read outside text (email, feeds, CI logs) are a
prompt-injection target. Two opt-in layers help:

- **Lean mode** — set `extensions: [...]` (in `defaults`, a job, or a step).
  pi then runs with `--no-extensions --no-skills --no-prompt-templates` and loads
  only the listed `-e` files; explicit `skills:` still load. Faster and smaller,
  and the step can only call what `tools:` allows.
- **`extensions/cron-guard.ts`** — add it to that list. It blocks tool calls
  before they run: secret paths for every tool (built-in list + your
  `secretPaths`), writes outside the run scratch dir / `/tmp/pi-cron` / your
  `writeRoots`, writes to pi config, the pi-cron data dir and shell rc files,
  and bash per step (`deny` by default, `{ "allow": [...] }` for one simple
  command with operands inside the write roots, or `open`). Blocks are logged to
  `<data-dir>/state/cron-guard.log`. Policy lives in
  `<data-dir>/config/cron-guard.json` — see `config/cron-guard.json.example`.

Guards reduce blast radius; they do not make injection impossible. Prefer steps
that read untrusted text without `bash`, and let deterministic exec steps act on
the model's JSON decisions.

## Troubleshooting

- `E_SCHEDULE` — cron must be 5 fields; run `validate_config`.
- Job auto-paused after 3 fails — fix, then `resume_job`.
- Two Pi hosts? The SQLite lock means only one fires; the other registers tools only.
- `pi --print` hangs on an open stdin pipe — pi-cron spawns everything with stdin ignored. If you invoke print runs manually, redirect `< /dev/null`.
- Missed schedules never refire (by design — yesterday's morning brief is stale).
