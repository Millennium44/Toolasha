#!/usr/bin/env bash
# Build a branch (or any ref) into the dev build the maintainer's dev loader serves, without touching the main
# checkout's branch: check it out detached in ../Toolasha-integ, run build:dev there, copy the file into this
# checkout's dist/. Then reload the game tab until window.Toolasha.buildStamp matches the stamp printed here.
#
#   bash scripts/dev-load-branch.sh feat/some-branch
#   bash scripts/dev-load-branch.sh origin/main
set -euo pipefail

ref="${1:?usage: dev-load-branch.sh <branch-or-ref>}"
here="$(cd "$(dirname "$0")/.." && pwd)"
integ="$here/../Toolasha-integ"

[ -d "$integ" ] || { echo "No ../Toolasha-integ worktree; create it with git worktree add." >&2; exit 1; }
if [ -e "$(git -C "$integ" rev-parse --git-dir)/gates-running" ]; then
    echo "gates.sh is running in ../Toolasha-integ; wait for it to finish." >&2
    exit 1
fi

git -C "$integ" fetch -q origin
git -C "$integ" checkout -q --detach "$ref"
(cd "$integ" && npm run -s build:dev)
cp "$integ/dist/Toolasha-dev.user.js" "$here/dist/Toolasha-dev.user.js"

echo "Dev build from: $(git -C "$integ" log --oneline -1)"
grep -aoE "buildStamp = '[^']+'" "$here/dist/Toolasha-dev.user.js"
echo "Reload the game tab until window.Toolasha.buildStamp matches (usually the second load)."
