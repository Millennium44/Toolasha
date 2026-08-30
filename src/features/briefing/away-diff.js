/**
 * Since you were away
 *
 * What changed about a character between the moment you left it and the moment
 * you came back to it.
 *
 * The session briefing answers "what needs me now" and the account panel answers
 * "what needs my other characters", and both are *states*. Neither can answer
 * the question a returning player actually asks, which is a difference: the ale
 * was fine when I left, is it fine now? There is exactly one pair of instants at
 * which that difference can be computed honestly — the snapshot
 * `briefing-snapshot.js` writes on `character_switching`, and the live facts
 * `session-briefing.js` collects on arrival — and this module is the subtraction
 * between them.
 *
 * ## What it is allowed to claim
 *
 * - **Only the snapshot's subjects.** `SNAPSHOT_FACT_KEYS` is the list of things
 *   both sides can answer; a live fact outside it has no earlier reading to be
 *   compared against and produces nothing.
 * - **Both sides or nothing.** A fact missing from either instant is not a
 *   change, it is an unknown. The engine's own rule, applied to a pair.
 * - **Net change only.** Two instants cannot see a round trip. A listing
 *   undercut, repriced and undercut again reads here as one listing undercut,
 *   and three tasks claimed while four arrived reads as one more waiting. Every
 *   delta below is therefore worded as a net figure and says so in its tooltip,
 *   and none of them says "happened" about anything.
 * - **Nothing at all without a snapshot.** A character that has never been
 *   switched away from here has no earlier instant, and "nothing happened while
 *   you were away" is a claim nobody is in a position to make. No snapshot, no
 *   card — not an empty card.
 *
 * ## Deadlines and readings
 *
 * The split is the engine's (see `briefing-lines.js`'s horizons), and the diff
 * uses each half differently.
 *
 * A **deadline** recorded in the snapshot is a prediction, and coming back is
 * the first chance anybody has had to see it come true. If its instant has
 * passed, the matured claim is stated against the instant it named — "Ale ran
 * dry at 14:20" — using the horizon's own past wording. If it has not passed,
 * nothing has happened yet and there is no line: a countdown that is still
 * counting is the session briefing's business, not this card's.
 *
 * A **reading** is a number on both sides, so the line is the subtraction, with
 * the age of the older side beside it.
 *
 * The task board is neither, and is diffed as a *transition*: only a board that
 * crossed into or out of being full is news, and the wording of the new state is
 * `taskSlotLine`'s, so the card and the briefing never describe the same board
 * two different ways.
 */

import storage from '../../core/storage.js';
import { buildBriefingLines, TARGETS } from './briefing-lines.js';
import { SNAPSHOT_FACT_KEYS, SNAPSHOT_STORE, readSnapshot } from './briefing-snapshot-store.js';
import { absoluteTime, snapshotSubjects } from '../account/account-briefing.js';

/** Where the "this diff has been read" mark lives, per character */
export const AWAY_DIFF_SEEN_PREFIX = 'briefingAwayDiffSeen_';

/**
 * Where one character's read-mark lives.
 * @param {string} characterId - Whose
 * @returns {string} Storage key
 */
export function awayDiffSeenKey(characterId) {
    return `${AWAY_DIFF_SEEN_PREFIX}${characterId}`;
}

/**
 * `n` of a thing, pluralised.
 * @param {number} count - How many
 * @param {string} word - The singular
 * @returns {string} e.g. `2 listings`
 */
function plural(count, word) {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * Tasks that arrived or were claimed while you were elsewhere.
 * @param {Object} sides - `{was, is}` for this subject
 * @returns {Object|null} A line body, or null
 */
function tasksReadyDiff({ was, is }) {
    const delta = Math.floor(Number(is) || 0) - Math.floor(Number(was) || 0);
    if (delta === 0) return null;
    return {
        label: 'Tasks to claim',
        value: delta > 0 ? `${delta} more waiting` : `${plural(-delta, 'task')} claimed`,
        tone: delta > 0 ? 'gold' : 'good',
        target: TARGETS.tasks,
    };
}

/**
 * The board crossing into or out of full.
 *
 * A board that was two hours from full and is now one hour from full has not
 * done anything; only the crossing is a change. The wording comes from the live
 * `taskSlotLine`, so the card says what the briefing under it says.
 *
 * @param {Object} sides - `{was, is, isLine}` for this subject
 * @returns {Object|null} A line body, or null
 */
function taskSlotsDiff({ was, is, isLine }) {
    if (!was?.ok || !is?.ok) return null;
    if (Boolean(was.isFull) === Boolean(is.isFull)) return null;

    if (is.isFull) {
        return {
            label: 'Task board',
            value: isLine?.value || 'Full — tasks are being wasted',
            tone: 'bad',
            target: TARGETS.tasks,
        };
    }
    // Out of full, and the live line may have nothing to say at all — a board
    // with hours of room is not news to the briefing, but going from full to
    // hours of room is news to this card
    return {
        label: 'Task board',
        value: isLine?.value || 'No longer full',
        tone: 'good',
        target: TARGETS.tasks,
    };
}

/**
 * The drink the snapshot was counting down, if the count reached zero.
 *
 * The one subject where the snapshot's *prediction* is the news: nobody was here
 * to watch it happen, and arriving is the first moment it can be confirmed. Not
 * yet due means nothing to report — the live briefing is still counting it down
 * correctly and would only be repeated here.
 *
 * @param {Object} sides - `{wasLine, now}` for this subject
 * @returns {Object|null} A line body, or null
 */
function consumableDiff({ wasLine, now }) {
    const horizon = wasLine?.horizon;
    if (!horizon || !Number.isFinite(horizon.at) || now < horizon.at) return null;
    return {
        label: wasLine.label,
        value: `${horizon.past || horizon.text} at ${absoluteTime(horizon.at, now)}`,
        tone: 'bad',
        target: TARGETS.consumables,
    };
}

/**
 * Listings beaten while nobody was looking.
 *
 * Only the undercut count. `filled` is a delta against the *previous session*
 * on the live side and a hardcoded zero on the snapshot side (see
 * `briefing-snapshot.js`), so subtracting them would produce a figure about the
 * reader's history dressed as a figure about the market.
 *
 * @param {Object} sides - `{was, is}` for this subject
 * @returns {Object|null} A line body, or null
 */
function listingsDiff({ was, is }) {
    const before = Number(was?.undercut);
    const after = Number(is?.undercut);
    if (!Number.isFinite(before) || !Number.isFinite(after)) return null;

    const delta = after - before;
    if (delta === 0) return null;
    const noun = Math.abs(delta) === 1 ? 'listing' : 'listings';
    return {
        label: 'Market listings',
        value: delta > 0 ? `${delta} more ${noun} undercut` : `${-delta} fewer ${noun} undercut`,
        tone: delta > 0 ? 'gold' : 'good',
        target: TARGETS.listings,
    };
}

/**
 * An enhancement run that moved.
 * @param {Object} sides - `{was, is}` for this subject
 * @returns {Object|null} A line body, or null
 */
function enhancementDiff({ was, is }) {
    if (!was?.itemName || !is?.itemName) return null;

    // A different item is a different run; there is no level delta to state and
    // pretending there is would subtract two unrelated numbers
    if (was.itemName !== is.itemName) {
        return { label: 'Enhancing', value: `Now ${is.itemName}`, tone: 'neutral', target: TARGETS.enhancement };
    }

    const before = Number(was.currentLevel) || 0;
    const after = Number(is.currentLevel) || 0;
    if (before === after) return null;
    return {
        label: 'Enhancing',
        value: `${is.itemName} +${before} → +${after}`,
        tone: after > before ? 'good' : 'bad',
        target: TARGETS.enhancement,
    };
}

/**
 * A trial signup that appeared or went away.
 * @param {Object} sides - `{was, is}` for this subject
 * @returns {Object|null} A line body, or null
 */
function guildDiff({ was, is }) {
    if (Boolean(was?.signedUp) === Boolean(is?.signedUp)) return null;
    if (is.signedUp) {
        return {
            label: 'Guild trial',
            value: `Signed up${is.trialName ? `: ${is.trialName}` : ''}`,
            tone: 'good',
            target: TARGETS.guild,
        };
    }
    return { label: 'Guild trial', value: 'No longer signed up', tone: 'gold', target: TARGETS.guild };
}

/**
 * Labyrinth entries banked or spent.
 * @param {Object} sides - `{was, is}` for this subject
 * @returns {Object|null} A line body, or null
 */
function labyrinthDiff({ was, is }) {
    if (!was?.ok || !is?.ok) return null;
    const delta = (Number(is.available) || 0) - (Number(was.available) || 0);
    if (delta === 0) return null;
    return {
        label: 'Labyrinth entries',
        value: delta > 0 ? `${delta} more banked` : `${-delta} ${-delta === 1 ? 'entry' : 'entries'} used`,
        tone: delta > 0 && is.isFull ? 'bad' : 'neutral',
        target: TARGETS.labyrinth,
    };
}

/** One differ per subject the snapshot carries */
const DIFFS = {
    tasksReady: tasksReadyDiff,
    taskSlots: taskSlotsDiff,
    consumable: consumableDiff,
    listings: listingsDiff,
    enhancement: enhancementDiff,
    guild: guildDiff,
    labyrinth: labyrinthDiff,
};

/**
 * Lines by key, so a differ can borrow the engine's own wording for its subject.
 * @param {Array<Object>} lines - From `buildBriefingLines`
 * @returns {Map<string, Object>} key → line
 */
function byKey(lines) {
    const map = new Map();
    for (const line of lines || []) map.set(line.key, line);
    return map;
}

/**
 * What changed between a stored snapshot and the live game.
 *
 * @param {Object} input - The two instants
 * @param {Object|null} input.snapshot - A `briefingSnapshot_<id>` value
 * @param {Object|null} input.liveFacts - `collectFacts()` for the arriving character
 * @param {number} [input.now] - Clock, injectable for tests
 * @returns {Array<{key: string, label: string, value: string, tone: string, target: string|null,
 *   ageMs: number, since: number}>} One line per subject that moved, in subject order
 */
export function awayDiffLines({ snapshot, liveFacts, now = Date.now() }) {
    if (!snapshot || !Number.isFinite(snapshot.at) || !liveFacts) return [];

    const was = snapshotSubjects(snapshot.facts);
    const is = snapshotSubjects(liveFacts);
    // Clamped for the same reason `ageBriefingLines` clamps: a snapshot from the
    // future is a clock that moved
    const ageMs = Math.max(0, now - snapshot.at);

    // Built against each side's own clock, so every duration inside them is the
    // one that was actually measured
    const wasLines = byKey(buildBriefingLines(was, snapshot.at));
    const isLines = byKey(buildBriefingLines(is, now));

    const lines = [];
    for (const key of SNAPSHOT_FACT_KEYS) {
        // Absent from either instant is an unknown, not a change
        if (was[key] === undefined || is[key] === undefined) continue;

        let body = null;
        try {
            body = DIFFS[key]?.({
                was: was[key],
                is: is[key],
                wasLine: wasLines.get(key),
                isLine: isLines.get(key),
                at: snapshot.at,
                now,
            });
        } catch (error) {
            // One malformed fact must not cost the other six comparisons
            console.error(`[AwayDiff] Could not compare ${key}:`, error);
        }
        if (body) lines.push({ key, ...body, ageMs, since: snapshot.at });
    }

    return lines;
}

/**
 * The diff to show on arrival, or nothing.
 *
 * Nothing means one of three different things, and all three are silence: no
 * snapshot to compare against, a snapshot whose diff has already been read, or a
 * pair of instants that differ in nothing.
 *
 * @param {string|null} characterId - The arriving character
 * @param {Object|null} liveFacts - `collectFacts()`
 * @param {number} [now] - Clock, injectable for tests
 * @returns {Promise<{at: number, lines: Array<Object>}|null>} The card's contents
 */
export async function computeAwayDiff(characterId, liveFacts, now = Date.now()) {
    if (!characterId || !liveFacts) return null;

    try {
        const snapshot = await readSnapshot(characterId);
        if (!snapshot) return null;

        const seenAt = await storage.get(awayDiffSeenKey(characterId), SNAPSHOT_STORE, null);
        if (Number.isFinite(seenAt) && seenAt >= snapshot.at) return null;

        const lines = awayDiffLines({ snapshot, liveFacts, now });
        if (lines.length === 0) return null;
        return { at: snapshot.at, lines };
    } catch (error) {
        console.error('[AwayDiff] Could not build the away diff:', error);
        return null;
    }
}

/**
 * Remember that this diff has been read.
 *
 * ## Why a mark rather than deleting the snapshot
 *
 * The obvious way to consume a snapshot is to delete it, and it is wrong here:
 * the same record is the account panel's only knowledge of this character, and
 * dismissing one card would blank a row in a different panel that never asked.
 * So what is consumed is the *diff*, recorded as the snapshot instant it was
 * computed from.
 *
 * That makes the two clearing rules fall out of one comparison. Dismissing marks
 * the current snapshot's instant, and every later read of the same snapshot is
 * silent. Switching away writes a new snapshot with a later instant, which is by
 * definition greater than the mark, so the next arrival gets its own diff
 * without anything having to be cleared.
 *
 * @param {string|null} characterId - Whose diff was read
 * @param {number} at - The snapshot instant it was computed from
 * @returns {Promise<void>}
 */
export async function markAwayDiffSeen(characterId, at) {
    if (!characterId || !Number.isFinite(at)) return;
    try {
        await storage.set(awayDiffSeenKey(characterId), at, SNAPSHOT_STORE, true);
    } catch (error) {
        console.error('[AwayDiff] Could not record that the diff was read:', error);
    }
}
