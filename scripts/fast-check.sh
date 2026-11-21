#!/usr/bin/env bash
# Prettier and ESLint on only the files HEAD changes since <base>, in seconds, before the full gates.
#
#   bash scripts/fast-check.sh [base=origin/main]
#
# Runs in the current checkout (it needs node_modules there). gate-branch.sh and land-stack.sh call it first,
# so an unformatted or lint-failing file stops the run before the suite and both builds. 2026-11-21: 20
# unformatted files on five agent port branches failed a full gates run that this catches in seconds.
set -u

base="${1:-origin/main}"
mb="$(git merge-base "$base" HEAD)" || { echo "[fast-check] no merge base with $base" >&2; exit 2; }
bin="node_modules/.bin"
[ -x "$bin/prettier" ] || { echo "[fast-check] no node_modules here ($(pwd))" >&2; exit 2; }

mapfile -t files < <(git diff --name-only --diff-filter=d "$mb"..HEAD -- '*.js' '*.mjs' '*.cjs' '*.json' '*.md')
if [ "${#files[@]}" -eq 0 ]; then
    echo "[fast-check] no formattable files changed since $base"
    exit 0
fi
mapfile -t jsfiles < <(printf '%s\n' "${files[@]}" | grep -E '\.(js|mjs|cjs)$' || true)

code=0
"$bin/prettier" --no-color --check "${files[@]}" >/tmp/fast-check-prettier.$$ 2>&1 || {
    grep -E '\[warn\]' /tmp/fast-check-prettier.$$ | grep -v 'Code style issues' >&2
    echo "[fast-check] Prettier: run prettier --write on those files and commit" >&2
    code=1
}
rm -f /tmp/fast-check-prettier.$$
if [ "${#jsfiles[@]}" -gt 0 ]; then
    "$bin/eslint" --quiet "${jsfiles[@]}" >&2 || {
        echo "[fast-check] ESLint errors above" >&2
        code=1
    }
fi
[ "$code" = 0 ] && echo "[fast-check] ${#files[@]} changed files pass Prettier and ESLint"
exit "$code"
