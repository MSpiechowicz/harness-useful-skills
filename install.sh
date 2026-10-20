#!/bin/sh
# Harness Skills installer for OpenCode on macOS and Linux.
#
#   curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/MSpiechowicz/harness-useful-skills/main/install.sh | sh
#
# Downloads the source tarball of a release from GitHub, checks it, and runs that release's own installer:
# `useful-skills install --host opencode --scope user`. The skills, agents, plugin and memory server land in your
# OpenCode user config. Needs curl, tar, gzip and Node.js 22 or newer. Nothing is installed when any check fails, and
# the temporary download is always removed. Restart OpenCode afterwards. Re-run this installer to update.
#
# Environment overrides:
#   HARNESS_SKILLS_VERSION  release tag to install (default: latest), e.g. v0.3.7
#
# To pin a release, put the variable on the shell that reads the script (not on curl):
#   curl --proto '=https' --tlsv1.2 -fsSL <this script's URL> | HARNESS_SKILLS_VERSION=v0.3.7 sh
#
# Everything runs inside main, which is called on the last line: a download cut short never runs a partial command.
set -eu

REPO="MSpiechowicz/harness-useful-skills"
VERSION="${HARNESS_SKILLS_VERSION:-latest}"
RELEASE_API="https://api.github.com/repos/$REPO/releases/latest"
MAX_ARCHIVE_BYTES=134217728
MAX_EXPANDED_BYTES=536870912
MAX_ENTRIES=20000
MAX_ENTRY_NAME=4096
# Files a release must ship for its installer to set up OpenCode, and the manifests that carry its version.
REQUIRED_FILES="useful-skills plugins/opencode/useful-skills.js"
VERSIONED_MANIFESTS="package.json plugins/opencode/useful-skills/package.json"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || fail "'$1' is required but not installed"; }

# curl only: it can hold redirects to https, a TLS 1.2 floor and a size cap, which wget cannot all do.
download() {
  curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 --max-time 300 --max-filesize "$MAX_ARCHIVE_BYTES" -o "$2" "$1"
}

# Runs a command in the C locale, so listings and patterns work on bytes. The node installer never sees it.
cl() { LC_ALL=C "$@"; }

# Reads the string field $2 of the JSON file $1 with node. Prints nothing when the file or field is not usable.
json_string() {
  node -e '
    try {
      const value = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
      if (typeof value === "string") process.stdout.write(value);
    } catch {}
  ' "$1" "$2"
}

# grep that fails closed: returns 0 on a match and 1 on none, but a grep that itself fails (exit 2 or more) stops the
# installer instead of reading as "no match" and letting an unchecked archive through.
grep_status() {
  GREP_STATUS=0
  cl grep "$@" || GREP_STATUS=$?
  case "$GREP_STATUS" in
    0) return 0 ;;
    1) return 1 ;;
    *) fail "grep failed while checking the release archive" ;;
  esac
}

# True when some line of the entry-name list matches the extended regular expression $1.
names_match() { grep_status -Eq "$1" "$TMP/names"; }

# A release tag is vMAJOR.MINOR.PATCH. The value may come from the environment, so anything else (a slash, a space, a
# newline, a query) is refused before any download.
valid_version() {
  case "$1" in
    *'
'*) return 1 ;;
  esac
  printf '%s\n' "$1" | grep -Eq '^v?[0-9]+\.[0-9]+\.[0-9]+$'
}

# Pairs the verbose listing $2 with the plain name list $1 and sums the entry sizes. The size column is found by
# anchoring on the trailing tokens, never on text a user or group name could imitate:
#   GNU tar     ... size YYYY-MM-DD HH:MM[:SS] name
#   bsdtar      ... size <month> D[D] HH:MM|YYYY name   (the month may be localized, so any word is taken)
# Exits 2 when a line doesn't fit either shape and 3 when one entry or the total exceeds $3 bytes.
check_sizes() {
  # shellcheck disable=SC2016  # the awk program is single-quoted on purpose
  cl awk -v max="$3" '
    NR == FNR { names[FNR] = $0; next }
    {
      name = names[FNR]
      if (substr($0, length($0) - length(name)) != " " name) exit 2
      count = split(substr($0, 1, length($0) - length(name) - 1), field, " ")
      last = field[count]
      before = field[count - 1]
      if (count >= 3 && last ~ /^[0-9][0-9]:[0-9][0-9](:[0-9][0-9])?$/ && before ~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]$/) size = field[count - 2]
      else if (count >= 4 && (last ~ /^[0-9][0-9]?:[0-9][0-9]$/ || last ~ /^[0-9][0-9][0-9][0-9]$/) && before ~ /^[0-9][0-9]?$/) size = field[count - 3]
      else exit 2
      if (size !~ /^[0-9]+$/) exit 2
      if (size + 0 > max) exit 3
      total += size
      if (total > max) exit 3
    }
  ' "$1" "$2"
}

cleanup() {
  # An archive can carry directories without owner permissions: make them removable first.
  chmod -R u+rwX "$TMP" 2>/dev/null || true
  rm -rf "$TMP"
}

main() {
  need curl
  need tar
  need gzip
  need grep
  command -v node >/dev/null 2>&1 || fail "Harness Skills needs Node.js 22 or newer, but 'node' was not found on your PATH. Install it from https://nodejs.org and run this again"
  NODE_VERSION="$(node -p 'process.versions.node' 2>/dev/null || true)"
  NODE_MAJOR="${NODE_VERSION%%.*}"
  case "$NODE_MAJOR" in
    '' | *[!0-9]*) fail "Harness Skills needs Node.js 22 or newer, but 'node -p process.versions.node' printed '$NODE_VERSION'. Install a current Node.js from https://nodejs.org and run this again" ;;
  esac
  [ "$NODE_MAJOR" -ge 22 ] || fail "Harness Skills needs Node.js 22 or newer, but found $NODE_VERSION. Install a current Node.js from https://nodejs.org and run this again"

  if [ "$VERSION" != "latest" ]; then
    valid_version "$VERSION" || fail "unexpected version: $VERSION (expected a release tag like v0.3.7)"
    case "$VERSION" in
      v*) ;;
      *) VERSION="v$VERSION" ;;
    esac
  fi

  TMP="$(mktemp -d)"
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  # Absolute, so the cleanup still finds the directory after the installer changes into $HOME.
  TMP="$(cd "$TMP" && pwd -P)" || fail "couldn't use the temporary directory"

  if [ "$VERSION" = "latest" ]; then
    info "Looking up the latest release"
    download "$RELEASE_API" "$TMP/release.json" || fail "couldn't look up the latest release. Set HARNESS_SKILLS_VERSION to a release tag (for example v0.3.7) and run this again"
    VERSION="$(json_string "$TMP/release.json" tag_name)"
    # The API tag keeps its v: the download URL and the manifest comparison both depend on it.
    case "$VERSION" in
      v*) ;;
      *) VERSION="" ;;
    esac
    valid_version "$VERSION" || fail "GitHub did not return a usable release tag. Set HARNESS_SKILLS_VERSION to a release tag (for example v0.3.7) and run this again"
  fi
  VERSION_NUMBER="${VERSION#v}"

  ARCHIVE="$TMP/release.tar.gz"
  URL="https://codeload.github.com/$REPO/tar.gz/refs/tags/$VERSION"
  info "Downloading Harness Skills $VERSION"
  download "$URL" "$ARCHIVE" || fail "download failed: $URL"

  ARCHIVE_BYTES="$(wc -c <"$ARCHIVE" | tr -d ' ')"
  [ "$ARCHIVE_BYTES" -gt 0 ] || fail "the release download was empty"
  [ "$ARCHIVE_BYTES" -le "$MAX_ARCHIVE_BYTES" ] || fail "the release archive exceeds the download limit"

  # Decompress without writing anything and stop reading at the limit, so a small archive cannot expand without bound.
  EXPANDED_BYTES="$(gzip -dc <"$ARCHIVE" 2>/dev/null | head -c "$((MAX_EXPANDED_BYTES + 1))" | wc -c | tr -d ' ')"
  [ "$EXPANDED_BYTES" -gt 0 ] || fail "the release download is not a valid gzip archive"
  [ "$EXPANDED_BYTES" -le "$MAX_EXPANDED_BYTES" ] || fail "the release archive expands beyond the size limit"

  # Check every entry before extracting anything: only regular files and directories, only relative names without dot
  # segments, sizes within the limit, and exactly one top-level directory.
  cl tar -tzf "$ARCHIVE" >"$TMP/names" 2>/dev/null || fail "the release download is not a valid tar archive"
  cl tar -tvzf "$ARCHIVE" >"$TMP/verbose" 2>/dev/null || fail "the release download is not a valid tar archive"
  cl cut -c1 "$TMP/verbose" >"$TMP/types"

  ENTRIES="$(wc -l <"$TMP/names" | tr -d ' ')"
  TYPES="$(wc -l <"$TMP/types" | tr -d ' ')"
  [ "$ENTRIES" -gt 0 ] && [ "$ENTRIES" -le "$MAX_ENTRIES" ] && [ "$ENTRIES" = "$TYPES" ] || fail "the release archive listing is empty, too large, or inconsistent"

  if grep_status -Evq '^[-d]$' "$TMP/types"; then
    fail "the release archive contains an entry that is not a plain file or directory (links and special files are refused)"
  fi
  # bsdtar lists a hard link as a plain file followed by "link to", so the verbose listing is checked for that too.
  if grep_status -Fq -e ' -> ' -e ' link to ' "$TMP/verbose"; then
    fail "the release archive contains a link (links are refused)"
  fi
  if names_match '^/' || names_match '(^|/)\.\.?(/|$)' || names_match '//' || names_match '^$' || grep_status -Fq "\\" "$TMP/names" || names_match '[[:cntrl:]]'; then
    fail "the release archive contains an unsafe entry name"
  fi
  # shellcheck disable=SC2016
  cl awk -v max="$MAX_ENTRY_NAME" 'length($0) > max { exit 1 }' "$TMP/names" || fail "the release archive contains an unsafe entry name"

  SIZE_STATUS=0
  check_sizes "$TMP/names" "$TMP/verbose" "$MAX_EXPANDED_BYTES" || SIZE_STATUS=$?
  case "$SIZE_STATUS" in
    0) ;;
    3) fail "the release archive expands beyond the size limit" ;;
    *) fail "couldn't read the entry sizes of the release archive" ;;
  esac

  TOP="$(cl cut -d/ -f1 "$TMP/names" | cl sort -u)"
  [ -n "$TOP" ] && [ "$(printf '%s\n' "$TOP" | wc -l | tr -d ' ')" = "1" ] || fail "the release archive must contain exactly one top-level directory"

  EXTRACT="$TMP/release"
  mkdir "$EXTRACT"
  cl tar --no-same-owner --no-same-permissions -xzf "$ARCHIVE" -C "$EXTRACT" || fail "tar could not extract the release archive"

  # Walk the extracted tree without following links: nothing but plain, singly linked files and directories may be there.
  if [ -n "$(find "$EXTRACT" ! -type f ! -type d | head -n 1)" ]; then
    fail "the extracted release contains an entry that is not a plain file or directory"
  fi
  if [ -n "$(find "$EXTRACT" -type f -links +1 | head -n 1)" ]; then
    fail "the extracted release contains a hard link (links are refused)"
  fi
  [ "$(find "$EXTRACT" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" = "1" ] && [ -d "$EXTRACT/$TOP" ] || fail "the release archive must contain exactly one top-level directory"
  ROOT="$EXTRACT/$TOP"

  # The release must be exactly the announced version and ship the OpenCode bundle and its installer.
  for MANIFEST in $VERSIONED_MANIFESTS; do
    FOUND="$(json_string "$ROOT/$MANIFEST" version)"
    if [ "$FOUND" != "$VERSION_NUMBER" ]; then
      # Only a plain version is echoed: the value comes from the archive and could carry terminal escapes.
      valid_version "$FOUND" || FOUND="(missing or not a version)"
      fail "the release archive $MANIFEST has version $FOUND, expected $VERSION_NUMBER"
    fi
  done
  for FILE in $REQUIRED_FILES; do
    if [ -L "$ROOT/$FILE" ] || [ ! -f "$ROOT/$FILE" ]; then
      fail "the release archive has no $FILE, so it cannot install the OpenCode plugin"
    fi
  done

  info "Installing Harness Skills $VERSION for OpenCode"
  cd "$HOME"
  STATUS=0
  node "$ROOT/useful-skills" install --host opencode --scope user || STATUS=$?
  if [ "$STATUS" -ne 0 ]; then
    printf '\033[1;31merror:\033[0m %s\n' "the Harness Skills installer failed (exit $STATUS)" >&2
    exit "$STATUS"
  fi

  printf '\n'
  info "Restart OpenCode to load Harness Skills."
}

main "$@"
