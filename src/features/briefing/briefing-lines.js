/**
 * Session briefing lines
 *
 * "What needs me right now", as a list of lines, from a plain object of facts.
 *
 * Everything that could be interesting about a returning player is already
 * measured somewhere else in this script — the queue monitor knows the queue,
 * the task forecast knows the board, the consumable forecast knows the drinks.
 * What none of them can do is decide whether their answer is worth a line, and
 * that judgement is the whole feature: a briefing that lists every reading is
 * the overlay again, and the overlay is already there.
 *
 * So this module owns one rule per subject — the threshold below which the
 * subject is news — and nothing else. It reads no stores, touches no DOM and
 * asks no clock it was not given, which is what lets the thresholds be tested
 * without a game behind them. Collecting the facts is `session-briefing.js`'s
 * job, and drawing them is the panel's.
 *
 * A subject with nothing to say produces no line at all rather than a line
 * saying nothing. A briefing of eight "all fine" rows is a briefing nobody
 * reads the ninth time.
 *
 * ## Horizons
 *
 * Some lines are readings ("3 tasks waiting") and some are deadlines ("fills in
 * 40m"). A deadline stops being true the moment it passes, and the difference
 * only matters once a line outlives the clock it was built against — which is
 * exactly what the account view does when it replays a snapshot taken at a
 * character switch. So a deadline line additionally carries `horizon`:
 *
 *     horizon: { at: <epoch ms>, text: 'Ale runs dry', past: 'Ale ran dry', lapses: true }
 *
 * `at` is the instant the line's claim comes due, stated absolutely so it
 * survives being read at a different `now`. `text` is the same claim worded for
 * an absolute time rather than a countdown, so a reader that cannot trust its
 * countdown can say "Ale runs dry at 14:20" without unpicking `value`.
 *
 * `past` is `text` again for a reader standing on the far side of `at`. A reader
 * that knows the instant has been and gone — the away diff, which compares a
 * snapshot against the live game and can therefore *confirm* it — wants "Ale ran
 * dry at 14:20" rather than a present tense the clock has already falsified.
 * Wording it here rather than in the reader is the same argument that put `text`
 * here: the subject knows how its own claim is said, and a reader that
 * conjugated English would get "Task board fills" wrong.
 *
 * `lapses` says what the instant passing means. A countdown to something that
 * then stops being worth saying — a queue that has since ended, a drink that has
 * since run out and been noticed — `lapses: true`, and a reader replaying an old
 * snapshot drops it. A countdown to something that only gets worse — a full task
 * board reaching the moment it starts wasting tasks — `lapses: false`, and past
 * the instant `text` alone is the whole claim.
 *
 * The field is additive and every existing reader ignores it: the session card
 * draws `label`/`value`/`tone`/`target` and nothing else, and it is drawn
 * against the clock it was built with, so its countdowns are current by
 * construction.
 */

import { shortDuration } from '../../utils/overlay-format.js';

/** Milliseconds in an hour */
const HOUR_MS = 3_600_000;

/** A community buff this close to ending is worth mentioning */
export const BUFF_WINDOW_MS = HOUR_MS;

/** A task board this close to full is worth mentioning */
export const TASK_WINDOW_MS = HOUR_MS;

/** A queue with less than this left reads as "about to need you" */
export const QUEUE_WARN_SECONDS = 15 * 60;

/** A consumable with less than this left reads as "restock before you start" */
export const CONSUMABLE_WARN_SECONDS = 3 * 3600;

/**
 * Where each line points.
 *
 * Names rather than functions so the lines stay data: the panel owns the map
 * from name to navigation, and a line can be asserted on without a DOM.
 */
export const TARGETS = {
    queue: 'queue',
    tasks: 'tasks',
    consumables: 'consumables',
    listings: 'listings',
    enhancement: 'enhancement',
    guild: 'guild',
    labyrinth: 'labyrinth',
    notices: 'notices',
};

/**
 * A duration in the past, worded as an age.
 * @param {number} ms - How long ago
 * @returns {string} e.g. `20m ago`
 */
function ago(ms) {
    return `${shortDuration(ms / 1000)} ago`;
}

/**
 * The action queue: how much is left, or how long it has been empty.
 * @param {Object} facts - The collected facts
 * @param {number} now - Epoch ms
 * @returns {Object|null} A line, or null
 */
function queueLine(facts, now) {
    const queue = facts.queue;
    if (!queue) return null;

    if (!(queue.queued > 0)) {
        const since = Number.isFinite(queue.emptySince) ? ` — idle ${ago(now - queue.emptySince)}` : '';
        return { key: 'queue', label: 'Action queue', value: `Empty${since}`, tone: 'bad', target: TARGETS.queue };
    }

    // An unbounded action never runs out, so the figure beside it is the time
    // until it *starts* rather than the time until the queue ends
    if (queue.infinite && !(queue.seconds > 0)) {
        return { key: 'queue', label: 'Action queue', value: 'Running, no end', tone: 'good', target: TARGETS.queue };
    }

    const left = shortDuration(queue.seconds);
    const value = queue.infinite ? `${left} until endless action` : left;
    const tone = queue.seconds < QUEUE_WARN_SECONDS ? 'gold' : 'good';
    return {
        key: 'queue',
        label: 'Action queue',
        value,
        tone,
        target: TARGETS.queue,
        horizon: {
            at: now + queue.seconds * 1000,
            text: queue.infinite ? 'Endless action starts' : 'Queue ends',
            past: queue.infinite ? 'Endless action started' : 'Queue ended',
            lapses: true,
        },
    };
}

/**
 * Tasks that have arrived and not been looked at.
 * @param {Object} facts - The collected facts
 * @returns {Object|null} A line, or null
 */
function tasksReadyLine(facts) {
    const ready = Math.floor(Number(facts.tasksReady) || 0);
    if (ready <= 0) return null;
    return {
        key: 'tasksReady',
        label: 'Tasks to claim',
        value: `${ready} waiting`,
        tone: 'gold',
        target: TARGETS.tasks,
    };
}

/**
 * The task board filling up, which is a deadline rather than a reading.
 * @param {Object} facts - The collected facts
 * @param {number} now - Epoch ms
 * @returns {Object|null} A line, or null
 */
function taskSlotLine(facts, now) {
    const forecast = facts.taskSlots;
    if (!forecast?.ok) return null;

    if (forecast.isFull) {
        // A full board does not empty itself, so this claim never lapses — the
        // waste instant only turns "about to waste" into "wasting"
        const waste = {
            at: now + forecast.msUntilWaste,
            text: 'Full — tasks are being wasted',
            // Already the wording of something under way, so the far side of the
            // instant needs no other sentence
            past: 'Full — tasks are being wasted',
            lapses: false,
        };
        if (!(forecast.msUntilWaste > 0)) {
            return {
                key: 'taskSlots',
                label: 'Task board',
                value: 'Full — tasks are being wasted',
                tone: 'bad',
                target: TARGETS.tasks,
            };
        }
        return {
            key: 'taskSlots',
            label: 'Task board',
            value: `Full — first wasted in ${shortDuration(forecast.msUntilWaste / 1000)}`,
            tone: 'bad',
            target: TARGETS.tasks,
            horizon: waste,
        };
    }

    // A board with hours of room is not news; only the near deadline is
    if (!(forecast.msUntilFull <= TASK_WINDOW_MS)) return null;
    return {
        key: 'taskSlots',
        label: 'Task board',
        value: `Fills in ${shortDuration(Math.max(0, forecast.msUntilFull) / 1000)}`,
        tone: 'gold',
        target: TARGETS.tasks,
        // Once it has filled, "fills in 40m" is not a smaller number, it is the
        // wrong sentence — the full-board line is the one that replaces it, and
        // only a fresher snapshot can say so
        horizon: {
            at: now + Math.max(0, forecast.msUntilFull),
            text: 'Task board fills',
            past: 'Task board filled',
            lapses: true,
        },
    };
}

/**
 * A free reroll sitting unused.
 * @param {Object} facts - The collected facts
 * @returns {Object|null} A line, or null
 */
function rerollLine(facts) {
    const rerolls = facts.rerolls;
    if (!rerolls?.known || !rerolls.available) return null;
    const value = Number.isFinite(rerolls.remaining) ? `${rerolls.remaining} free` : 'Free reroll available';
    return { key: 'rerolls', label: 'Task rerolls', value, tone: 'good', target: TARGETS.tasks };
}

/**
 * Community buffs about to lapse.
 *
 * One line however many are ending, because they end within minutes of each
 * other and a line each would be the whole briefing.
 *
 * @param {Object} facts - The collected facts
 * @param {number} now - Epoch ms
 * @returns {Object|null} A line, or null
 */
function buffLine(facts, now) {
    const ending = (Array.isArray(facts.buffs) ? facts.buffs : [])
        .filter((buff) => Number.isFinite(buff?.expiresAt))
        .map((buff) => ({ name: buff.name || 'A buff', msLeft: buff.expiresAt - now }))
        .filter((buff) => buff.msLeft > 0 && buff.msLeft <= BUFF_WINDOW_MS)
        .sort((a, b) => a.msLeft - b.msLeft);

    if (ending.length === 0) return null;

    const soonest = ending[0];
    const more = ending.length > 1 ? ` (+${ending.length - 1} more)` : '';
    return {
        key: 'buffs',
        label: 'Community buff ending',
        value: `${soonest.name} in ${shortDuration(soonest.msLeft / 1000)}${more}`,
        tone: 'gold',
        target: null,
        horizon: {
            at: now + soonest.msLeft,
            text: `${soonest.name} ends`,
            past: `${soonest.name} ended`,
            lapses: true,
        },
    };
}

/**
 * The consumable that runs out first — the same reading the low alert fires on.
 * @param {Object} facts - The collected facts
 * @param {number} now - Epoch ms
 * @returns {Object|null} A line, or null
 */
function consumableLine(facts, now) {
    const soonest = facts.consumable;
    if (!soonest || !Number.isFinite(soonest.secondsLeft)) return null;
    const name = soonest.name || 'A consumable';

    // Already gone. `secondsLeft` is 0 when the stock is empty and the burn
    // rate is not, and a lapsing horizon at `now` is one no replay can ever be
    // earlier than — so the account panel dropped this line on every read, and
    // the one character actually out of drinks was the one it said nothing
    // about. There is no deadline left to carry: it is a reading, and nothing
    // about the clock makes it false. Same shape as the already-wasting task
    // board above.
    if (!(soonest.secondsLeft > 0)) {
        return {
            key: 'consumable',
            label: 'First to run dry',
            value: `${name} has run out`,
            tone: 'bad',
            target: TARGETS.consumables,
        };
    }

    return {
        key: 'consumable',
        label: 'First to run dry',
        value: `${name} in ${shortDuration(soonest.secondsLeft)}`,
        tone: soonest.secondsLeft <= CONSUMABLE_WARN_SECONDS ? 'bad' : 'neutral',
        target: TARGETS.consumables,
        // The forecast is a burn rate against a stock, and the burn only
        // continues while the character is fighting — past the instant it
        // projected, the projection has nothing left to say
        horizon: {
            at: now + soonest.secondsLeft * 1000,
            text: `${name} runs dry`,
            past: `${name} ran dry`,
            lapses: true,
        },
    };
}

/**
 * What the market did while nobody was looking.
 * @param {Object} facts - The collected facts
 * @returns {Object|null} A line, or null
 */
function listingLine(facts) {
    const listings = facts.listings;
    if (!listings) return null;

    const parts = [];
    if (listings.filled > 0) parts.push(`${listings.filled} filled`);
    if (listings.undercut > 0) parts.push(`${listings.undercut} undercut`);
    if (parts.length === 0) return null;

    return {
        key: 'listings',
        label: 'Market listings',
        value: parts.join(', '),
        tone: 'gold',
        target: TARGETS.listings,
    };
}

/**
 * An enhancement run left half-finished.
 * @param {Object} facts - The collected facts
 * @returns {Object|null} A line, or null
 */
function enhancementLine(facts) {
    const session = facts.enhancement;
    if (!session?.itemName) return null;

    const levels = `+${session.currentLevel ?? 0} → +${session.targetLevel ?? 0}`;
    const protections = session.protectionsUsed > 0 ? ` · ${session.protectionsUsed} protected` : '';
    return {
        key: 'enhancement',
        label: 'Enhancing',
        value: `${session.itemName} ${levels}${protections}`,
        tone: 'neutral',
        target: TARGETS.enhancement,
    };
}

/**
 * The guild trial, which is a weekly signup nobody remembers making.
 * @param {Object} facts - The collected facts
 * @returns {Object|null} A line, or null
 */
function guildLine(facts) {
    const guild = facts.guild;
    // null means "cannot tell", which is not the same as "not signed up" and
    // must not be reported as it
    if (!guild || guild.signedUp === null || guild.signedUp === undefined) return null;

    // No "starts in": a guild trial has no scheduled start — it begins when the
    // guild begins it — and nothing that fills these facts has ever produced a
    // countdown. The branch that read one was dead code dressed as a feature
    if (guild.signedUp) {
        return {
            key: 'guild',
            label: 'Guild trial',
            value: `Signed up${guild.trialName ? `: ${guild.trialName}` : ''}`,
            tone: 'good',
            target: TARGETS.guild,
        };
    }

    return {
        key: 'guild',
        label: 'Guild trial',
        value: 'Not signed up this week',
        tone: 'gold',
        target: TARGETS.guild,
    };
}

/**
 * Labyrinth entries banked and going to waste.
 * @param {Object} facts - The collected facts
 * @returns {Object|null} A line, or null
 */
function labyrinthLine(facts) {
    const forecast = facts.labyrinth;
    if (!forecast?.ok || !(forecast.available > 0)) return null;
    return {
        key: 'labyrinth',
        label: 'Labyrinth entries',
        value: forecast.isFull ? `${forecast.available} — capped` : `${forecast.available} available`,
        tone: forecast.isFull ? 'bad' : 'good',
        target: TARGETS.labyrinth,
    };
}

/**
 * Other characters whose queues have run out — what the idle notification
 * would have said had anybody been here to hear it.
 *
 * @param {Object} facts - The collected facts
 * @returns {Object|null} A line, or null
 */
function idleLine(facts) {
    const idle = Array.isArray(facts.idle) ? facts.idle : [];
    if (idle.length === 0) return null;
    const names = idle.map((entry) => entry?.characterName || 'A character');
    return { key: 'idle', label: 'Idle characters', value: names.join(', '), tone: 'bad', target: null };
}

/**
 * "12 notices while you were away".
 *
 * The only line here that reports the *script* rather than the game, and it
 * earns its place for the same reason the briefing does: digest mode and quiet
 * hours both deliberately withhold something at the moment it happened, so an
 * arriving player needs one place that says how much was withheld. Zero unread
 * is silence, like every other subject — a permanent "0 notices" row would be
 * the first thing to stop being read.
 *
 * @param {Object} facts - The collected facts
 * @returns {Object|null} A line, or null
 */
function noticeLine(facts) {
    const unread = Math.max(0, Math.floor(Number(facts.notices) || 0));
    if (unread === 0) return null;
    return {
        key: 'notices',
        label: 'Notices',
        value: `${unread} while you were away`,
        tone: 'neutral',
        target: TARGETS.notices,
    };
}

/** The subjects, in the order they are worth reading */
const BUILDERS = [
    queueLine,
    tasksReadyLine,
    taskSlotLine,
    rerollLine,
    buffLine,
    consumableLine,
    listingLine,
    enhancementLine,
    guildLine,
    labyrinthLine,
    idleLine,
    noticeLine,
];

/**
 * The briefing, as lines.
 *
 * @param {Object} [facts] - Everything `session-briefing.js` managed to read
 * @param {number} [now] - Clock, injectable for tests
 * @returns {Array<{key: string, label: string, value: string, tone: string, target: string|null,
 *   horizon?: {at: number, text: string, past: string, lapses: boolean}}>}
 *   One line per subject with something to say, in reading order
 */
export function buildBriefingLines(facts = {}, now = Date.now()) {
    const lines = [];
    for (const build of BUILDERS) {
        let line = null;
        try {
            line = build(facts, now);
        } catch (error) {
            // One malformed fact must not cost the other ten lines
            console.error('[SessionBriefing] A briefing line could not be built:', error);
        }
        if (line) lines.push(line);
    }
    return lines;
}
