# Inbox triage — {{DAYNAME}} {{DATE}}

For each markdown file in ~/vaults/Notes/z. Inbox excluding README.md and
Inbox.md (max 5 files):

1. Read the file. If it is a stub under 50 words, lightly flesh it out —
   clarify, don't pad.
2. Infer 2–4 tags from content using the vault taxonomy
   (`area/personal|work`, `topic/*`, `type/note`). See @vault-conventions
   (prompts/_shared/vault-conventions.md) for the frontmatter schema.
3. Add frontmatter: `tags`, `aliases` (filename without .md),
   `created` (file mtime YYYY-MM-DD), `source: z. Inbox/<name>`,
   `status: active`.
4. Move to the best folder (`z. Personal/...` for personal,
   `z. Work/...` for work), creating parent dirs. Prefer existing folders.
5. Operate ONLY on those inbox files. Do not scan the vault. Do not touch MOCs.

End with a short report: what you moved where, one line each.
Run context: job {{JOB}}, week {{WEEK}}, scratch {{SCRATCH}}.
