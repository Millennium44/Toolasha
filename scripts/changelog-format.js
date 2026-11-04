/**
 * The shape a fork-changelog entry must have, checked for the part of the file
 * the in-game What's New panel draws.
 *
 * The panel renders the fork section of `CHANGELOG.md` and splits it on `###`
 * titles (`whats-new.js`), and the run-time filter counts `###` lines as
 * entries (`changelog-markers.js`). A release written as flat `- ` bullets with
 * no title therefore reads as "zero entries": the filter could not tell what was
 * new, and the panel showed a player the whole recent history. Paragraph-sized
 * entries are the other way it goes wrong - nobody reads them in a popup.
 *
 * So every entry is a `### Title` plus one or two sentences (or a few terse
 * bullets under that title). This module is the rule, so `changelog-format.test.js`
 * can hold every contributor to it through the normal suite.
 */

/**
 * The newest release whose entries are NOT checked.
 *
 * Everything from the `## Unreleased` heading down to this release's
 * `<!-- shipped in x.y.z -->` marker is held to the format; this marker and
 * everything below it is grandfathered. The older entries predate the rule -
 * some are paragraphs, some share a title with a later one - and rewriting
 * hundreds of shipped entries would change history for no player's benefit.
 * Moving the boundary up (to a newer release) later is a one-line change here.
 */
export const GRANDFATHERED_FROM_RELEASE = '3.73.0';

/** An entry's body (everything under its title) may not run past this. */
export const MAX_BODY_CHARS = 600;

const MARKER_RE = /^<!--\s*shipped in\s+(\d+(?:\.\d+)*)\s*-->\s*$/;

/** The advice every failure ends with. */
export const FIX_HINT =
    'Add a `### Title` and a sentence or two (or a few terse bullets under it). ' +
    'Tooling, tests and contributor process belong in the commit message, not here.';

/**
 * Find the lines the rule applies to.
 * @param {string} changelog - The whole `CHANGELOG.md`
 * @returns {{start: number, end: number, lines: Array<string>}|null} Line range, or null when it cannot be found
 */
function checkedRange(changelog) {
    const lines = String(changelog ?? '').split('\n');
    const start = lines.findIndex((line) => /^## Unreleased/.test(line));
    if (start === -1) return null;
    const end = lines.findIndex((line, i) => {
        if (i <= start) return false;
        const match = MARKER_RE.exec(line);
        return match !== null && match[1] === GRANDFATHERED_FROM_RELEASE;
    });
    if (end === -1) return null;
    return { start, end, lines };
}

/**
 * Check the unreleased part of the changelog against the entry format.
 * @param {string} changelog - The whole `CHANGELOG.md`
 * @returns {Array<string>} One message per problem, each with its 1-based line; empty when the format holds
 */
export function checkChangelogFormat(changelog) {
    const range = checkedRange(changelog);
    if (!range) {
        return [
            `Could not find "## Unreleased" followed by "<!-- shipped in ${GRANDFATHERED_FROM_RELEASE} -->" in CHANGELOG.md. ` +
                'If that release marker moved, update GRANDFATHERED_FROM_RELEASE in scripts/changelog-format.js.',
        ];
    }

    const problems = [];
    const seenTitles = new Map();
    let current = null; // { title, line, body: string[] }

    const closeEntry = () => {
        if (!current) return;
        const body = current.body.join('\n').trim();
        if (body === '') {
            problems.push(`line ${current.line}: "${current.title}" has no text under its title. ${FIX_HINT}`);
        } else if (body.length > MAX_BODY_CHARS) {
            problems.push(
                `line ${current.line}: "${current.title}" is ${body.length} characters long (the limit is ${MAX_BODY_CHARS}). ` +
                    'Cut it to one or two sentences; the detail belongs in the commit body.'
            );
        }
        current = null;
    };

    for (let i = range.start + 1; i < range.end; i++) {
        const line = range.lines[i];
        const lineNo = i + 1;

        if (MARKER_RE.test(line)) {
            closeEntry();
            // Titles repeat across releases by design: "Small display fixes" can ship twice
            seenTitles.clear();
            continue;
        }

        if (/^###(\s|$)/.test(line)) {
            closeEntry();
            const title = line.replace(/^###\s*/, '').trim();
            if (title === '') {
                problems.push(`line ${lineNo}: empty entry title. ${FIX_HINT}`);
            } else {
                const key = title.toLowerCase();
                if (seenTitles.has(key)) {
                    problems.push(
                        `line ${lineNo}: "${title}" repeats the title on line ${seenTitles.get(key)}. Give each entry its own title.`
                    );
                } else {
                    seenTitles.set(key, lineNo);
                }
            }
            current = { title: title || '(empty)', line: lineNo, body: [] };
            continue;
        }

        if (/^#{1,2}\s/.test(line)) {
            closeEntry();
            continue;
        }

        if (line.trim() === '') {
            current?.body.push(line);
            continue;
        }

        if (!current) {
            problems.push(`line ${lineNo}: text sits outside any entry ("${line.slice(0, 60)}"). ${FIX_HINT}`);
            continue;
        }
        current.body.push(line);
    }
    closeEntry();

    return problems;
}
