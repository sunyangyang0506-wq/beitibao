#!/usr/bin/env bash
# Run in a disposable checkout. Never source a local or production environment.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ $# -gt 1 || ( $# -eq 1 && "$1" != "--check-prerequisites" ) ]]; then
  printf 'Usage: bash scripts/ci.sh [--check-prerequisites]\n' >&2
  exit 2
fi

sandbox=$(mktemp -d /tmp/beitibao-ci.XXXXXX)
cleanup() { rm -rf -- "$sandbox"; }
trap cleanup EXIT
mkdir -p "$sandbox/home" "$sandbox/tmp"
# npm rejects loading one path as both the user and global config.
: > "$sandbox/npm-userconfig"
: > "$sandbox/npm-globalconfig"

# An allowlist removes inherited database URLs, cloud/model/SMTP credentials,
# NODE_OPTIONS, npm authentication, and any local application feature flags.
# PATH is deliberately retained so the caller can select PostgreSQL 16 tools.
env -i PATH="$PATH" HOME="$sandbox/home" TMPDIR="$sandbox/tmp" \
  LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC CI=true \
  npm_config_cache="$sandbox/home/.npm" \
  npm_config_userconfig="$sandbox/npm-userconfig" \
  npm_config_globalconfig="$sandbox/npm-globalconfig" \
  bash -euo pipefail -s -- "${1:-}" <<'CI'
fail() { printf 'CI prerequisite failed: %s\n' "$*" >&2; exit 1; }

[[ $(id -u) != 0 ]] || fail 'initdb must run as an unprivileged user.'
for tool in node npm initdb pg_ctl psql pg_dump pg_restore createdb pdfinfo pdftotext pdftoppm; do
  command -v "$tool" >/dev/null || fail "Missing $tool. Install Node.js 24, PostgreSQL 16 tools, and Poppler."
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' \
  || fail 'Node.js 22 or newer is required (CI uses Node.js 24).'
for tool in initdb pg_ctl psql pg_dump pg_restore createdb; do
  version=$("$tool" --version)
  [[ "$version" =~ \(PostgreSQL\)[[:space:]]16\. ]] \
    || fail "$tool must be PostgreSQL 16; select its bin directory in PATH."
done

# Vite reads these files even with an empty environment. Do not allow a local
# environment file to leak into the frontend bundle or select real services.
for directory in . app pc-prototype; do
  for filename in .env .env.local .env.production .env.production.local .env.connected .env.connected.local; do
    [[ ! -e "$directory/$filename" ]] \
      || fail "Remove $directory/$filename from this disposable CI checkout."
  done
done
printf 'CI prerequisites passed: Node %s, PostgreSQL 16, Poppler; clean environment.\n' "$(node --version)"
[[ "$1" != --check-prerequisites ]] || exit 0

# Only the committed lockfiles and synthetic tests are used. No production,
# deployment, real-model evaluation, browser-login, or private corpus commands.
npm --prefix app ci --no-audit --no-fund
npm --prefix pc-prototype ci --no-audit --no-fund
node --test scripts/ci.test.mjs
npm --prefix app run lint
npm --prefix app test
bash app/scripts/test-local.sh --school-reuse
bash app/scripts/test-local.sh --release-restore
npm --prefix pc-prototype run test:unit
npm --prefix pc-prototype run build
npm --prefix pc-prototype run test:sites
npm --prefix pc-prototype run build:connected
CI
