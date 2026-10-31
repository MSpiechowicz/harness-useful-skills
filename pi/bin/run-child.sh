#!/bin/sh
# Runs one independent stage (review, security review, release assessment) as a read-only child `pi` process.
# Usage: run-child.sh <role> <base-ref> <brief-file> [--ui]
# The child gets a read-only tool allowlist and no startup network calls. Staying inside the repository root is a prompt rule only.
set -eu

usage='Usage: run-child.sh <role> <base-ref> <brief-file> [--ui]'
if [ "$#" -lt 3 ] || [ "$#" -gt 4 ]; then echo "$usage" >&2; exit 64; fi
role=$1
base=$2
brief=$3
ui=no
if [ "$#" -eq 4 ]; then
  if [ "$4" != "--ui" ]; then echo "$usage" >&2; exit 64; fi
  ui=yes
fi

case "$role" in
  reviewer | security-reviewer | release-assessor) ;;
  *) echo "Unknown role '$role'. Use reviewer, security-reviewer, or release-assessor." >&2; exit 64 ;;
esac
if [ ! -f "$brief" ]; then echo "Brief file not found: $brief" >&2; exit 64; fi
# pi resolves @ paths from the repository root, so pin the brief before changing directory.
brief=$(CDPATH='' cd -- "$(dirname -- "$brief")" && pwd)/$(basename -- "$brief")
timeout_s=${PI_CHILD_TIMEOUT:-1800}
# Digits only, and not all zeros: GNU timeout reads 0 as no limit.
case "$timeout_s" in
  '' | *[!0-9]* | *[!0]*) ;;
  *) echo "PI_CHILD_TIMEOUT must be at least 1 second." >&2; exit 64 ;;
esac
case "$timeout_s" in
  '' | *[!0-9]*) echo "PI_CHILD_TIMEOUT must be a whole number of seconds." >&2; exit 64 ;;
esac

# Resolve this script's directory and the files it attaches.
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd) || exit 1
role_file=$here/../agents/$role.md
concise=$here/../skills/us-write-concisely/SKILL.md
# A missing role file must fail here, because --append-system-prompt treats an unknown path as literal text.
for required in "$role_file" "$concise"; do
  if [ ! -f "$required" ]; then echo "Required file is missing: $required" >&2; exit 1; fi
done

root=$(git rev-parse --show-toplevel) || { echo "Not inside a git repository." >&2; exit 2; }
cd -- "$root"
# Resolve the base once to a commit ID, so a hostile ref name such as `--output=x` never reaches git diff.
if ! sha=$(git rev-parse --verify --quiet --end-of-options "$base^{commit}"); then
  echo "Base ref is not a commit: $base" >&2
  exit 2
fi

d=$(mktemp -d) || exit 1
# A signal stops the child too: timeout runs in its own process group, so it would not see the signal otherwise.
child=
stop() {
  if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null || true; fi
  exit "$1"
}
trap 'rm -rf "${d:?}"' EXIT
trap 'stop 130' INT
trap 'stop 143' TERM
trap 'stop 129' HUP

# Write the change. Untracked files are listed by name only, so their content never reaches the child.
patch=$d/diff.patch
names='# Untracked files (names only: read one yourself only when needed, and never quote secrets)'
{
  echo "# Working tree (staged and unstaged) against $base ($sha), then status and untracked names"
  git diff "$sha" --
  echo "# Status"
  git status --porcelain
  echo "$names"
  git ls-files --others --exclude-standard
} >"$patch"
if [ "$(wc -c <"$patch")" -gt 409600 ]; then
  {
    echo "# The full diff against $base is too large to attach. Read the sources directly."
    git diff --stat "$sha" --
    echo "# Status"
    git status --porcelain
    echo "$names"
    git ls-files --others --exclude-standard
  } >"$patch"
fi
# An empty attachment is silently skipped, so say so explicitly.
if [ -z "$(git diff --stat "$sha" --; git status --porcelain)" ]; then
  echo "No changes against $base" >>"$patch"
fi

# Build the attachment list in the positional parameters, after everything else is validated.
set -- "@$role_file" "@$concise"
if [ "$role" = release-assessor ]; then
  rubric=$here/../skills/us-assess-release/references/rubric.md
  if [ ! -f "$rubric" ]; then echo "Required file is missing: $rubric" >&2; exit 1; fi
  set -- "$@" "@$rubric"
fi
if [ "$ui" = yes ]; then
  uiskill=$here/../skills/us-keep-ui-consistent/SKILL.md
  if [ ! -f "$uiskill" ]; then echo "Required file is missing: $uiskill" >&2; exit 1; fi
  set -- "$@" "@$uiskill"
fi
set -- "$@" "@$brief" "@$patch"

out=$d/out.txt
err=$d/err.txt
status=0
instruction='Follow the attached role and brief. Review the attached change and report.'
# Run in the background and wait, so the signal traps can run while the child is working.
if command -v timeout >/dev/null 2>&1; then
  timeout -k 30 "$timeout_s" pi -p --no-session --offline --no-extensions --no-mcp --no-skills \
    --no-prompt-templates --no-context-files --no-approve --tools read,grep,find,ls \
    --append-system-prompt "$role_file" "$@" -- "$instruction" >"$out" 2>"$err" &
else
  echo "timeout is not installed, so PI_CHILD_TIMEOUT is not enforced." >&2
  pi -p --no-session --offline --no-extensions --no-mcp --no-skills \
    --no-prompt-templates --no-context-files --no-approve --tools read,grep,find,ls \
    --append-system-prompt "$role_file" "$@" -- "$instruction" >"$out" 2>"$err" &
fi
child=$!
wait "$child" || status=$?
child=

if [ "$status" -ne 0 ]; then
  if [ "$status" -eq 124 ]; then reason="timed out after $timeout_s seconds"; else reason="pi exited with status $status"; fi
  # pi's error text may quote a key, token, or URL with credentials, so it is never echoed. Name known causes only.
  detail="Run pi yourself to see its error."
  if grep -q 'No API key found' "$err" 2>/dev/null; then detail="pi has no provider login: run pi and use /login."; fi
  echo "The stage could not be met: $reason. $detail" >&2
  exit 1
fi
if [ ! -s "$out" ]; then
  echo "The stage could not be met: the child printed no report." >&2
  exit 1
fi
cat "$out"
