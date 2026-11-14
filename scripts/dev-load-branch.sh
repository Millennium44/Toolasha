#!/usr/bin/env bash
# Build one ref, or a ref plus branches merged onto it, into the dev build the maintainer's dev loader serves,
# without touching the main checkout's branch. Builds in its own worktree, ../Toolasha-devload, so it never
# collides with gates or land-stack.sh running in ../Toolasha-integ. Copies the result into this checkout's dist/.
# Then reload the game tab until window.Toolasha.buildStamp matches the stamp printed here.
#
#   bash scripts/dev-load-branch.sh feat/some-branch
#   bash scripts/dev-load-branch.sh origin/main
#   bash scripts/dev-load-branch.sh origin/main origin/feat/a origin/feat/b   # main plus open PRs
#
# The first ref is the base, checked out detached; each further ref is merged onto it in order (CHANGELOG.md
# through the changelog merge driver when it is registered). A merge that conflicts stops the script and
# leaves the worktree as it was, and dist/ untouched.
set -euo pipefail

[ $# -ge 1 ] || { echo "usage: dev-load-branch.sh <base-ref> [<ref-to-merge> ...]" >&2; exit 1; }
here="$(cd "$(dirname "$0")/.." && pwd)"
work="$here/../Toolasha-devload"

if [ ! -d "$work" ]; then
    echo "Creating ../Toolasha-devload (first run; npm ci follows)."
    git -C "$here" worktree add -q --detach "$work" origin/main
fi
lock="$(git -C "$work" rev-parse --git-dir)/devload-running"
[ -e "$lock" ] && { echo "dev-load-branch.sh is already running in ../Toolasha-devload." >&2; exit 1; }
touch "$lock"
trap 'rm -f "$lock"' EXIT

[ -d "$work/node_modules" ] || (cd "$work" && npm ci --no-audit --no-fund)
# The changelog merge driver lives in the shared git config; register it if this clone lacks it
git -C "$work" config --get merge.changelog.driver >/dev/null || (cd "$work" && node scripts/setup-merge-driver.mjs)

git -C "$work" fetch -q origin
git -C "$work" reset -q --hard
git -C "$work" checkout -q --detach "$1"
shift
for ref in "$@"; do
    if ! git -C "$work" -c user.name=devload -c user.email=devload@localhost merge -q --no-edit --no-ff "$ref"; then
        git -C "$work" merge --abort || true
        echo "Merging $ref conflicts; nothing was built. Resolve it on the branch or leave it out." >&2
        exit 1
    fi
done

(cd "$work" && npm run -s build:dev)
cp "$work/dist/Toolasha-dev.user.js" "$here/dist/Toolasha-dev.user.js"

echo "Dev build from: $(git -C "$work" log --oneline -1)"
[ $# -gt 0 ] && echo "Merged: $*"
grep -aoE "buildStamp = '[^']+'" "$here/dist/Toolasha-dev.user.js"
echo "Reload the game tab until window.Toolasha.buildStamp matches (usually the second load)."
