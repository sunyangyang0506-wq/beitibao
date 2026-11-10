#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
sandbox=$(mktemp -d /tmp/beitibao-pg.XXXXXX)
cleanup() {
  if [ -f "$sandbox/data/postmaster.pid" ]; then
    pg_ctl -D "$sandbox/data" -m fast -w stop >/dev/null
  fi
  rm -rf "$sandbox"
}
trap cleanup EXIT
initdb -D "$sandbox/data" -U beitibao_test_admin --auth=trust --no-locale --encoding=UTF8 >/dev/null
pg_ctl -D "$sandbox/data" -l "$sandbox/postgres.log" -o "-h '' -k $sandbox" -w start >/dev/null

export PGHOST="$sandbox"
export PGUSER=beitibao_test_admin
export PGDATABASE=postgres
psql -X -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE ROLE beitibao_test_api LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE beitibao_test_worker LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE beitibao_test_mail LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE beitibao_test_queue LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE beitibao_test_maintenance LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE beitibao_test_release_paper LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE beitibao_test_release_page LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE beitibao_test_release_solution LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE beitibao_test_release_prediction LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE DATABASE beitibao_test;
CREATE ROLE beitibao_test_version_owner LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE DATABASE beitibao_version_upgrade OWNER beitibao_test_version_owner;
SQL
export PGDATABASE=beitibao_test
export MIGRATION_DATABASE_URL="postgresql://beitibao_test_admin@localhost/beitibao_test?host=$sandbox"
export VERSION_UPGRADE_DATABASE_URL="postgresql://beitibao_test_version_owner@localhost/beitibao_version_upgrade?host=$sandbox"
export VERSION_UPGRADE_ADMIN_DATABASE_URL="postgresql://beitibao_test_admin@localhost/beitibao_version_upgrade?host=$sandbox"
export DATABASE_URL="postgresql://beitibao_test_api@localhost/beitibao_test?host=$sandbox"
if [[ "${1:-}" == "--upgrade-fixture" || "${1:-}" == "--release-restore" ]]; then
  node eval/run-upgrade-fixture.mjs prepare
fi
npm run migrate
npm run migrate
psql -X -v ON_ERROR_STOP=1 -v app_role=beitibao_test_api -q -f scripts/runtime-grants.sql
psql -X -v ON_ERROR_STOP=1 -v worker_role=beitibao_test_worker -q -f scripts/local-paper-grants.sql
psql -X -v ON_ERROR_STOP=1 -v mail_role=beitibao_test_mail -q -f scripts/mail-worker-grants.sql
psql -X -v ON_ERROR_STOP=1 -v queue_role=beitibao_test_queue -q -f scripts/practice-queue-grants.sql
psql -X -v ON_ERROR_STOP=1 -v maintenance_role=beitibao_test_maintenance -q -f scripts/maintenance-grants.sql
for lane in paper page solution prediction; do
  psql -X -v ON_ERROR_STOP=1 -v worker_lane="$lane" -v worker_role="beitibao_test_release_$lane" -q -f scripts/business-worker-grants.sql
done
export LOCAL_PAPER_WORKER_DATABASE_URL="postgresql://beitibao_test_worker@localhost/beitibao_test?host=$sandbox"
export RECOVERY_DATABASE_URL="postgresql://beitibao_test_mail@localhost/beitibao_test?host=$sandbox"
export PRACTICE_QUEUE_DATABASE_URL="postgresql://beitibao_test_queue@localhost/beitibao_test?host=$sandbox"
export MAINTENANCE_DATABASE_URL="postgresql://beitibao_test_maintenance@localhost/beitibao_test?host=$sandbox"
for lane in paper page solution prediction; do
  export "RELEASE_$(printf '%s' "$lane" | tr '[:lower:]' '[:upper:]')_DATABASE_URL=postgresql://beitibao_test_release_$lane@localhost/beitibao_test?host=$sandbox"
done
if [ "${1:-}" = "--corpus" ]; then
  npm run build
  node eval/run-subject-corpus.mjs
elif [ "${1:-}" = "--national-full" ]; then
  npm run build
  swiftc eval/local-page-ocr.swift -o "$sandbox/local-page-ocr"
  BEITIBAO_LOCAL_PAGE_OCR="$sandbox/local-page-ocr" \
    env -u BAILIAN_WORKSPACE_ID -u DASHSCOPE_API_KEY node eval/run-national-full.mjs
elif [ "${1:-}" = "--image-upload" ]; then
  npm run build
  if [ "${2:-}" != "--browser" ]; then
    swiftc eval/local-page-ocr.swift -o "$sandbox/local-page-ocr"
  fi
  BEITIBAO_LOCAL_PAGE_OCR="$sandbox/local-page-ocr" \
    env -u BAILIAN_WORKSPACE_ID -u DASHSCOPE_API_KEY node eval/run-image-upload.mjs "${@:2}"
elif [ "${1:-}" = "--school-reuse" ]; then
  npm run build
  node --test tests/school-reuse.integration.mjs
elif [ "${1:-}" = "--release-browser" ]; then
  npm run build
  npm --prefix ../pc-prototype run build:connected
  env -u BAILIAN_WORKSPACE_ID -u DASHSCOPE_API_KEY node eval/run-release-browser.mjs
elif [ "${1:-}" = "--upgrade-fixture" ]; then
  npm run build
  node eval/run-upgrade-fixture.mjs verify
elif [ "${1:-}" = "--release-restore" ]; then
  npm run build
  node eval/run-upgrade-fixture.mjs verify --private
  pg_dump --format=custom --file="$sandbox/release.dump" "$MIGRATION_DATABASE_URL"
  createdb beitibao_restore
  pg_restore --exit-on-error --dbname=beitibao_restore "$sandbox/release.dump"
  MIGRATION_DATABASE_URL="postgresql://beitibao_test_admin@localhost/beitibao_restore?host=$sandbox" \
    DATABASE_URL="postgresql://beitibao_test_api@localhost/beitibao_restore?host=$sandbox" \
    node eval/run-upgrade-fixture.mjs verify --private
elif [ "${1:-}" = "--practice-load" ]; then
  npm run build
  env -u BAILIAN_WORKSPACE_ID -u DASHSCOPE_API_KEY node eval/run-practice-load.mjs "${@:2}"
elif [ "${1:-}" = "--prediction-live" ]; then
  npm run build
  env -u BAILIAN_WORKSPACE_ID -u DASHSCOPE_API_KEY node --env-file="$HOME/.config/beitibao/bailian.env" eval/run-prediction-live.mjs "${@:2}"
elif [ "${1:-}" = "--urjc-whole-paper" ]; then
  npm run build
  env -u BAILIAN_WORKSPACE_ID -u DASHSCOPE_API_KEY node --env-file="$HOME/.config/beitibao/bailian.env" eval/urjc-2025-pilot/run-whole-paper.mjs "${@:2}"
elif [ "${1:-}" = "--moex-2020" ]; then
  npm run build
  env -u BAILIAN_WORKSPACE_ID -u DASHSCOPE_API_KEY BAILIAN_DAILY_BUDGET_CENTS=100 BAILIAN_TENANT_DAILY_BUDGET_CENTS=100 \
    node --env-file="$HOME/.config/beitibao/bailian.env" eval/moex-2020-pilot/run.mjs "${@:2}"
  node eval/moex-2020-pilot/score.mjs "$2" --require-95
else
  npm run coverage
fi
