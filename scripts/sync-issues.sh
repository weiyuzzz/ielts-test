#!/usr/bin/env bash
# Create the issue drafts in docs/issues/ on GitHub, and post the status update
# to the Phase 1 tracking issue (#1).
#
#   ./scripts/sync-issues.sh              # comment on #1 + create missing issues
#   ./scripts/sync-issues.sh --no-comment # only create missing issues
#
# Requires the GitHub CLI and an authenticated account with repo scope:
#   brew install gh && gh auth login
set -euo pipefail

REPO="${REPO:-weiyuzzz/ielts-test}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/docs/issues"
TRACKING_ISSUE="${TRACKING_ISSUE:-1}"
COMMENT=1
[ "${1:-}" = "--no-comment" ] && COMMENT=0

command -v gh >/dev/null 2>&1 || { echo "error: gh not installed (brew install gh)"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "error: gh not authenticated (gh auth login)"; exit 1; }

ensure_label() {
  gh label create "$1" --repo "$REPO" --color "$2" --force >/dev/null 2>&1 || true
}
ensure_label "content" 0E8A16
ensure_label "voice" 1D76DB
ensure_label "scoring" FBCA04
ensure_label "infra" 5319E7
ensure_label "enhancement" A2EEEF
ensure_label "help wanted" 008672
ensure_label "bug" D73A4A

if [ "$COMMENT" = "1" ]; then
  body="$DIR/issue-1-comment.md"
  if [ -f "$body" ]; then
    echo "commenting on issue #$TRACKING_ISSUE"
    gh issue comment "$TRACKING_ISSUE" --repo "$REPO" --body-file "$body" >/dev/null
  fi
fi

for f in "$DIR"/new-*.md; do
  [ -e "$f" ] || continue
  title="$(sed -n '1s/^# //p' "$f")"
  # The label marker is an HTML comment somewhere at the top of the file.
  labels="$(sed -n '1,5s/.*labels: \(.*\) -->.*/\1/p' "$f" | head -1)"
  # Body: drop the H1 line and the label marker (it renders invisibly anyway).
  body="$(sed '1d' "$f" | sed '/<!-- labels:/d')"

  existing="$(gh issue list --repo "$REPO" --state all --limit 200 --json title --jq '.[].title')"
  if printf '%s\n' "$existing" | grep -Fxq "$title"; then
    echo "skip (already exists): $title"
    continue
  fi

  args=(--repo "$REPO" --title "$title" --body "$body")
  IFS=',' read -ra parts <<< "$labels"
  for p in "${parts[@]}"; do
    p="$(printf '%s' "$p" | sed 's/^ *//; s/ *$//')"
    [ -n "$p" ] && args+=(--label "$p")
  done

  echo "creating: $title"
  gh issue create "${args[@]}" >/dev/null
done

echo "done. list: https://github.com/$REPO/issues"
