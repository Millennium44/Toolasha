/**
 * Enhancement Session Data Structure
 * Represents a single enhancement tracking session for one item
 */

/** The Philosopher's Mirror: consumed every mirror attempt, so a consumable cost and not a protection */
export const PHILOSOPHERS_MIRROR_HRID = '/items/philosophers_mirror';

/**
 * Session states
 */
export const SessionState = {
    IDLE: 'idle', // No active session
    TRACKING: 'tracking', // Currently tracking enhancements
    COMPLETED: 'completed', // Target reached or manually stopped
    ARCHIVED: 'archived', // Historical session (read-only)
};

/**
 * Create a new enhancement session
 * @param {string} itemHrid - Item HRID being enhanced
 * @param {string} itemName - Display name of item
 * @param {number} startLevel - Starting enhancement level
 * @param {number} targetLevel - Target enhancement level (1-20)
 * @param {number} protectFrom - Level to start using protection items (0 = never)
 * @returns {Object} New session object
 */
export function createSession(itemHrid, itemName, startLevel, targetLevel, protectFrom = 0) {
    const now = Date.now();

    return {
        // Session metadata
        id: `session_${now}`,
        state: SessionState.TRACKING,
        itemHrid,
        itemName,
        startLevel,
        targetLevel,
        currentLevel: startLevel,
        protectFrom,

        // Timestamps
        startTime: now,
        lastUpdateTime: now,
        endTime: null,

        // Last attempt tracking (for detecting success/failure)
        lastAttempt: {
            attemptNumber: 0,
            level: startLevel,
            timestamp: now,
        },

        // Attempt tracking (per level)
        // Format: { 1: { success: 5, fail: 3, blessed: 1, successRate: 0.625 }, ... }
        attemptsPerLevel: {},

        // Cost tracking
        materialCosts: {}, // Format: { itemHrid: { count: 10, totalCost: 50000 } }
        hasUnpricedInput: false,
        coinCost: 0,
        coinCount: 0, // Track number of times coins were spent
        protectionCost: 0,
        protectionCount: 0,
        protectionItemHrid: null, // Track which protection item is being used
        // Philosopher's Mirrors consumed, kept apart from protections (an older session holds them in
        // the protection fields and breakdown instead — see getMirrorUsage)
        mirrorCost: 0,
        mirrorCount: 0,
        totalCost: 0,

        // Statistics
        totalAttempts: 0,
        totalSuccesses: 0,
        totalFailures: 0,
        totalBlessed: 0, // Successes that jumped +2 or more levels (Blessed Tea)
        totalXP: 0, // Total XP gained from enhancements
        longestSuccessStreak: 0,
        longestFailureStreak: 0,
        currentStreak: { type: null, count: 0 }, // 'success' or 'fail'

        // Milestones reached
        milestonesReached: [], // [5, 10, 15, 20]

        // Enhancement predictions (optional - calculated at session start)
        predictions: null, // { expectedAttempts, expectedProtections, ... }

        // Counter values when the session was last extended, so validation factors compare the
        // current leg against the prediction made for it. { totalAttempts, protectionCount }
        extensionBaseline: null,
    };
}

/**
 * Initialize attempts tracking for a level
 * @param {Object} session - Session object
 * @param {number} level - Enhancement level
 */
export function initializeLevelTracking(session, level) {
    if (!session.attemptsPerLevel[level]) {
        session.attemptsPerLevel[level] = {
            success: 0,
            fail: 0,
            blessed: 0,
            successRate: 0,
        };
    }
}

/**
 * Update success rate for a level
 * @param {Object} session - Session object
 * @param {number} level - Enhancement level
 */
export function updateSuccessRate(session, level) {
    const levelData = session.attemptsPerLevel[level];
    if (!levelData) return;

    const total = levelData.success + levelData.fail;
    levelData.successRate = total > 0 ? levelData.success / total : 0;
}

/**
 * Record a successful enhancement attempt
 * @param {Object} session - Session object
 * @param {number} previousLevel - Level before enhancement (level that succeeded)
 * @param {number} newLevel - New level after success
 * @param {boolean} wasBlessed - Whether this success jumped +2 or more levels (Blessed Tea).
 *   A subtype of success, not counted as an additional attempt/success on top of it.
 */
export function recordSuccess(session, previousLevel, newLevel, wasBlessed = false) {
    // Initialize tracking if needed for the level that succeeded
    initializeLevelTracking(session, previousLevel);

    // Record success at the level we enhanced FROM
    session.attemptsPerLevel[previousLevel].success++;
    session.totalAttempts++;
    session.totalSuccesses++;

    if (wasBlessed) {
        session.attemptsPerLevel[previousLevel].blessed++;
        session.totalBlessed++;
    }

    // Update success rate for this level
    updateSuccessRate(session, previousLevel);

    // Update current level
    session.currentLevel = newLevel;

    // Update streaks
    if (session.currentStreak.type === 'success') {
        session.currentStreak.count++;
    } else {
        session.currentStreak = { type: 'success', count: 1 };
    }

    if (session.currentStreak.count > session.longestSuccessStreak) {
        session.longestSuccessStreak = session.currentStreak.count;
    }

    // Check for milestones. A Blessed success can jump +2 or more levels in one
    // attempt (e.g. +4 -> +6), passing straight over a milestone (+5) without
    // ever landing on it — checking only newLevel missed those crossed-but-not-
    // landed-on milestones entirely. Scan every level from previousLevel+1
    // through newLevel so a skipped milestone still counts as reached.
    for (let level = previousLevel + 1; level <= newLevel; level++) {
        if ([5, 10, 15, 20].includes(level) && !session.milestonesReached.includes(level)) {
            session.milestonesReached.push(level);
        }
    }

    // Update timestamp
    session.lastUpdateTime = Date.now();

    // Check if target reached
    if (newLevel >= session.targetLevel) {
        session.state = SessionState.COMPLETED;
        session.endTime = Date.now();
    }
}

/**
 * Record a failed enhancement attempt
 * @param {Object} session - Session object
 * @param {number} previousLevel - Level that failed (level we tried to enhance from)
 */
export function recordFailure(session, previousLevel, newLevel) {
    // Initialize tracking if needed for the level that failed
    initializeLevelTracking(session, previousLevel);

    // Record failure at the level we enhanced FROM
    session.attemptsPerLevel[previousLevel].fail++;
    session.totalAttempts++;
    session.totalFailures++;

    // Update success rate for this level
    updateSuccessRate(session, previousLevel);

    // Update current level to actual level after failure
    session.currentLevel = newLevel;

    // Update streaks
    if (session.currentStreak.type === 'fail') {
        session.currentStreak.count++;
    } else {
        session.currentStreak = { type: 'fail', count: 1 };
    }

    if (session.currentStreak.count > session.longestFailureStreak) {
        session.longestFailureStreak = session.currentStreak.count;
    }

    // Update timestamp
    session.lastUpdateTime = Date.now();
}

/**
 * Add material cost to session
 * @param {Object} session - Session object
 * @param {string} itemHrid - Material item HRID
 * @param {number} count - Quantity used
 * @param {number} unitCost - Cost per item (from market)
 */
export function addMaterialCost(session, itemHrid, count, unitCost) {
    if (count > 0 && !(unitCost > 0)) session.hasUnpricedInput = true;
    if (!session.materialCosts[itemHrid]) {
        session.materialCosts[itemHrid] = {
            count: 0,
            totalCost: 0,
        };
    }

    session.materialCosts[itemHrid].count += count;
    session.materialCosts[itemHrid].totalCost += count * unitCost;

    // Update total cost
    recalculateTotalCost(session);
}

/**
 * Add coin cost to session
 * @param {Object} session - Session object
 * @param {number} amount - Coin amount spent
 */
export function addCoinCost(session, amount) {
    session.coinCost += amount;
    session.coinCount += 1;
    recalculateTotalCost(session);
}

/**
 * Add protection item cost to session
 * @param {Object} session - Session object
 * @param {string} protectionItemHrid - Protection item HRID
 * @param {number} cost - Protection item cost
 */
export function addProtectionCost(session, protectionItemHrid, cost) {
    if (!(cost > 0)) session.hasUnpricedInput = true;

    // A second protection item starts a per-item breakdown, splitting off what the first one
    // already consumed, rather than booking the new item under the old one's name
    if (
        !session.protectionBreakdown &&
        protectionItemHrid &&
        session.protectionItemHrid &&
        session.protectionItemHrid !== protectionItemHrid
    ) {
        session.protectionBreakdown = { ...getProtectionBreakdown(session) };
    }

    session.protectionCost += cost;
    session.protectionCount += 1;

    // Store the protection item HRID if not already set
    if (!session.protectionItemHrid) {
        session.protectionItemHrid = protectionItemHrid;
    }

    // A session merged from runs that used different protection items keeps them apart
    if (session.protectionBreakdown && protectionItemHrid) {
        const entry = (session.protectionBreakdown[protectionItemHrid] ||= { count: 0, totalCost: 0 });
        entry.count += 1;
        entry.totalCost += cost;
    }

    recalculateTotalCost(session);
}

/**
 * Add one Philosopher's Mirror to the session's cost. It counts toward the total cost and the
 * unpriced-input flag, but not toward protections.
 * @param {Object} session - Session object
 * @param {number} cost - Mirror cost
 */
export function addMirrorCost(session, cost) {
    if (!(cost > 0)) session.hasUnpricedInput = true;
    session.mirrorCost = (session.mirrorCost || 0) + cost;
    session.mirrorCount = (session.mirrorCount || 0) + 1;
    recalculateTotalCost(session);
}

/**
 * The Philosopher's Mirrors a session consumed. Sessions recorded before mirrors had their own
 * fields hold them in the protection count, cost and breakdown, so the breakdown's mirror entry
 * is read as well; the stored data is left as it is.
 * @param {Object} session - Session object
 * @returns {{count: number, cost: number, legacyCount: number, legacyCost: number}} Totals, and
 *   the share of them that sits inside the protection fields
 */
export function getMirrorUsage(session) {
    const legacy = getProtectionBreakdown(session)[PHILOSOPHERS_MIRROR_HRID];
    const legacyCount = legacy?.count || 0;
    const legacyCost = legacy?.totalCost || 0;
    return {
        count: (session?.mirrorCount || 0) + legacyCount,
        cost: (session?.mirrorCost || 0) + legacyCost,
        legacyCount,
        legacyCost,
    };
}

/**
 * The protections a session consumed, mirrors excluded. The stored protection fields of an older
 * session include its mirrors; they are taken back out here.
 * @param {Object} session - Session object
 * @returns {{count: number, cost: number, breakdown: Object<string, {count: number, totalCost: number}>}}
 *   `breakdown` is keyed like {@link getProtectionBreakdown}, without the mirror
 */
export function getProtectionUsage(session) {
    const mirror = getMirrorUsage(session);
    const breakdown = { ...getProtectionBreakdown(session) };
    delete breakdown[PHILOSOPHERS_MIRROR_HRID];
    return {
        count: Math.max(0, (session?.protectionCount || 0) - mirror.legacyCount),
        cost: Math.max(0, (session?.protectionCost || 0) - mirror.legacyCost),
        breakdown,
    };
}

/**
 * The protection a session consumed, per protection item. A session that never mixed items has
 * no stored breakdown; its one item carries the whole count and cost.
 * @param {Object} session - Session object
 * @returns {Object<string, {count: number, totalCost: number}>} Keyed by item hrid ('' when the
 *   item was never recorded)
 */
export function getProtectionBreakdown(session) {
    if (session?.protectionBreakdown) return session.protectionBreakdown;
    if (!(session?.protectionCount > 0) && !(session?.protectionCost > 0)) return {};
    return {
        [session.protectionItemHrid || '']: {
            count: session.protectionCount || 0,
            totalCost: session.protectionCost || 0,
        },
    };
}

/**
 * Recalculate total cost from all sources
 * @param {Object} session - Session object
 */
function recalculateTotalCost(session) {
    const materialTotal = Object.values(session.materialCosts).reduce((sum, m) => sum + m.totalCost, 0);

    session.totalCost = materialTotal + session.coinCost + session.protectionCost + (session.mirrorCost || 0);
}

/**
 * Get session duration in seconds
 * @param {Object} session - Session object
 * @returns {number} Duration in seconds
 */
export function getSessionDuration(session) {
    // A live session's clock runs to its last recorded attempt, not to the
    // wall clock. lastUpdateTime advances only when an attempt lands, so once
    // enhancing stops — the user walked away, or the run was abandoned short of
    // its target — the duration freezes instead of counting time nobody spent
    // enhancing. Before this, only a completed run (which sets endTime) ever
    // stopped, so an idle In-Progress session ticked up forever.
    //
    // A resumed or merged session counts only active time: the stretches it was
    // ended for (between one run stopping and the next picking it up) are not
    // enhancing. See getActiveSpans.
    const ms = getActiveSpans(session).reduce((sum, span) => sum + (span.end - span.start), 0);
    return Math.floor(ms / 1000);
}

/**
 * The stretches of time a session was actually enhancing, oldest first.
 *
 * A session that was never resumed or merged has one: its start to its end (or, while running,
 * its last recorded attempt). A resumed or merged one keeps its closed stretches in
 * `pastActiveSpans` and runs its current one from `segmentStartTime`, so the gaps between runs
 * are neither counted as duration nor spread over by anything that shares a session's figures
 * out across the days it ran.
 * @param {Object} session - Session object
 * @returns {Array<{start: number, end: number}>} Epoch ms, `end >= start`
 */
export function getActiveSpans(session) {
    if (!session) return [];
    const past = Array.isArray(session.pastActiveSpans) ? session.pastActiveSpans : [];
    const start = session.segmentStartTime || session.startTime;
    const end = session.endTime || session.lastUpdateTime || start;
    const spans = past.map((span) => ({ ...span, end: Math.max(span.start, span.end) }));
    if (Number.isFinite(start)) {
        // The open stretch's own leg: from the level and spend it began at to where they stand
        spans.push({
            start,
            end: Math.max(start, end),
            startLevel: Number.isFinite(session.segmentStartLevel) ? session.segmentStartLevel : session.startLevel,
            endLevel: session.currentLevel,
            cost: (session.totalCost || 0) - (session.segmentStartCost || 0),
        });
    }
    return spans;
}

/**
 * When a session's active history begins: the start of its earliest active stretch.
 * @param {Object} session - Session object
 * @returns {number} Epoch ms
 */
export function firstActiveTime(session) {
    const starts = getActiveSpans(session)
        .map((span) => span.start)
        .filter(Number.isFinite);
    return starts.length > 0 ? Math.min(...starts) : session?.startTime || 0;
}

/**
 * When a session last did anything: its last attempt, else its last update, else its end, else
 * its start. Resume and extend keep a session's original start time while it runs on long
 * after, so ordering sessions by start says nothing about which one is the latest.
 * @param {Object} session - Session object
 * @returns {number} Epoch ms
 */
export function lastActivityTime(session) {
    return (
        Math.max(session?.lastAttempt?.timestamp || 0, session?.lastUpdateTime || 0, session?.endTime || 0) ||
        session?.startTime ||
        0
    );
}

/**
 * Whether an ended session is the one a new run should continue rather than start afresh: the
 * same item, the same target and protection setup, ended short of its target, and the new run
 * starting at exactly the level the session ended at.
 *
 * Every input is the game's own data (item hrid, levels from the queue row's item hash, the
 * action's target and protect-from fields), never displayed text.
 *
 * @param {Object} session - Candidate session (the most recent one)
 * @param {Object} run - The run about to start
 * @param {string} run.itemHrid - Item being enhanced
 * @param {number|null} run.startLevel - Level the run's first attempt started from (null: unknown)
 * @param {number} run.targetLevel - The action's enhancingMaxLevel
 * @param {number} run.protectFrom - The action's enhancingProtectionMinLevel (0: none)
 * @param {string|null} [run.protectionItemHrid] - Protection item loaded, when known
 * @param {Object} [options]
 * @param {boolean} [options.combineProtectionItems] - Continue the session even when the new run
 *   loads a different protection item (the per-item protection breakdown keeps them apart)
 * @returns {boolean}
 */
export function canResumeSession(session, run, { combineProtectionItems = false } = {}) {
    if (!session || !run) return false;
    if (session.state !== SessionState.COMPLETED) return false;
    if (session.itemHrid !== run.itemHrid) return false;
    if (!Number.isFinite(run.startLevel)) return false;
    if (session.targetLevel !== run.targetLevel) return false;
    if ((session.protectFrom || 0) !== (run.protectFrom || 0)) return false;
    // A different protection item is a different setup; an unknown one on either side (no
    // protection consumed yet, or none loaded) is not evidence against it. The session's own
    // setup is the item loaded on its last attempt; the item it first consumed stands in for
    // sessions recorded before attempts carried it.
    const configured = session.lastAttempt?.protectionItemHrid ?? session.protectionItemHrid;
    if (!combineProtectionItems && configured && run.protectionItemHrid && configured !== run.protectionItemHrid) {
        return false;
    }
    // A run that reached its target is extended, not resumed
    if (!(session.currentLevel < session.targetLevel)) return false;
    return session.currentLevel === run.startLevel;
}

/**
 * Close the session's open stretch and start a new one now — for every path that sets an ended
 * session running again (resume, extend). The stretch that ended is banked in `pastActiveSpans`
 * with its own levels and spend; the new one starts from the level and spend in hand. Without
 * this the reopened run's stretch reached back to the previous one's start: the idle gap counted
 * as duration, and gold sources booked both runs' figures across the wrong days.
 * @param {Object} session - Session reopened (mutated)
 * @param {number} now - Epoch ms
 */
function startNewSegment(session, now) {
    session.pastActiveSpans = getActiveSpans(session);
    session.segmentStartTime = now;
    session.segmentStartLevel = session.currentLevel;
    session.segmentStartCost = session.totalCost || 0;
}

/**
 * The attempts the session's current leg made at each level, from the session's per-level
 * tally less what its already banked legs made. Null when that cannot be known: a banked leg
 * predates the tally, or the result does not add up to the leg's attempts (an unbanked leg's
 * attempts are in the tally).
 * @param {Object} session - Session object
 * @param {number} legAttempts - Attempts the current leg made
 * @returns {Object<string, number>|null} `{ level: attempts }`
 */
function currentLegLevelAttempts(session, legAttempts) {
    const banked = Array.isArray(session.legPredictions) ? session.legPredictions : [];
    if (banked.some((leg) => !leg.levelAttempts)) return null;
    const tally = {};
    for (const [level, data] of Object.entries(session.attemptsPerLevel || {})) {
        tally[level] = (data.success || 0) + (data.fail || 0);
    }
    for (const leg of banked) {
        for (const [level, count] of Object.entries(leg.levelAttempts)) tally[level] = (tally[level] || 0) - count;
    }
    let total = 0;
    for (const [level, count] of Object.entries(tally)) {
        if (count < 0) return null;
        if (count === 0) delete tally[level];
        else total += count;
    }
    return total === legAttempts ? tally : null;
}

/**
 * The leg a session is in, as `legPredictions` keeps it: where it began, where it was headed, its
 * own prediction, and how many attempts it made (so the legs can be checked to cover every
 * attempt the session made). `levelAttempts` (optional; absent on legs recorded before it
 * existed) is how many of those attempts were made at each level, which is what weights the leg
 * when merged runs' forecasts are combined (see {@link mergedExpectation}).
 * @param {Object} session - Session object
 * @returns {Object}
 */
function currentLegRecord(session) {
    const attempts = Math.max(0, (session.totalAttempts || 0) - (session.extensionBaseline?.totalAttempts || 0));
    const record = {
        sessionId: session.id,
        startLevel: Number.isFinite(session.segmentStartLevel) ? session.segmentStartLevel : session.startLevel,
        targetLevel: session.targetLevel,
        protectFrom: session.protectFrom || 0,
        predictions: session.predictions || null,
        attempts,
    };
    const levelAttempts = currentLegLevelAttempts(session, attempts);
    if (levelAttempts) record.levelAttempts = levelAttempts;
    return record;
}

/**
 * Bank the session's current prediction as a finished leg (resume, extend), when it has one.
 * @param {Object} session - Session object (mutated)
 */
function bankCurrentLeg(session) {
    if (!session.predictions) return;
    // A new leg starts after this: it is no longer the merge's live leg
    delete session.mergedLiveLeg;
    session.legPredictions = [
        ...(Array.isArray(session.legPredictions) ? session.legPredictions : []),
        currentLegRecord(session),
    ];
}

/**
 * Whether two predictions describe the same forecast: the same expectation and spread, so the
 * stats they were made from did not change between them.
 * @param {Object|null} a - Prediction
 * @param {Object|null} b - Prediction
 * @returns {boolean}
 */
function samePrediction(a, b) {
    if (!a || !b) return false;
    const close = (x, y) =>
        Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x));
    if (Number.isFinite(a.expectedAttemptsExact) || Number.isFinite(b.expectedAttemptsExact)) {
        return (
            close(a.expectedAttemptsExact, b.expectedAttemptsExact) &&
            (a.expectedProtections || 0) === (b.expectedProtections || 0)
        );
    }
    return a.expectedAttempts === b.expectedAttempts && (a.expectedProtections || 0) === (b.expectedProtections || 0);
}

/**
 * Reopen an ended session so a new run's attempts are recorded against it. The time it spent
 * ended is not counted: its duration so far is banked and the clock restarts at `startedAt`
 * (when the new run's first attempt began, when known) or now.
 *
 * The resumed run is normally its own predicted leg, the way an extension is: the player may
 * have changed level, gear, teas or buffs before restarting, so the old prediction describes
 * none of the new run's attempts. The old leg's prediction is banked in `legPredictions` (as a
 * merge banks its runs'), the counters are snapshotted as the leg's baseline, and the prediction
 * is cleared for the caller to compute afresh from current stats.
 *
 * The exception is a run that picks up at the very level its leg began at with a prediction
 * identical to the leg's own (`newPredictions`): nothing about the forecast changed, so it is one
 * unfinished run being worked in pieces (a queue of single attempts), not a new leg. The leg,
 * its prediction and its baseline are kept, so the panel and calibration compare the whole run's
 * attempts against it rather than only the last piece.
 * @param {Object} session - Session to reopen (mutated)
 * @param {number} [now] - Epoch ms
 * @param {Object} [options]
 * @param {Object|null} [options.newPredictions] - Prediction computed for the resumed run now
 * @param {number|null} [options.startedAt] - When the run's first attempt began, when known
 */
export function resumeSession(session, now = Date.now(), options = {}) {
    const { newPredictions = null, startedAt = null } = options || {};
    const legStartLevel = Number.isFinite(session.segmentStartLevel) ? session.segmentStartLevel : session.startLevel;
    const sameLeg = session.currentLevel === legStartLevel && samePrediction(session.predictions, newPredictions);
    if (!sameLeg) {
        bankCurrentLeg(session);
        session.predictions = null;
        session.extensionBaseline = {
            totalAttempts: session.totalAttempts || 0,
            protectionCount: getProtectionUsage(session).count,
            protectionCountExcludesMirrors: true,
        };
    }
    // The run began no earlier than the last one ended and no later than now
    const floor = Math.max(session.endTime || 0, session.lastUpdateTime || 0);
    const begin = Number.isFinite(startedAt) ? Math.min(now, Math.max(startedAt, floor)) : now;
    startNewSegment(session, begin);
    session.state = SessionState.TRACKING;
    session.endTime = null;
    session.lastUpdateTime = now;
}

/**
 * Check whether a set of sessions can be merged into one, and order them by last activity.
 *
 * Every session must be the same item, and every one but the latest — the one active most
 * recently ({@link lastActivityTime}), not the one started last: a resumed or extended session
 * keeps its early start while it runs on — must have ended. The latest may still be running, in
 * which case the merged session stays the live one. Differing targets or protection are
 * allowed: the merged session keeps the latest one's (`settingsDiffer` says when that happened,
 * and `protectionItemsDiffer` when the runs consumed different protection items, so the
 * confirmation can say so).
 *
 * Every run must also continue the one before it, in that order: start at the level it ended at.
 *
 * @param {Array<Object>} sessions - Sessions picked for the merge
 * @param {Object} [options]
 * @param {function(Object): string} [options.labelOf] - How to name a session in a refusal
 * @returns {{ok: boolean, reason?: string, ordered?: Array<Object>, settingsDiffer?: boolean,
 *   protectionItemsDiffer?: boolean}} `ordered` runs from least to most recently active
 */
export function planSessionMerge(sessions, { labelOf = (session) => session.id } = {}) {
    const list = (Array.isArray(sessions) ? sessions : []).filter(Boolean);
    if (list.length < 2) return { ok: false, reason: 'Pick at least two sessions to merge.' };
    const itemHrid = list[0].itemHrid;
    if (list.some((session) => session.itemHrid !== itemHrid)) {
        return { ok: false, reason: 'Only sessions for the same item can be merged.' };
    }
    const ordered = [...list].sort((a, b) => lastActivityTime(a) - lastActivityTime(b));
    const older = ordered.slice(0, -1);
    if (older.some((session) => session.state === SessionState.TRACKING)) {
        return {
            ok: false,
            reason: 'Only the most recently active of the picked sessions may still be in progress; the others must have ended.',
        };
    }
    // One chain only: each run picks the item up at the level the run before it left it. Two
    // independent climbs (two +0 → +5 runs on different copies) cannot become one session — it
    // would hold one start and one end level against both runs' costs, and everything valuing
    // the climb (worth-it, gold sources) would see one level gain paid for twice.
    for (let i = 1; i < ordered.length; i++) {
        const before = ordered[i - 1];
        const after = ordered[i];
        if (after.startLevel !== before.currentLevel) {
            return {
                ok: false,
                reason:
                    `${labelOf(before)} ended at +${before.currentLevel} but ${labelOf(after)} started at ` +
                    `+${after.startLevel} — only runs that continue each other can merge.`,
            };
        }
        // ...and in time: a run that was enhancing before the one ahead of it had finished
        // cannot have been working on what that run produced, whatever its levels say
        if (firstActiveTime(after) < lastActivityTime(before)) {
            return {
                ok: false,
                reason:
                    `${labelOf(after)} was already enhancing before ${labelOf(before)} finished — ` +
                    'only runs that follow one another can merge.',
            };
        }
    }
    const newest = ordered[ordered.length - 1];
    const settingsDiffer = older.some(
        (session) =>
            session.targetLevel !== newest.targetLevel || (session.protectFrom || 0) !== (newest.protectFrom || 0)
    );
    const protectionItems = new Set(
        ordered.flatMap((session) => Object.keys(getProtectionBreakdown(session)).filter(Boolean))
    );
    const protectFromDiffers =
        ordered.some((session) => session.mixedProtection === true) ||
        older.some((session) => (session.protectFrom || 0) !== (newest.protectFrom || 0));
    return {
        ok: true,
        ordered,
        settingsDiffer,
        protectFromDiffers,
        protectionItemsDiffer: protectionItems.size > 1,
    };
}

/**
 * Fold the other sessions into the most recently active one, in place, making one persisted
 * session.
 *
 * The latest session's object is kept (and so its id, its place in the list, the tracker's
 * current-session pointer, and any attempt handler still holding it). It takes the sum of every
 * counter, cost, per-level tally and XP; the start level and start time of the session that
 * started first; and every session's active stretches (not the wall-clock span between them).
 * Its own target, protection, state, current level and last attempt are kept. Protection is kept
 * per item when the runs used different ones. The merged session stores no combined prediction —
 * each run's own is kept in `legPredictions`, with the attempts it made per level, and the panel
 * rebuilds the combined forecast from them ({@link mergedExpectation}) — and is not calibrated
 * (see calibrationObservation); the extension baseline is cleared.
 *
 * @param {Array<Object>} ordered - Sessions by last activity, from {@link planSessionMerge}
 * @returns {Object} The latest session, now the merged one
 */
export function foldSessions(ordered) {
    const newest = ordered[ordered.length - 1];
    const older = ordered.slice(0, -1);
    // The chain starts where its first run (by activity) started; the start time is the earliest
    // any of them started, for anything asking how far back the session reaches
    const chainStart = ordered[0];
    const firstStartTime = Math.min(...ordered.map((session) => session.startTime || Infinity));

    // Each run's own prediction, kept as it was made (on the stats the player had then) for the
    // leg it describes, in chain order. The panel sums them (summedLegPredictions); calibration
    // ignores them (calibrationObservation).
    // A run merged before already carries its legs.
    // The survivor's own leg is left out when it is still running with a forecast: it keeps
    // receiving attempts, so it stays the session's live leg (see below) rather than a record
    // frozen at the attempts it had when the merge happened
    const liveLeg = newest.state === SessionState.TRACKING && newest.predictions != null;
    const liveBaseline = {
        totalAttempts: newest.extensionBaseline?.totalAttempts || 0,
        protectionCount: newest.extensionBaseline?.protectionCount || 0,
        // A stored baseline without the marker counted mirrors as protections; it stays unmarked
        protectionCountExcludesMirrors:
            !newest.extensionBaseline || newest.extensionBaseline.protectionCountExcludesMirrors === true,
    };
    const legPredictions = ordered.flatMap((session) => {
        const banked = Array.isArray(session.legPredictions) ? session.legPredictions : [];
        if (liveLeg && session === newest) return banked;
        // A resumed run still holds its current leg's prediction. With banked legs and none
        // current, that leg's attempts are not covered by any record (see summedLegPredictions)
        if (banked.length > 0 && !session.predictions) return banked;
        return [...banked, currentLegRecord(session)];
    });

    const spans = [];
    const breakdowns = ordered.map((session) => getProtectionBreakdown(session));
    const segmentStartTime = newest.segmentStartTime || newest.startTime;
    const ownPast = Array.isArray(newest.pastActiveSpans) ? newest.pastActiveSpans : [];
    // The survivor's open stretch keeps its own leg: the level it began at (its start level is
    // about to become the chain's), and the spend before it, which now includes every folded run
    const segmentStartLevel = Number.isFinite(newest.segmentStartLevel) ? newest.segmentStartLevel : newest.startLevel;
    const segmentStartCost = (newest.segmentStartCost || 0) + older.reduce((sum, s) => sum + (s.totalCost || 0), 0);
    // Legs run with different protect-from levels: said on the panel's Prot row
    const mixedProtection =
        ordered.some((session) => session.mixedProtection === true) ||
        older.some((session) => (session.protectFrom || 0) !== (newest.protectFrom || 0));
    for (const session of older) {
        spans.push(...getActiveSpans(session));

        newest.totalAttempts = (newest.totalAttempts || 0) + (session.totalAttempts || 0);
        newest.totalSuccesses = (newest.totalSuccesses || 0) + (session.totalSuccesses || 0);
        newest.totalFailures = (newest.totalFailures || 0) + (session.totalFailures || 0);
        newest.totalBlessed = (newest.totalBlessed || 0) + (session.totalBlessed || 0);
        newest.totalXP = (newest.totalXP || 0) + (session.totalXP || 0);
        newest.coinCost = (newest.coinCost || 0) + (session.coinCost || 0);
        newest.coinCount = (newest.coinCount || 0) + (session.coinCount || 0);
        newest.protectionCost = (newest.protectionCost || 0) + (session.protectionCost || 0);
        newest.protectionCount = (newest.protectionCount || 0) + (session.protectionCount || 0);
        newest.mirrorCost = (newest.mirrorCost || 0) + (session.mirrorCost || 0);
        newest.mirrorCount = (newest.mirrorCount || 0) + (session.mirrorCount || 0);
        newest.hasUnpricedInput = newest.hasUnpricedInput === true || session.hasUnpricedInput === true;
        newest.longestSuccessStreak = Math.max(newest.longestSuccessStreak || 0, session.longestSuccessStreak || 0);
        newest.longestFailureStreak = Math.max(newest.longestFailureStreak || 0, session.longestFailureStreak || 0);

        newest.attemptsPerLevel ||= {};
        for (const [level, tally] of Object.entries(session.attemptsPerLevel || {})) {
            initializeLevelTracking(newest, level);
            const into = newest.attemptsPerLevel[level];
            into.success += tally.success || 0;
            into.fail += tally.fail || 0;
            into.blessed = (into.blessed || 0) + (tally.blessed || 0);
            updateSuccessRate(newest, level);
        }

        newest.materialCosts ||= {};
        for (const [hrid, material] of Object.entries(session.materialCosts || {})) {
            if (!newest.materialCosts[hrid]) newest.materialCosts[hrid] = { count: 0, totalCost: 0 };
            newest.materialCosts[hrid].count += material.count || 0;
            newest.materialCosts[hrid].totalCost += material.totalCost || 0;
        }

        for (const milestone of session.milestonesReached || []) {
            newest.milestonesReached ||= [];
            if (!newest.milestonesReached.includes(milestone)) newest.milestonesReached.push(milestone);
        }
    }
    newest.milestonesReached?.sort((a, b) => a - b);
    recalculateTotalCost(newest);

    // Per-item protection. The survivor's protectionItemHrid stays its own (the item its own setup
    // consumes, null until it consumes one), never one inherited from another run; that history
    // is kept per item whenever it is not all that one item, so a later protection is booked
    // under its real name.
    const combined = {};
    for (const breakdown of breakdowns) {
        for (const [hrid, entry] of Object.entries(breakdown)) {
            const into = (combined[hrid] ||= { count: 0, totalCost: 0 });
            into.count += entry.count || 0;
            into.totalCost += entry.totalCost || 0;
        }
    }
    const items = Object.keys(combined);
    // A survivor that already keeps a breakdown always takes the combined one, or the runs folded
    // in now would be counted in protectionCount but missing from the per-item rows
    if (
        newest.protectionBreakdown ||
        items.length > 1 ||
        (items.length === 1 && items[0] !== (newest.protectionItemHrid || ''))
    ) {
        newest.protectionBreakdown = combined;
    }

    newest.startLevel = chainStart.startLevel;
    if (Number.isFinite(firstStartTime)) newest.startTime = firstStartTime;
    newest.pastActiveSpans = [...spans, ...ownPast].sort((a, b) => a.start - b.start);
    newest.segmentStartTime = segmentStartTime;
    newest.segmentStartLevel = segmentStartLevel;
    newest.segmentStartCost = segmentStartCost;
    if (liveLeg) {
        // The live leg counts only its own attempts and protections: the counters just took in
        // the folded runs, so the baseline sits at the totals those runs added
        newest.extensionBaseline = {
            totalAttempts: older.reduce((sum, s) => sum + (s.totalAttempts || 0), liveBaseline.totalAttempts),
            protectionCount: older.reduce((sum, s) => sum + getProtectionUsage(s).count, liveBaseline.protectionCount),
            ...(liveBaseline.protectionCountExcludesMirrors ? { protectionCountExcludesMirrors: true } : {}),
        };
        newest.mergedLiveLeg = true;
    } else {
        newest.extensionBaseline = null;
        // A marker from an earlier live merge would otherwise keep the next predicted leg out of calibration
        delete newest.mergedLiveLeg;
    }
    if (mixedProtection) newest.mixedProtection = true;
    // No combined prediction: the legs ran on the stats the player had at the time, and one
    // prediction from today's stats would describe none of them. A survivor still running keeps its
    // own forecast, as its live leg (flagged so calibration still skips the merged session)
    if (!liveLeg) newest.predictions = null;
    newest.legPredictions = legPredictions;
    newest.mergedFrom = [
        ...(newest.mergedFrom || []),
        ...older.flatMap((session) => [...(session.mergedFrom || []), session.id]),
    ];
    return newest;
}

/**
 * Whether a session ran in several predicted legs (merged, resumed under changed stats, or
 * extended), so its expected figures are a sum of legs rather than one prediction.
 * @param {Object} session - Session object
 * @returns {boolean}
 */
export function hasPredictionLegs(session) {
    return Array.isArray(session?.legPredictions) && session.legPredictions.length > 0;
}

/**
 * The expected attempts and protections of a session that ran in several legs: each leg's own
 * prediction (made on the stats the player had for it), counted only over the stretch that leg
 * actually covered. A leg's prediction runs from its start level to its target, but the next leg
 * begins wherever the item stood when the previous one stopped; the leg is counted from its start
 * to that level using the per-level expectations stored with the prediction (`levelExpectations`),
 * or in full when it reached its own target. The last leg runs to the level the item stands at.
 * A leg that stopped no higher than it began counts nothing (its attempts are all in the actual
 * figure, so the factor reads a little high). The matching actual figure is the session's total
 * attempts.
 *
 * Null (shown as a dash) for a one-leg session, and whenever the sum could not be honest: a leg
 * with no prediction, a leg that needs a per-level expectation its prediction lacks, or legs whose
 * attempts do not add up to the session's (a session stored before legs were banked on every
 * path, so one is missing).
 * @param {Object} session - Session object
 * @returns {{legs: number, expectedAttempts: number, expectedProtections: number}|null}
 */
export function summedLegPredictions(session) {
    if (!hasPredictionLegs(session)) return null;
    const legs = session.legPredictions.map((leg) => ({ ...leg }));
    if (session.predictions) legs.push(currentLegRecord(session));
    if (legs.some((leg) => !leg.predictions || !Number.isFinite(leg.attempts))) return null;
    if (legs.reduce((sum, leg) => sum + leg.attempts, 0) !== (session.totalAttempts || 0)) return null;

    let attempts = 0;
    let protections = 0;
    for (let i = 0; i < legs.length; i++) {
        const { predictions: p, startLevel, targetLevel } = legs[i];
        const end = i + 1 < legs.length ? legs[i + 1].startLevel : session.currentLevel;
        if (!Number.isFinite(end) || !Number.isFinite(startLevel)) return null;
        if (end >= targetLevel) {
            attempts += Number.isFinite(p.expectedAttemptsExact) ? p.expectedAttemptsExact : p.expectedAttempts || 0;
            protections += p.expectedProtections || 0;
        } else if (end > startLevel) {
            const part = p.levelExpectations?.[end];
            if (!Array.isArray(part)) return null;
            attempts += part[0] || 0;
            protections += part[1] || 0;
        }
    }
    return { legs: legs.length, expectedAttempts: Math.round(attempts), expectedProtections: Math.round(protections) };
}

/**
 * The legs of a multi-leg session as records, the live leg (one with a prediction still open on
 * the session) last.
 * @param {Object} session - Session object
 * @returns {Array<Object>}
 */
function legsOf(session) {
    const legs = (Array.isArray(session.legPredictions) ? session.legPredictions : []).map((leg) => ({ ...leg }));
    if (session.predictions) legs.push(currentLegRecord(session));
    return legs;
}

/**
 * How much a leg counts when forecasts are averaged at a level: the attempts it made there. A leg
 * recorded before per-level tallies were kept is weighted by its total attempts spread evenly over
 * the levels it was headed through, the best that can be said of it.
 * @param {Object} leg - Leg record
 * @param {number} level - Level the attempts started from
 * @returns {number}
 */
function legWeight(leg, level) {
    if (leg.levelAttempts) return leg.levelAttempts[level] || 0;
    if (!(level >= leg.startLevel && level < leg.targetLevel)) return 0;
    return (leg.attempts || 0) / Math.max(1, leg.targetLevel - leg.startLevel);
}

/**
 * What a leg's own forecast expected it to take to climb from its start level to `level`:
 * `[attempts, protections]`, or null when its prediction does not say (a level outside the leg,
 * or a prediction stored without per-level expectations).
 * @param {Object} leg - Leg record with a prediction
 * @param {number} level - Level to reach
 * @returns {number[]|null}
 */
function legReach(leg, level) {
    const p = leg.predictions;
    if (level === leg.startLevel) return [0, 0];
    if (level === leg.targetLevel) {
        const attempts = Number.isFinite(p.expectedAttemptsExact) ? p.expectedAttemptsExact : p.expectedAttempts;
        const protections = Number.isFinite(p.expectedProtectionsExact)
            ? p.expectedProtectionsExact
            : p.expectedProtections || 0;
        return Number.isFinite(attempts) ? [attempts, protections] : null;
    }
    if (level > leg.startLevel && level < leg.targetLevel) {
        const part = p.levelExpectations?.[level];
        return Array.isArray(part) && Number.isFinite(part[0]) ? [part[0], part[1] || 0] : null;
    }
    return null;
}

/**
 * The furthest level a session's climb got to: where it stands, the highest level it ever made an
 * attempt from (it had to be there), or one past (two past, for a Blessed success) the highest level
 * it succeeded from. A failure can leave the item below any of these.
 * @param {Object} session - Session object
 * @returns {number}
 */
function furthestLevel(session) {
    let peak = Number.isFinite(session.currentLevel) ? session.currentLevel : 0;
    for (const [key, data] of Object.entries(session.attemptsPerLevel || {})) {
        const level = Number(key);
        const attempted = (data.success || 0) + (data.fail || 0) > 0;
        if (attempted) peak = Math.max(peak, level);
        if ((data.success || 0) > 0) peak = Math.max(peak, level + ((data.blessed || 0) > 0 ? 2 : 1));
    }
    return peak;
}

/**
 * Predicted success rate per level for a multi-leg session: each leg's own predicted rate at the
 * level (made on the stats the player had for it), averaged with the attempts each leg made at that
 * level as weights. A level no leg made attempts at takes the latest leg's rate.
 * @param {Array<Object>} legs - Legs that carry a prediction
 * @returns {Object<number, {actualRate: number, legs: number}>} Percent, keyed by the level the
 *   attempt starts from (the shape the per-level table reads off a single prediction)
 */
function weightedSuccessRates(legs) {
    const rates = {};
    for (let level = 0; level < 20; level++) {
        let weighted = 0;
        let weight = 0;
        let latest = null;
        let count = 0;
        for (const leg of legs) {
            const rate = leg.predictions.successRates?.[level]?.actualRate;
            if (!Number.isFinite(rate)) continue;
            latest = rate;
            const w = legWeight(leg, level);
            if (w > 0) {
                weighted += w * rate;
                weight += w;
                count++;
            }
        }
        if (weight > 0) rates[level] = { actualRate: weighted / weight, legs: count };
        else if (latest !== null) rates[level] = { actualRate: latest, legs: 0 };
    }
    return rates;
}

/**
 * Expected attempts and protections to climb the merged session's path, built step by step. Each
 * step (+L-1 to +L) is averaged over the legs whose forecast covers it, as that leg's expectation
 * of reaching +L less its expectation of reaching +L-1 (first passages add), weighted by the
 * attempts the leg made at +L-1. The path runs from the session's start level to its target, or
 * to the furthest level it got to when it stopped short, so the actual attempts are read against
 * the climb that was made.
 * @param {Object} session - Session object
 * @param {Array<Object>} legs - Legs that carry a prediction
 * @returns {{expectedAttempts: number, expectedProtections: number, fromLevel: number,
 *   toLevel: number}|null} Null when some step is covered by no leg's forecast
 */
function expectedPath(session, legs) {
    const fromLevel = session.startLevel;
    const toLevel = Math.min(session.targetLevel, furthestLevel(session));
    if (!Number.isFinite(fromLevel) || !(toLevel > fromLevel)) return null;
    let attempts = 0;
    let protections = 0;
    for (let level = fromLevel + 1; level <= toLevel; level++) {
        const steps = [];
        for (const leg of legs) {
            const to = legReach(leg, level);
            const from = legReach(leg, level - 1);
            if (!to || !from) continue;
            steps.push({
                attempts: Math.max(0, to[0] - from[0]),
                protections: Math.max(0, to[1] - from[1]),
                weight: legWeight(leg, level - 1),
            });
        }
        if (steps.length === 0) return null;
        const totalWeight = steps.reduce((sum, step) => sum + step.weight, 0);
        for (const step of steps) {
            const share = totalWeight > 0 ? step.weight / totalWeight : 1 / steps.length;
            attempts += step.attempts * share;
            protections += step.protections * share;
        }
    }
    return { expectedAttempts: Math.round(attempts), expectedProtections: Math.round(protections), fromLevel, toLevel };
}

/**
 * The combined forecast of a session that ran in several predicted legs (merged, resumed under
 * changed stats, or extended), rebuilt from what each leg recorded when it was predicted:
 *
 * - `successRates`: predicted success rate per level, each leg's rate weighted by the attempts it
 *   made at that level.
 * - `expected`: expected attempts and protections for the whole climb, from the start level to the
 *   target (see `expectedPath`), else, for legs recorded without per-level expectations, the sum of
 *   each leg over the stretch it covered ({@link summedLegPredictions}); null when neither can be
 *   read honestly. `basis` says which.
 *
 * It is a display figure only: it is never stored and never used for calibration.
 * @param {Object} session - Session object
 * @returns {{legs: number, successRates: Object<number, {actualRate: number, legs: number}>,
 *   expected: {expectedAttempts: number, expectedProtections: number, basis: string,
 *   fromLevel?: number, toLevel?: number}|null}|null} Null for a session with no leg forecast
 */
export function mergedExpectation(session) {
    if (!hasPredictionLegs(session)) return null;
    const allLegs = legsOf(session);
    const legs = allLegs.filter((leg) => leg.predictions);
    if (legs.length === 0) return null;
    // Every attempt the session made has to be under a leg that has a forecast; otherwise the
    // figures would leave a run out and read the whole session against the rest
    const covered = allLegs.reduce((sum, leg) => sum + (Number.isFinite(leg.attempts) ? leg.attempts : 0), 0);
    const complete =
        covered === (session.totalAttempts || 0) && allLegs.every((leg) => leg.predictions || !(leg.attempts > 0));
    let expected = null;
    if (complete) {
        const path = expectedPath(session, legs);
        expected = path ? { ...path, basis: 'path' } : null;
        if (!expected) {
            const summed = summedLegPredictions(session);
            if (summed) {
                expected = {
                    expectedAttempts: summed.expectedAttempts,
                    expectedProtections: summed.expectedProtections,
                    basis: 'stretch',
                };
            }
        }
    }
    // A level's rate is shown only where every leg that made attempts there has a forecast; with
    // attempts outside every leg's record nothing can be said of any level
    const unforecast = allLegs.filter((leg) => !leg.predictions);
    const successRates = covered === (session.totalAttempts || 0) ? weightedSuccessRates(legs) : {};
    for (const level of Object.keys(successRates)) {
        if (unforecast.some((leg) => legWeight(leg, Number(level)) > 0)) delete successRates[level];
    }
    return { legs: legs.length, successRates, expected };
}

/**
 * What a completed session hands calibration, or null when it must not be recorded.
 *
 * A merged session is several runs, each made on the stats the player had at the time; their
 * combined attempts are no draw from any one predicted distribution, so it is not recorded. (Each
 * run's own prediction is kept in `legPredictions`; nothing composes them.) A later extension
 * starts a new leg with one setup and its own prediction (`extensionBaseline` set), and that leg
 * is recorded as usual.
 * @param {Object} session - A completed session (a snapshot; not mutated)
 * @returns {Object|null} The session as calibration should read it
 */
export function calibrationObservation(session) {
    if (!session) return null;
    if (session.mergedFrom?.length > 0 && (!session.extensionBaseline || session.mergedLiveLeg)) return null;
    return session;
}

/**
 * Calculate success rate for a specific level
 * @param {Object} session - Session object
 * @param {number} level - Enhancement level
 * @returns {number} Success rate percentage (0-100)
 */
export function getLevelSuccessRate(session, level) {
    const attempts = session.attemptsPerLevel[level];
    if (!attempts) return 0;

    const total = attempts.success + attempts.fail;
    if (total === 0) return 0;

    return (attempts.success / total) * 100;
}

/**
 * Calculate overall success rate
 * @param {Object} session - Session object
 * @returns {number} Success rate percentage (0-100)
 */
export function getOverallSuccessRate(session) {
    if (session.totalAttempts === 0) return 0;
    return (session.totalSuccesses / session.totalAttempts) * 100;
}

/**
 * Get total attempts for a specific level
 * @param {Object} session - Session object
 * @param {number} level - Enhancement level
 * @returns {number} Total attempts
 */
export function getLevelAttempts(session, level) {
    const attempts = session.attemptsPerLevel[level];
    if (!attempts) return 0;
    return attempts.success + attempts.fail;
}

/**
 * Finalize session (mark as completed)
 * @param {Object} session - Session object
 * @param {number} [endTime] - When the run ended, when that was not now
 */
export function finalizeSession(session, endTime = Date.now()) {
    session.state = SessionState.COMPLETED;
    session.endTime = endTime;
}

/**
 * Archive session (mark as read-only historical data)
 * @param {Object} session - Session object
 */
export function archiveSession(session) {
    session.state = SessionState.ARCHIVED;
    if (!session.endTime) {
        session.endTime = Date.now();
    }
}

/**
 * Check if session matches given item and level criteria (for resume logic)
 * @param {Object} session - Session object
 * @param {string} itemHrid - Item HRID
 * @param {number} currentLevel - Current enhancement level
 * @param {number} targetLevel - Target level
 * @param {number} protectFrom - Protection level
 * @returns {boolean} True if session matches
 */
export function sessionMatches(session, itemHrid, currentLevel, targetLevel, protectFrom = 0) {
    // Must be same item
    if (session.itemHrid !== itemHrid) return false;

    // Can only resume tracking sessions (not completed/archived)
    if (session.state !== SessionState.TRACKING) return false;

    // Must match protection settings exactly (Ultimate Tracker requirement)
    if (session.protectFrom !== protectFrom) return false;

    // Must match target level exactly (Ultimate Tracker requirement)
    if (session.targetLevel !== targetLevel) return false;

    // Must match current level (with small tolerance for out-of-order events)
    const levelDiff = Math.abs(session.currentLevel - currentLevel);
    if (levelDiff <= 1) {
        return true;
    }

    return false;
}

/**
 * Check if a completed session can be extended
 * @param {Object} session - Session object
 * @param {string} itemHrid - Item HRID
 * @param {number} currentLevel - Current enhancement level
 * @param {Object|null} [action] - Queue action now running, when known
 * @returns {boolean} True if session can be extended
 */
export function canExtendSession(session, itemHrid, currentLevel, action = null) {
    // Must be same item
    if (session.itemHrid !== itemHrid) return false;

    // Must be completed
    if (session.state !== SessionState.COMPLETED) return false;

    if (action) {
        const lastActionId = session.lastAttempt?.actionId;
        const sameAction = lastActionId != null && action.id != null && lastActionId === action.id;
        if (!sameAction) {
            // A different queue action can extend a completed climb only when
            // the old target was reached and the new target is higher. A run
            // canceled below target is its own attempt, even at the same level.
            if (!(session.currentLevel >= session.targetLevel && action.enhancingMaxLevel > session.targetLevel)) {
                return false;
            }
        }
    }

    // Current level should match where session ended (or close)
    const levelDiff = Math.abs(session.currentLevel - currentLevel);
    if (levelDiff <= 1) {
        return true;
    }

    return false;
}

/**
 * Extend a completed session to a new target level
 *
 * The predictions are recomputed for the new leg (+10 → +12, say), but the attempt and
 * protection counters keep running from the whole session. Comparing one against the other
 * makes the run look wildly over budget, so snapshot the counters here and let the display
 * diff against them.
 *
 * @param {Object} session - Session object
 * @param {number} newTargetLevel - New target level
 * @param {number} [now] - Epoch ms
 */
export function extendSession(session, newTargetLevel, now = Date.now()) {
    // The target changes, so the old prediction describes a finished leg; the caller computes the
    // extension's own
    bankCurrentLeg(session);
    session.predictions = null;
    // A new run on this session: its stretch starts now, not at the session's start
    startNewSegment(session, now);
    session.state = SessionState.TRACKING;
    session.targetLevel = newTargetLevel;
    session.endTime = null;
    session.lastUpdateTime = now;
    session.extensionBaseline = {
        totalAttempts: session.totalAttempts || 0,
        protectionCount: getProtectionUsage(session).count,
        protectionCountExcludesMirrors: true,
    };
}

/**
 * Get attempts and protections accrued since the session was last extended.
 * A session that was never extended reports its full totals.
 * @param {Object} session - Session object
 * @returns {{attempts: number, protections: number|null}} Counters for the current leg.
 *   `protections` is null when it cannot be known: the baseline predates mirrors being kept apart
 *   (no `protectionCountExcludesMirrors` marker) and the session holds a mirror in its protection
 *   fields, so the baseline's share of mirrors is unknown
 */
export function getCurrentLegCounters(session) {
    const baseline = session?.extensionBaseline;
    const attempts = (session?.totalAttempts || 0) - (baseline?.totalAttempts || 0);
    const protections = getProtectionUsage(session).count - (baseline?.protectionCount || 0);

    const unknown =
        baseline != null && baseline.protectionCountExcludesMirrors !== true && getMirrorUsage(session).legacyCount > 0;

    return {
        attempts: Math.max(0, attempts),
        protections: unknown ? null : Math.max(0, protections),
    };
}

/**
 * Combine several sessions into one aggregate reading.
 *
 * Sums the counters, costs, XP and duration and re-derives the per-level tally
 * and overall rate, so runs of the same item split across sessions — or a mix of
 * items — read as one. The result is shaped like a session in the fields the
 * per-level and cost renderers touch (`id`, `attemptsPerLevel`, `materialCosts`,
 * the cost fields, `currentLevel`, `predictions`) so those views can be reused
 * as they are.
 *
 * Predictions are not merged: each describes a single leg's distribution and
 * they do not add, so the aggregate carries expected attempts/protections only
 * as plain sums for a rough factor, and `predictions` is left null so the
 * per-level table shows no misleading "Pred %" against a combined run.
 *
 * @param {Array<Object>} sessions - Sessions to combine
 * @returns {Object|null} Aggregate, or null for an empty list
 */
export function mergeSessions(sessions) {
    if (!Array.isArray(sessions) || sessions.length === 0) return null;

    const agg = {
        id: 'merged',
        merged: true,
        count: 0,
        itemHrids: [],
        itemNames: [],
        totalAttempts: 0,
        totalSuccesses: 0,
        totalFailures: 0,
        totalBlessed: 0,
        totalXP: 0,
        protectionCount: 0,
        protectionItemHrid: null,
        coinCost: 0,
        coinCount: 0,
        protectionCost: 0,
        mirrorCount: 0,
        mirrorCost: 0,
        totalCost: 0,
        durationSeconds: 0,
        currentLevel: 0,
        predictions: null,
        attemptsPerLevel: {},
        materialCosts: {},
        hasUnpricedInput: false,
        expectedAttempts: 0,
        expectedProtections: 0,
    };
    const seenItems = new Set();
    const protection = {};

    for (const session of sessions) {
        if (!session) continue;
        agg.count += 1;

        if (!seenItems.has(session.itemHrid)) {
            seenItems.add(session.itemHrid);
            agg.itemHrids.push(session.itemHrid);
            agg.itemNames.push(session.itemName);
        }

        agg.totalAttempts += session.totalAttempts || 0;
        agg.totalSuccesses += session.totalSuccesses || 0;
        agg.totalFailures += session.totalFailures || 0;
        agg.totalBlessed += session.totalBlessed || 0;
        agg.totalXP += session.totalXP || 0;
        const protections = getProtectionUsage(session);
        const mirrors = getMirrorUsage(session);
        agg.protectionCount += protections.count;
        agg.mirrorCount += mirrors.count;
        agg.mirrorCost += mirrors.cost;
        agg.coinCost += session.coinCost || 0;
        agg.coinCount += session.coinCount || 0;
        agg.protectionCost += protections.cost;
        agg.totalCost += session.totalCost || 0;
        agg.hasUnpricedInput ||= session.hasUnpricedInput === true;
        agg.durationSeconds += getSessionDuration(session);
        if (!agg.protectionItemHrid && session.protectionItemHrid) {
            agg.protectionItemHrid = session.protectionItemHrid;
        }
        for (const [hrid, entry] of Object.entries(protections.breakdown)) {
            const into = (protection[hrid] ||= { count: 0, totalCost: 0 });
            into.count += entry.count || 0;
            into.totalCost += entry.totalCost || 0;
        }

        for (const [level, tally] of Object.entries(session.attemptsPerLevel || {})) {
            if (!agg.attemptsPerLevel[level]) {
                agg.attemptsPerLevel[level] = { success: 0, fail: 0, blessed: 0, successRate: 0 };
            }
            agg.attemptsPerLevel[level].success += tally.success || 0;
            agg.attemptsPerLevel[level].fail += tally.fail || 0;
            agg.attemptsPerLevel[level].blessed += tally.blessed || 0;
        }

        for (const [hrid, material] of Object.entries(session.materialCosts || {})) {
            if (!agg.materialCosts[hrid]) {
                agg.materialCosts[hrid] = { count: 0, totalCost: 0 };
            }
            agg.materialCosts[hrid].count += material.count || 0;
            agg.materialCosts[hrid].totalCost += material.totalCost || 0;
        }

        // The same figure the session's panel shows: a multi-leg session's legs summed (and
        // left out when that cannot be read), else its one prediction
        const expected = hasPredictionLegs(session) ? mergedExpectation(session)?.expected : session.predictions;
        if (expected) {
            agg.expectedAttempts += expected.expectedAttempts || 0;
            agg.expectedProtections += expected.expectedProtections || 0;
        }
    }

    for (const tally of Object.values(agg.attemptsPerLevel)) {
        const total = tally.success + tally.fail;
        tally.successRate = total > 0 ? tally.success / total : 0;
    }
    agg.successRate = agg.totalAttempts > 0 ? agg.totalSuccesses / agg.totalAttempts : 0;

    // Where the item stands now: the level of the most recently active session, so the
    // per-level table marks the row being worked on, the way the single-session view does.
    // Several items have no one level to mark.
    const present = sessions.filter(Boolean);
    agg.live = present.some((session) => session.state === SessionState.TRACKING);
    // Kept whenever it is not all the one item agg.protectionItemHrid names (that item could be a
    // legacy mirror), or the lone count would be synthesized under the wrong name
    const protectionItems = Object.keys(protection);
    if (
        protectionItems.length > 1 ||
        (protectionItems.length === 1 && protectionItems[0] !== (agg.protectionItemHrid || ''))
    ) {
        agg.protectionBreakdown = protection;
    }
    if (agg.itemHrids.length === 1) {
        const activity = (s) =>
            Math.max(s.endTime || 0, s.lastAttempt?.timestamp || 0, s.lastUpdateTime || 0, s.startTime || 0);
        const running = present.filter((session) => session.state === SessionState.TRACKING);
        const latest = (running.length > 0 ? running : present).reduce((a, b) => (activity(b) >= activity(a) ? b : a));
        agg.currentLevel = Number.isFinite(latest.currentLevel) ? latest.currentLevel : 0;
    }

    return agg;
}

/**
 * Validate session data integrity
 * @param {Object} session - Session object
 * @returns {boolean} True if valid
 */
export function validateSession(session) {
    if (!session || typeof session !== 'object') return false;

    // Required fields
    if (!session.id || !session.itemHrid || !session.itemName) return false;
    if (typeof session.startLevel !== 'number' || typeof session.targetLevel !== 'number') return false;
    if (typeof session.currentLevel !== 'number') return false;

    // Validate level ranges
    if (session.startLevel < 0 || session.startLevel > 20) return false;
    if (session.targetLevel < 1 || session.targetLevel > 20) return false;
    if (session.currentLevel < 0 || session.currentLevel > 20) return false;

    // Validate costs are non-negative
    if (session.totalCost < 0 || session.coinCost < 0 || session.protectionCost < 0) return false;

    return true;
}

/**
 * Normalize a session loaded from storage so older sessions (persisted before Blessed
 * tracking existed) read with an explicit 0 instead of undefined. Mutates in place.
 * @param {Object} session - Session object
 * @returns {Object} The same session, normalized
 */
export function normalizeSession(session) {
    if (typeof session.totalBlessed !== 'number') {
        session.totalBlessed = 0;
    }

    for (const levelData of Object.values(session.attemptsPerLevel || {})) {
        if (typeof levelData.blessed !== 'number') {
            levelData.blessed = 0;
        }
    }

    return session;
}
