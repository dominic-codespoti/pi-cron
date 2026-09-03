#!/usr/bin/env bash
# Example gather script: collect inputs into $1 (scratch dir) as JSON.
# Real jobs replace this with gws/API calls. Keep it side-effect free.
set -euo pipefail
SCRATCH="${1:?usage: gather.sh <scratch-dir>}"
date -u +%FT%TZ > "$SCRATCH/gathered_at.txt"
echo '{"ok":true}' > "$SCRATCH/mail.json"
echo '{"ok":true}' > "$SCRATCH/cal.json"
echo "gathered $(date -u +%FT%TZ)"
