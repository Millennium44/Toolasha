#!/usr/bin/env bash
# Move a chain of stacked PR branches onto a new base in one pass.
#
#   bash scripts/rebase-chain.sh [--from <old-base>] <onto> <bottom-branch> ... <top-branch>
#
# Branches are listed bottom to top; each must contain the one before it. The top branch is rebased with
# --update-refs, so every listed branch moves with it. After each replayed commit Prettier rewrites
# CHANGELOG.md and folds any change into that commit: the union merge driver drops the blank line between
# entries, and without this every branch's changelog fails the format check. With --from, only the commits
# above <old-base> are replayed (use it after amending the bottom branch: --from <its old tip>).
#
# Run it in a worktree with the top branch free to check out. Prints each branch's old and new tip, checks
# the chain is still nested, and checks each tip's CHANGELOG.md against Prettier. Never pushes.
set -euo pipefail

from=''
if [ "${1:-}" = '--from' ]; then from="$2"; shift 2; fi
[ $# -ge 2 ] || { echo "usage: $0 [--from <old-base>] <onto> <bottom-branch> ... <top-branch>" >&2; exit 2; }
onto="$1"; shift
branches=("$@")
top="${branches[-1]}"

[ -z "$(git status --porcelain)" ] || { echo "FAIL: working tree not clean" >&2; exit 1; }
declare -A old
for b in "${branches[@]}"; do old[$b]="$(git rev-parse --short=9 "$b")"; done
prev=''
for b in "${branches[@]}"; do
    if [ -n "$prev" ] && ! git merge-base --is-ancestor "$prev" "$b"; then
        echo "FAIL: $b does not contain $prev; list the branches bottom to top" >&2; exit 1
    fi
    prev="$b"
done

fmt='npx --no-install prettier --write CHANGELOG.md >/dev/null && git add CHANGELOG.md && (git diff --cached --quiet || git commit -q --amend --no-edit)'
git switch -q "$top"
if [ -n "$from" ]; then
    HUSKY=0 git rebase -q --update-refs --onto "$onto" "$from" -x "$fmt"
else
    HUSKY=0 git rebase -q -f --update-refs "$onto" -x "$fmt"
fi

status=0
prev="$onto"
for b in "${branches[@]}"; do
    nested='ok'
    git merge-base --is-ancestor "$prev" "$b" || { nested='NOT NESTED'; status=1; }
    if git show "$b:CHANGELOG.md" | npx --no-install prettier --check --stdin-filepath CHANGELOG.md >/dev/null 2>&1; then
        cl='changelog ok'
    else
        cl='CHANGELOG NOT FORMATTED'; status=1
    fi
    echo "$b: ${old[$b]} -> $(git rev-parse --short=9 "$b")  $nested, $cl"
    prev="$b"
done
exit $status
