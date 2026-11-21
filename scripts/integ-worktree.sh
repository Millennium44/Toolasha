#!/usr/bin/env bash
# A sibling integration worktree (../Toolasha-<name>) that can run Prettier, ESLint and vitest, and its safe removal.
#
#   bash scripts/integ-worktree.sh add <name> [<ref>=origin/main] [<branch>]   worktree + node_modules junction
#   bash scripts/integ-worktree.sh remove <name>                               unlink the junction, then remove
#
# With <branch>, the worktree is on a new branch cut from <ref>; without, it is detached. node_modules is a
# junction to the main checkout's, so nothing is installed. Hand-made integration worktrees had none twice
# (2026-11-20 ../Toolasha-1067, 2026-11-21 ../Toolasha-upstream-nov21), so Prettier and vitest ran via the main
# checkout's paths. Removal unlinks the junction first: deleting through it empties the main checkout's
# node_modules (see the node-modules-junction-wipe memory). Never remove such a worktree with rm -rf.
set -euo pipefail

cmd="${1:-}"
name="${2:-}"
[ -n "$cmd" ] && [ -n "$name" ] || {
    echo "usage: integ-worktree.sh add <name> [<ref>] [<branch>] | remove <name>" >&2
    exit 2
}
repo_root="$(git rev-parse --show-toplevel)"
parent="$(dirname "$repo_root")"
main_name="$(basename "$repo_root")"
wt="$parent/Toolasha-$name"
count() { ls "$repo_root/node_modules" | wc -l; }

case "$cmd" in
add)
    ref="${3:-origin/main}"
    branch="${4:-}"
    [ ! -e "$wt" ] || { echo "[integ-worktree] $wt already exists" >&2; exit 1; }
    [ -d "$repo_root/node_modules" ] || { echo "[integ-worktree] the main checkout has no node_modules; npm install there first" >&2; exit 1; }
    git -C "$repo_root" fetch -q origin
    if [ -n "$branch" ]; then
        git -C "$repo_root" worktree add -q "$wt" -b "$branch" "$ref"
    else
        git -C "$repo_root" worktree add -q --detach "$wt" "$ref"
    fi
    # Relative target, unquoted: cmd's mklink mis-parses quoted paths passed from Git Bash
    (cd "$wt" && cmd //c "mklink /J node_modules ..\\$main_name\\node_modules" >/dev/null)
    [ -x "$wt/node_modules/.bin/prettier" ] || { echo "[integ-worktree] junction failed in $wt" >&2; exit 1; }
    echo "[integ-worktree] $wt at $(git -C "$wt" log --oneline -1) (${branch:-detached}), node_modules linked"
    ;;
remove)
    [ -d "$wt" ] || { echo "[integ-worktree] no $wt" >&2; exit 1; }
    dirty="$(git -C "$wt" status --short --untracked-files=no)"
    [ -z "$dirty" ] || { echo "[integ-worktree] $wt has uncommitted changes:"$'\n'"$dirty" >&2; exit 1; }
    before="$(count)"
    if [ -e "$wt/node_modules" ]; then
        (cd "$wt" && cmd //c "rmdir node_modules" >/dev/null)
    fi
    [ ! -e "$wt/node_modules" ] || { echo "[integ-worktree] could not unlink $wt/node_modules; stopping" >&2; exit 1; }
    [ "$(count)" = "$before" ] || { echo "[integ-worktree] main node_modules changed ($before -> $(count)); stopping" >&2; exit 1; }
    git -C "$repo_root" worktree remove "$wt"
    echo "[integ-worktree] removed $wt (main node_modules intact: $before entries)"
    ;;
*)
    echo "usage: integ-worktree.sh add <name> [<ref>] [<branch>] | remove <name>" >&2
    exit 2
    ;;
esac
