#!/usr/bin/env bash
# Run the full gates on one branch (or any ref) in the integration worktree, ../Toolasha-integ,
# so the main checkout and its dev build stay untouched.
#
#   bash scripts/gate-branch.sh <ref> [log-file]
#
# Fetches, checks the ref out detached in ../Toolasha-integ, runs scripts/gates.sh there with
# ALLOW_INTEGRATION=1 and exits with gates' own exit code. Piping gates into `tail` hid a failure
# once (2026-11-19: "exit 0" on a failed bundle-sharing check), so the code is kept and printed.
set -u

ref="${1:-}"
if [ -z "$ref" ]; then
    echo "usage: bash scripts/gate-branch.sh <ref> [log-file]" >&2
    exit 2
fi

repo_root="$(git rev-parse --show-toplevel)"
integ="$(dirname "$repo_root")/Toolasha-integ"
log="${2:-${TMPDIR:-/tmp}/gate-branch-$(echo "$ref" | tr '/' '-').log}"

if [ ! -d "$integ" ]; then
    echo "[gate-branch] $integ does not exist; create it with: git worktree add --detach ../Toolasha-integ origin/main" >&2
    exit 2
fi

cd "$integ" || exit 2
git fetch -q origin || exit 2
if ! git checkout -q --detach "$ref"; then
    echo "[gate-branch] could not check out $ref in $integ" >&2
    exit 2
fi
echo "[gate-branch] gating $(git log --oneline -1) in $integ; log: $log"

ALLOW_INTEGRATION=1 bash scripts/gates.sh >"$log" 2>&1
code=$?
tail -n 3 "$log"
echo "[gate-branch] gates exit code: $code"
exit "$code"
