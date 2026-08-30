/**
 * Account briefing
 *
 * "What needs me" for every character, not just the one you are logged into.
 *
 * The engine in `briefing/briefing-lines.js` turns facts into lines and knows
 * nothing about where the facts came from, so it runs just as well over a
 * snapshot taken at a character switch as over the live game. What it cannot do
 * is know that the snapshot is old — it is handed a clock and it believes it.
 * Deciding what an old line is still allowed to claim is this module's whole
 * job, and it is pure so that the decisions can be tested without a panel.
 *
 * ## The two kinds of line, and what age does to each
 *
 * A **deadline** carries a `horizon` (see the engine's module note): the
 * absolute instant its claim comes due. Replaying it is only honest if the
 * countdown inside it is thrown away, because "dry in 3h" recorded five hours
 * ago is not a smaller number, it is a false one. So a surviving deadline is
 * restated against the absolute instant it named — "Ale runs dry at 14:20" —
 * and never against a countdown. Past that instant it is gone, unless the
 * instant only made it worse (`lapses: false`), in which case what is left is
 * the matured claim with no time in it at all.
 *
 * A **reading** — a full task board, filled listings, entries banked — has no
 * horizon, because nothing about the clock makes it false. It is shown as it
 * was recorded, with the age of the recording beside it, and dimmed once that
 * age is past a day. It is never recomputed: `account-data.js`'s note applies
 * in full, and every figure here is the snapshot's own.
 *
 * ## The character you are logged into
 *
 * Comes from the live briefing path, not from its own stale record — there is
 * no reason to read yesterday's answer about the character the game is telling
 * us about right now. It is narrowed to the same subjects a snapshot can carry,
 * so that the section compares like with like: five characters answering seven
 * questions, one of them answering from the game and four from memory.
 */

import { buildBriefingLines } from '../briefing/briefing-lines.js';
import { SNAPSHOT_FACT_KEYS } from '../briefing/briefing-snapshot-store.js';

/** Past this, what a line reports is old enough to be shown quietly */
export const DIM_AFTER_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * An instant, worded absolutely.
 *
 * The point of it is to be the one thing a stale line can still say truthfully,
 * so it must not be a duration in any form. A day out or more it takes the
 * weekday too, because a bare clock time then means the wrong day.
 *
 * @param {number} at - Epoch ms
 * @param {number} now - Epoch ms
 * @returns {string} e.g. `14:20`, or `Thu 14:20`
 */
export function absoluteTime(at, now) {
    const date = new Date(at);
    const clock = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if (at - now < DAY_MS) return clock;
    return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${clock}`;
}

/**
 * Lines from a snapshot, as they may honestly be shown now.
 *
 * @param {Array<Object>} lines - From `buildBriefingLines`, built against `snapshotAt`
 * @param {number} snapshotAt - When the facts behind them were read
 * @param {number} [now] - Clock, injectable for tests
 * @returns {Array<Object>} The survivors, each with `ageMs` and `dim`
 */
export function ageBriefingLines(lines, snapshotAt, now = Date.now()) {
    // Clamped: a snapshot from the future is a clock that moved, not a line
    // that is minus two hours old
    const ageMs = Math.max(0, now - snapshotAt);
    const dim = ageMs > DIM_AFTER_MS;
    const aged = [];

    for (const line of lines || []) {
        if (!line) continue;
        const horizon = line.horizon;

        if (!horizon || !Number.isFinite(horizon.at)) {
            // A reading: nothing about the clock makes it false
            aged.push({ ...line, ageMs, dim });
            continue;
        }

        if (now < horizon.at) {
            aged.push({ ...line, value: `${horizon.text} at ${absoluteTime(horizon.at, now)}`, ageMs, dim });
            continue;
        }

        // The instant has passed. Either the claim went with it, or the instant
        // was the claim getting worse and the wording it matures into is all
        // that is left — with no time in it, because there is no live one
        if (horizon.lapses === false) aged.push({ ...line, value: horizon.text, ageMs, dim });
    }

    return aged;
}

/**
 * Only the subjects a snapshot can carry.
 *
 * Applied to the live facts as well, so the current character is asked the same
 * questions as the others rather than a longer list that makes it look like the
 * only one with anything wrong.
 *
 * @param {Object} facts - Any fact bag
 * @returns {Object} The same bag, narrowed
 */
export function snapshotSubjects(facts) {
    const narrowed = {};
    for (const key of SNAPSHOT_FACT_KEYS) {
        if (facts?.[key] !== undefined) narrowed[key] = facts[key];
    }
    return narrowed;
}

/**
 * What one stored snapshot still has to say.
 *
 * @param {Object|null} snapshot - A `briefingSnapshot_<id>` value
 * @param {number} [now] - Clock, injectable for tests
 * @returns {{at: number, lines: Array<Object>}|null} Null when there is no snapshot to read
 */
export function briefingFromSnapshot(snapshot, now = Date.now()) {
    if (!snapshot || !Number.isFinite(snapshot.at)) return null;
    // Built against the snapshot's own clock, so every duration in every line is
    // the one that was measured — the ageing above is the only thing that gets
    // to reason about the difference between then and now
    const lines = buildBriefingLines(snapshotSubjects(snapshot.facts), snapshot.at);
    return { at: snapshot.at, lines: ageBriefingLines(lines, snapshot.at, now) };
}

/**
 * What the live game has to say about the character you are logged into.
 *
 * @param {Object} facts - From `collectFacts()`
 * @param {number} [now] - Clock, injectable for tests
 * @returns {{at: number, lines: Array<Object>}} Lines with no age and no dimming
 */
export function briefingFromLiveFacts(facts, now = Date.now()) {
    const lines = buildBriefingLines(snapshotSubjects(facts), now);
    return { at: now, lines: lines.map((line) => ({ ...line, ageMs: 0, dim: false })) };
}

/**
 * How bad a line is, worst first.
 *
 * One explicit list, in one place, and the whole of the ranking. Deliberately
 * not a weighted score: a score is unarguable in the wrong way — nobody can look
 * at 0.62 and say whether it is right, two subjects that should never tie can
 * tie by arithmetic accident, and the day somebody wants a full task board to
 * outrank a dry keg the fix is a magic number rather than moving a string up
 * this list. Four names in an order is a thing a maintainer can disagree with.
 *
 * What each one means:
 *
 * - `wasting` — a deadline that came due and did *not* take its claim with it
 *   (`lapses: false`). The thing it warned about is happening now and is still
 *   getting worse: a full task board past its first wasted task.
 * - `lapsed-deadline` — the engine's own already-happened wording, which it
 *   reaches for when a countdown has nothing left to count: "Ale has run out",
 *   "Full — tasks are being wasted", entries "capped". A bad-toned line with no
 *   deadline left in it. The loss has happened; unlike `wasting` there is no
 *   claim that it is still deepening.
 * - `deadline-soon` — a horizon still ahead. Something is coming due and there
 *   is time to get there.
 * - `reading` — a state with no clock in it at all: tasks waiting, listings
 *   undercut, a run half-finished.
 */
export const ATTENTION_SEVERITY = ['wasting', 'lapsed-deadline', 'deadline-soon', 'reading'];

/**
 * Which of {@link ATTENTION_SEVERITY} a line is.
 *
 * Reads the line's horizon and the engine's own tone, and never its text: the
 * wording is the engine's to change, and a ranker that matched on "wasted" would
 * be a rename away from silently demoting the worst line on the panel.
 *
 * @param {Object} line - From `ageBriefingLines` or `briefingFromLiveFacts`
 * @param {number} [now] - Clock, injectable for tests
 * @returns {string} One of {@link ATTENTION_SEVERITY}
 */
export function lineSeverity(line, now = Date.now()) {
    const horizon = line?.horizon;
    const dated = horizon && Number.isFinite(horizon.at);

    if (dated && horizon.lapses === false && horizon.at <= now) return 'wasting';
    if (dated && horizon.at > now) return 'deadline-soon';
    // A lapsing horizon that has passed does not reach a reader — `ageBriefingLines`
    // drops it — so what is left here is the line the engine built already worded
    // in the past, and it is bad-toned precisely because it has already cost
    // something
    if (line?.tone === 'bad') return 'lapsed-deadline';
    return 'reading';
}

/**
 * The worst line among a character's, and how bad it is.
 *
 * Ties inside one character go to whichever the engine put first, because the
 * engine's order is its own reading order and there is nothing better to break
 * a tie with.
 *
 * @param {Array<Object>} lines - One character's lines
 * @param {number} [now] - Clock, injectable for tests
 * @returns {{line: Object, severity: string, rank: number}|null} Null when there are no lines
 */
export function worstLine(lines, now = Date.now()) {
    let worst = null;
    for (const line of lines || []) {
        const severity = lineSeverity(line, now);
        const rank = ATTENTION_SEVERITY.indexOf(severity);
        if (!worst || rank < worst.rank) worst = { line, severity, rank };
    }
    return worst;
}

/**
 * The "Next:" line: who to look at, and why.
 *
 * The current character is excluded on purpose — you are already there, and
 * being told to go where you are standing is the fastest way to stop reading a
 * header.
 *
 * @param {Object|null} entry - A ranked entry, from {@link rankAttention}
 * @returns {string|null} The header text, or null when there is nobody to name
 */
export function nextAttentionText(entry) {
    if (!entry?.worst) return null;
    return `Next: ${entry.name} — ${entry.worst.line.label}: ${entry.worst.line.value}`;
}

/**
 * The section's three groups, and who to look at next.
 *
 * The three-state honesty of `accountBriefings` is carried through unchanged:
 * `busy` has something to say, `quiet` has been looked at and had nothing, and
 * `unknown` has never been looked at. `unknown` is never sorted among the
 * others, because a character with no record is not a character with no
 * problems, and putting it anywhere in a list ordered by severity would be
 * claiming a severity for it.
 *
 * Busy characters are ordered by their worst line's severity, and ties by the
 * older snapshot first: between two characters equally badly off, the one whose
 * information is older is the one you know least about and have been ignoring
 * longest.
 *
 * @param {Array<Object>} entries - From {@link accountBriefings}
 * @param {number} [now] - Clock, injectable for tests
 * @returns {{busy: Array<Object>, quiet: Array<Object>, unknown: Array<Object>, next: Object|null}} The section
 */
export function rankAttention(entries, now = Date.now()) {
    const all = entries || [];

    const busy = all
        .filter((entry) => entry?.lines?.length > 0)
        .map((entry) => ({ ...entry, worst: worstLine(entry.lines, now) }))
        .sort((a, b) => {
            if (a.worst.rank !== b.worst.rank) return a.worst.rank - b.worst.rank;
            // A live entry's `at` is `now`, so the character you are logged into
            // sorts last among its ties — which is right: it is the one you are
            // looking at
            return (a.at ?? Infinity) - (b.at ?? Infinity);
        });

    return {
        busy,
        quiet: all.filter((entry) => entry?.known && entry.lines.length === 0),
        unknown: all.filter((entry) => entry && !entry.known),
        next: busy.find((entry) => !entry.isCurrent) || null,
    };
}

/**
 * One entry per character, in the order the account panel already sorts them.
 *
 * Three outcomes, and they are three different things: a character with lines,
 * a character we have looked at and found nothing for, and a character we have
 * never looked at. The last is not "nothing needs it" and the panel must not
 * round it to that.
 *
 * @param {Object} input - Everything gathered
 * @param {Array<Object>} input.characters - Rows from `summarizeCharacters`
 * @param {Object<string, Object>} input.snapshots - Character id → stored snapshot
 * @param {Object|null} [input.liveFacts] - `collectFacts()` for the current character, when it can be read
 * @param {number} [input.now] - Clock, injectable for tests
 * @returns {Array<{id: string, name: string, isCurrent: boolean, at: number|null, known: boolean,
 *   lines: Array<Object>}>} One per character
 */
export function accountBriefings({ characters, snapshots, liveFacts = null, now = Date.now() }) {
    return (characters || []).map((character) => {
        const briefing =
            character.isCurrent && liveFacts
                ? briefingFromLiveFacts(liveFacts, now)
                : briefingFromSnapshot(snapshots?.[character.id], now);

        return {
            id: character.id,
            name: character.name,
            isCurrent: Boolean(character.isCurrent),
            at: briefing ? briefing.at : null,
            known: Boolean(briefing),
            lines: briefing ? briefing.lines : [],
        };
    });
}
