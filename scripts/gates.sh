#!/usr/bin/env bash
# The full pre-push gate, so a push never learns something from CI that it
# could have learned here.
#
# Covers every step of .github/workflows/ci.yml: ESLint, Prettier with CI's
# own globs (not `prettier --check .`, which also flags files CI ignores), the
# production build with its bundle-sharing and load-order checks, the 2 MiB
# @require ceiling (warning past 98%), the test suite, the dev build, the
# split-bundle smoke test and the production-vs-dev value parity check. The
# build and the ceiling run before the suite so a size failure comes first.
#
# Prettier is here because agent commits skip the pre-commit hook by design
# (--no-verify), so their files reach main unformatted and CI rejects the
# push. Run from anywhere: `bash scripts/gates.sh`.
set -euo pipefail
cd "$(dirname "$0")/.."

# While this runs, switching branches here would gate a mix of two branches and build the wrong dev
# file. The lock in this checkout's own git dir lets the session's guard refuse a switch (2026-11-11).
GATES_LOCK="$(git rev-parse --absolute-git-dir)/gates-running"
date +%s >"$GATES_LOCK"
trap 'rm -f "$GATES_LOCK"' EXIT

step() { printf '\n== %s ==\n' "$1"; }

step 'ESLint'
npx eslint src/

step 'Prettier (CI globs)'
npx prettier --check "src/**/*.js" "*.config.js" "**/*.md"

# The production build and the size ceiling go first: an over-limit stack then fails in about a minute,
# not after the full test suite (2026-11-11, a six-PR landing failed on size at the very end)
step 'Build: production (includes bundle-sharing check)'
BUILD_MODE=production npx rollup -c 2>&1 | tail -1
node scripts/check-bundle-sharing.mjs
node scripts/check-bundle-load-order.mjs

step 'Bundle sizes (2097152-byte @require ceiling)'
limit=2097152
# Past 98% a bundle is one feature from blocking a landing: say so on every run, before it does
warn=$((limit * 98 / 100))
for file in dist/Toolasha.user.js dist/libraries/*.js; do
    size=$(wc -c <"$file")
    if [ "$size" -gt "$limit" ]; then
        echo "FAIL $file is over the limit ($size bytes)"
        exit 1
    fi
    if [ "$size" -gt "$warn" ]; then
        echo "WARN $file is at $((size * 100 / limit))% of the limit ($size bytes, $((limit - size)) left): move a module out before it blocks a landing"
    else
        echo "ok   $file ($size bytes)"
    fi
done

step 'Tests'
# Only the failures and the summary. A bare `tail` lost both once Vitest began
# ending its output with an isolate hint: a failed run showed nothing to act on.
# The filter's exit status is ignored and Vitest's own is kept, so a failure still stops the gates.
tests_log=$(mktemp)
set +e
node_modules/.bin/vitest run >"$tests_log" 2>&1
tests_status=$?
set -e
grep -E '^ *(FAIL|×) |^ *(Test Files|Tests) ' "$tests_log" || true
if [ "$tests_status" -ne 0 ]; then
    echo "Tests failed (exit $tests_status); full log: $tests_log"
    exit "$tests_status"
fi
rm -f "$tests_log"

step 'Build: dev standalone'
BUILD_TARGET=dev-standalone npx rollup -c 2>&1 | tail -1

step 'Split-bundle smoke test (load order, namespaces, bridge identity, no stray singleton copies)'
node scripts/check-bundle-smoke.mjs --require-build

step 'Production-vs-dev value parity (golden values through the published namespaces of both builds)'
node scripts/check-bundle-parity.mjs --require-build

step '@require URLs (classic scripts, not ES modules)'
node scripts/check-require-urls.mjs

printf '\nAll gates passed.\n'
