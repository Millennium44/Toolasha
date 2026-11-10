#!/usr/bin/env bash
# Land a stack of already-reviewed PRs onto main (maintainer's session only).
#
#   bash scripts/land-stack.sh [--push] <pr> [<pr> ...]      (argument order = landing order)
#
# Works in the integration worktree ../Toolasha-integ (next to the main checkout), so the main
# checkout and its dev build stay untouched. Without --push it stops after the full gates and prints
# the plan. With --push it re-checks that nothing moved, then pushes everything in ONE atomic push:
# each PR branch is force-with-lease'd from its old head to its stacked commit, then main to the top,
# so GitHub marks every PR merged.
#
# Worst failure to avoid: pushing something that did not pass the gates, or overwriting a PR branch
# someone else moved. Refusing too often is the mild failure; every check below errs toward refusing.
set -euo pipefail

PUSH=0
PRS=()
for arg in "$@"; do
    case "$arg" in
        --push) PUSH=1 ;;
        -h | --help) PRS=(); break ;;
        '' | *[!0-9]*) echo "Not a PR number: $arg" >&2; exit 2 ;;
        *) PRS+=("$arg") ;;
    esac
done
if [ "${#PRS[@]}" -eq 0 ]; then
    echo "Usage: bash scripts/land-stack.sh [--push] <pr> [<pr> ...]"
    echo "  Order of the PR numbers is the landing order. Without --push, stops after gates and prints the plan."
    exit 2
fi

die() { echo "FAIL: $*" >&2; exit 1; }
note() { echo "==> $*"; }

# Main repo root even when run from a linked worktree (the common git dir is <root>/.git).
COMMON_DIR="$(cd "$(git rev-parse --git-common-dir)" && pwd)"
ROOT="$(dirname "$COMMON_DIR")"
INTEG="$(dirname "$ROOT")/Toolasha-integ"
REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
OWNER="${REPO%%/*}"
NAME="${REPO##*/}"

# Per-PR state, indexed by PR number.
declare -A HEAD_SHA BRANCH STACKED_SHA PRE_SHA ENTRIES

# Stable patch id of a diff between two commits, ignoring the given pathspec excludes. Position-independent,
# so a patch that moved to a different line (main moved) still compares equal. Run inside a checkout.
patch_id() { # <from> <to> [excluded path ...]
    local from="$1" to="$2"
    shift 2
    local spec=('.') p
    for p in "$@"; do spec+=(":!$p"); done
    git diff --no-color "$from" "$to" -- "${spec[@]}" | git patch-id --stable | cut -d' ' -f1
}

# --- integration worktree -------------------------------------------------------------------------
setup_worktree() {
    if [ ! -d "$INTEG" ]; then
        note "Creating integration worktree $INTEG"
        git -C "$ROOT" worktree add --detach "$INTEG" origin/main
        die "Integration worktree created. Run 'npm ci' in $INTEG, then run this script again."
    fi
    [ -d "$INTEG/node_modules" ] || die "$INTEG has no node_modules. Run 'npm ci' there, then run this script again."
    [ -z "$(git -C "$INTEG" status --porcelain)" ] || die "$INTEG has uncommitted changes; clean it first."
}

# --- a. PR state ------------------------------------------------------------------------------------
check_pr_state() { # <pr>
    local n="$1" info state base oid ref cross
    info="$(gh pr view "$n" --json state,baseRefName,headRefOid,headRefName,isCrossRepository \
        --jq '[.state,.baseRefName,.headRefOid,.headRefName,.isCrossRepository]|@tsv')"
    IFS=$'\t' read -r state base oid ref cross <<<"$info"
    [ "$state" = "OPEN" ] || die "PR #$n is $state, not OPEN"
    [ "$base" = "main" ] || die "PR #$n targets $base, not main"
    [ "$cross" = "false" ] || die "PR #$n is from a fork; refusing (cannot push its branch)"
    HEAD_SHA[$n]="$oid"
    BRANCH[$n]="$ref"
    git -C "$INTEG" fetch -q origin "+pull/$n/head:refs/pr/$n"
    [ "$(git -C "$INTEG" rev-parse "refs/pr/$n")" = "$oid" ] || die "PR #$n head moved while fetching; retry"
    [ -z "$(git -C "$INTEG" rev-list --merges "origin/main..refs/pr/$n")" ] || die "PR #$n contains merge commits"
}

# --- b. CI ------------------------------------------------------------------------------------------
check_ci() { # <pr>
    local n="$1" rc=0
    gh pr checks "$n" >/dev/null 2>&1 || rc=$? # 0 all pass or skipped, 8 pending, 1 failing
    case "$rc" in
        0) echo "PR #$n: CI green" ;;
        8) die "PR #$n: CI checks still pending" ;;
        *) die "PR #$n: CI checks failing (or none reported); see 'gh pr checks $n'" ;;
    esac
}

# --- c. Codex review --------------------------------------------------------------------------------
# Prints "<reviewed sha> clean|unresolved" from Codex's latest summary comment; fails if there is none.
codex_review_state() { # <pr>
    gh api "repos/$REPO/issues/$1/comments" --paginate \
        --jq '.[] | select(.user.login|test("^chatgpt-codex-connector")) | .body' |
        node -e '
const body = require("fs").readFileSync(0, "utf8");
const found = [...body.matchAll(/codex-review-state:v1\s*(\{[^\n]*\})/g)];
if (!found.length) process.exit(3);
const s = JSON.parse(found[found.length - 1][1]);
const sha = s.code_review && s.code_review.commit_sha;
if (!sha) process.exit(3);
// The flag lives inside code_review; a missing flag counts as unresolved so the check refuses rather than passes.
console.log(sha + " " + (s.code_review.has_unresolved_findings === false ? "clean" : "unresolved"));
'
}

unresolved_threads() { # <pr>
    gh api graphql -F owner="$OWNER" -F name="$NAME" -F number="$1" -f query='
query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
reviewThreads(first:100){totalCount nodes{isResolved}}}}}' \
        --jq '[.data.repository.pullRequest.reviewThreads.nodes[]|select(.isResolved|not)]|length'
}

check_codex() { # <pr>
    local n="$1" line sha flag threads head="${HEAD_SHA[$n]}"
    line="$(codex_review_state "$n")" || die "PR #$n: no Codex review summary (codex-review-state:v1) found"
    sha="${line%% *}"
    flag="${line##* }"
    threads="$(unresolved_threads "$n")"
    [ "$threads" = "0" ] || die "PR #$n: $threads unresolved review thread(s)"
    [ "$flag" = "clean" ] || die "PR #$n: Codex reports unresolved findings"
    if [ "$sha" = "$head" ]; then
        echo "PR #$n: Codex reviewed the head ($sha); no unresolved threads"
        return
    fi
    # Reviewed a different commit: pass only if the patch is unchanged apart from changelog / bundle-sharing hunks.
    git -C "$INTEG" cat-file -e "$sha^{commit}" 2>/dev/null || git -C "$INTEG" fetch -q origin "$sha" 2>/dev/null ||
        die "PR #$n: Codex reviewed $sha, which is not fetchable, and the head is $head"
    local mb_r mb_h a b
    mb_r="$(git -C "$INTEG" merge-base origin/main "$sha")" || die "PR #$n: reviewed commit $sha has no merge-base with main"
    mb_h="$(git -C "$INTEG" merge-base origin/main "$head")"
    a="$(cd "$INTEG" && patch_id "$mb_r" "$sha" CHANGELOG.md scripts/check-bundle-sharing.mjs)"
    b="$(cd "$INTEG" && patch_id "$mb_h" "$head" CHANGELOG.md scripts/check-bundle-sharing.mjs)"
    [ "$a" = "$b" ] || die "PR #$n: Codex reviewed $sha, head is $head, and the patches differ beyond CHANGELOG.md / check-bundle-sharing.mjs"
    echo "PR #$n: Codex reviewed $sha, head is $head; review carries over (patch identical outside changelog/bundle-sharing); no unresolved threads"
}

# --- d. cherry-pick ---------------------------------------------------------------------------------
# Resolve a CHANGELOG.md-only conflict: keep both sides, incoming entry on top.
resolve_changelog_conflict() {
    node -e '
const fs = require("fs");
const t = fs.readFileSync("CHANGELOG.md", "utf8");
const out = t.replace(/<<<<<<< [^\n]*\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> [^\n]*\n/g,
    (_, ours, theirs) => theirs.replace(/\n*$/, "\n\n") + ours);
fs.writeFileSync("CHANGELOG.md", out);
'
}

pick_commit() { # <commit>
    if HUSKY=0 git cherry-pick "$1" >/dev/null 2>&1; then return; fi
    local files
    files="$(git diff --name-only --diff-filter=U)"
    if [ "$files" = "CHANGELOG.md" ]; then
        resolve_changelog_conflict
        git add CHANGELOG.md
        HUSKY=0 git -c core.editor=true cherry-pick --continue >/dev/null || die "cherry-pick --continue failed for $1"
        return
    fi
    git cherry-pick --abort 2>/dev/null || true
    die "cherry-pick of $1 conflicts in: ${files:-<unknown>}"
}

stack_prs() {
    cd "$INTEG"
    git checkout -q --detach origin/main
    local n mb c commits last
    for n in "${PRS[@]}"; do
        mb="$(git merge-base origin/main "refs/pr/$n")"
        PRE_SHA[$n]="$(git rev-parse HEAD)"
        commits="$(git rev-list --reverse "$mb..refs/pr/$n")"
        [ -n "$commits" ] || die "PR #$n has no commits beyond main"
        for c in $commits; do pick_commit "$c"; done
        STACKED_SHA[$n]="$(git rev-parse HEAD)"
        ENTRIES[$n]="$(git diff "$mb" "refs/pr/$n" -- CHANGELOG.md | grep -c '^+### ' || true)"
        echo "PR #$n stacked: ${PRE_SHA[$n]:0:9} -> ${STACKED_SHA[$n]:0:9}"
    done
    # Union merges drop the blank line between entries; prettier restores it.
    npx --no-install prettier --write CHANGELOG.md >/dev/null
    if ! git diff --quiet; then
        note "Prettier changed CHANGELOG.md; amending it into the last commit"
        git add CHANGELOG.md
        HUSKY=0 git commit -q --amend --no-edit --no-verify
        last="${PRS[${#PRS[@]} - 1]}"
        STACKED_SHA[$last]="$(git rev-parse HEAD)"
    fi
}

# --- e. patch identity ------------------------------------------------------------------------------
check_patch_identity() {
    local n mb a b
    for n in "${PRS[@]}"; do
        mb="$(git merge-base origin/main "refs/pr/$n")"
        a="$(patch_id "$mb" "refs/pr/$n" CHANGELOG.md)"
        b="$(patch_id "${PRE_SHA[$n]}" "${STACKED_SHA[$n]}" CHANGELOG.md)"
        [ "$a" = "$b" ] || die "PR #$n: stacked patch differs from the PR head's patch outside CHANGELOG.md"
        echo "PR #$n: stacked patch identical to head patch outside CHANGELOG.md"
    done
}

# --- f. markers and entry count ---------------------------------------------------------------------
count_entries() { # <rev>
    # Read to the end: an early awk exit closes the pipe, and with pipefail the SIGPIPE'd git show kills the script.
    git show "$1:CHANGELOG.md" | awk '/^## Unreleased/{u=1;next} u&&/^## /{u=0} u&&/^### /{c++} END{print c+0}'
}

check_changelog() {
    if git grep -nE '^(<<<<<<<|>>>>>>>) ' HEAD -- . >/dev/null 2>&1; then
        die "conflict markers found in the stacked tree"
    fi
    local before after expected=0 n
    before="$(count_entries origin/main)"
    after="$(count_entries HEAD)"
    for n in "${PRS[@]}"; do expected=$((expected + ENTRIES[$n])); done
    [ "$after" -eq $((before + expected)) ] ||
        die "Unreleased entries: $before on main + $expected from PRs, but the stack has $after (inspect: grep -n -B1 '^### ' CHANGELOG.md)"
    echo "CHANGELOG.md: $before -> $after entries (+$expected), no conflict markers"
}

# --- g. full checks ---------------------------------------------------------------------------------
run_full_checks() {
    local log
    log="$(mktemp -d)/land-stack-checks.log"
    note "Running the full checks script (log: $log)"
    bash "scripts/gates.sh" >"$log" 2>&1 || { tail -30 "$log" >&2; die "gates failed; full log: $log"; }
    grep -q '^All gates passed\.' "$log" || { tail -30 "$log" >&2; die "gates did not report 'All gates passed.'; log: $log"; }
    echo "All gates passed. (log: $log)"
}

# --- h. plan / push ---------------------------------------------------------------------------------
print_plan() {
    local n
    echo
    note "Plan"
    for n in "${PRS[@]}"; do
        echo "  PR #$n  ${BRANCH[$n]}: ${HEAD_SHA[$n]:0:9} -> ${STACKED_SHA[$n]:0:9}"
    done
    echo "  main: ${MAIN_OLD:0:9} -> ${TOP:0:9}"
}

push_all() {
    local n now rb
    git fetch -q origin
    [ "$(git rev-parse origin/main)" = "$MAIN_OLD" ] || die "origin/main moved since the stack was built; rerun"
    for n in "${PRS[@]}"; do
        now="$(git ls-remote origin "refs/pull/$n/head" | cut -f1)"
        [ "$now" = "${HEAD_SHA[$n]}" ] || die "PR #$n head moved since the stack was built; rerun"
        rb="$(git ls-remote origin "refs/heads/${BRANCH[$n]}" | cut -f1)"
        [ "$rb" = "${HEAD_SHA[$n]}" ] || die "branch ${BRANCH[$n]} is at ${rb:-<missing>}, not the PR head; rerun"
    done
    local args=(--atomic origin)
    for n in "${PRS[@]}"; do
        args+=("--force-with-lease=refs/heads/${BRANCH[$n]}:${HEAD_SHA[$n]}")
    done
    args+=("--force-with-lease=refs/heads/main:$MAIN_OLD")
    for n in "${PRS[@]}"; do args+=("${STACKED_SHA[$n]}:refs/heads/${BRANCH[$n]}"); done
    args+=("$TOP:refs/heads/main")
    note "Pushing (atomic)"
    git push "${args[@]}"
    for n in "${PRS[@]}"; do
        echo "  PR #$n: $(gh pr view "$n" --json state --jq .state)"
    done
}

# --- main -------------------------------------------------------------------------------------------
setup_worktree
git -C "$INTEG" fetch -q origin
MAIN_OLD="$(git -C "$INTEG" rev-parse origin/main)"
for n in "${PRS[@]}"; do check_pr_state "$n"; done
for n in "${PRS[@]}"; do check_ci "$n"; done
for n in "${PRS[@]}"; do check_codex "$n"; done
stack_prs
TOP="$(git rev-parse HEAD)"
check_patch_identity
check_changelog
run_full_checks
print_plan
if [ "$PUSH" -eq 1 ]; then
    push_all
else
    echo
    echo "Dry run complete; re-run with --push to land."
fi
