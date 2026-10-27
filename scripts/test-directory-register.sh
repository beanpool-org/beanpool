#!/bin/bash
# test-directory-register.sh — the public directory's own tests (front doors S13): the directory-register Edge
# Function's rules (supabase/functions/directory-register/rules.ts) and the directory_listed view and 30-day purge, read
# from their SQL (supabase/migrations/2026102800_directory_listed.sql, 2026102801_directory_purge.sql).
#
# WHY A SCRIPT. rules.ts is TypeScript, so the tests load it through tsx. test-all.sh's own harness
# (scripts/test-all-continue.sh, run by the merge gate) copies test-all.sh into an empty directory with no node_modules
# and stubs every scripts/*.sh it names; a `node --import tsx` written in test-all.sh itself fails there. Behind this
# file it is stubbed like every other check.
#
#   bash scripts/test-directory-register.sh
cd "$(dirname "$0")/.." || exit 1
exec node --import tsx --test scripts/directory-register-rules.test.mjs scripts/directory-listed-migration.test.mjs
