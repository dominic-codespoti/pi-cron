# Shared vault conventions for pi-cron prompts

Reference — do not duplicate these rules into every prompt; include this file
with `@` or rely on the job's `--skill obsidian-vault` flag.

- Frontmatter schema (all notes): `tags` (hierarchical kebab-case, 2–5),
  `aliases` (bare title first), `created`/`updated` (YYYY-MM-DD),
  `source` (vault-relative parent, e.g. `z. Work/Arinco/Clients/BHP`),
  `status` (`active` | `todo` | `archived`).
- System/raw live under `a. System/` and `a. Raw/` — never write human notes there.
  Human areas: `z. Inbox/` (staging only), `z. Personal/`, `z. Work/`.
- Inbox flow: stage stubs in `z. Inbox/` with full frontmatter; never write
  directly to wiki folders from triage steps.
- Inline `#tags` in note bodies are deprecated — frontmatter only.
  (`#todo` task markers and `#` headings are fine.)
- Keep folders shallow; navigate via MOCs + Quick Switcher, not deep trees.
- Never invent sources. `source:` is a real parent folder or a real
  `gmail:<message-id>` / URL reference.
