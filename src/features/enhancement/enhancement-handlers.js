/**
 * Enhancement Event Handlers
 * Automatically detects and tracks enhancement events from WebSocket messages
 */

import webSocketHook from '../../core/websocket.js';
import dataManager from '../../core/data-manager.js';
import enhancementTracker from './enhancement-tracker.js';
import enhancementUI from './enhancement-ui.js';
import config from '../../core/config.js';
import marketAPI from '../../api/marketplace.js';
import { calculateSuccessXP, calculateFailureXP, calculateAdjustedAttemptCount } from './enhancement-xp.js';
import { getEnhancementMaterialPrice } from './tooltip-enhancement.js';
import { parseItemHash } from '../../utils/item-hash.js';
import { runningAction } from '../../utils/combat-actions.js';
import { ironCowBook } from '../../utils/ironcow-valuation.js';
import { SessionState, getCurrentLegCounters } from './enhancement-session.js';

// Id of the queue action the tracker last saw running as the enhance row. Read against
// dataManager's merged queue in handleActionsUpdated so a second enhance queued behind the
// running one (present in the delta, not yet running) is never mistaken for a switch or a stop.
let trackedEnhanceActionId = null;

const ENHANCE_ACTION_HRID = '/actions/enhancing/enhance';
const PHILOSOPHERS_MIRROR_HRID = '/items/philosophers_mirror';

// The level the running enhance stood at before its next attempt, read off the queue row
// (actions_updated, or the login snapshot) — { actionId, itemHrid, level, currentCount }.
//
// An action_completed carries only the level the attempt ended at. From that alone the level
// it started at cannot be told: +6 is a success from +5, a protected failure from +7, or a
// Blessed jump from +4, and +0 is a failure from anywhere. The queue row seen before the
// attempt says exactly where it started.
let pendingBaseline = null;

/**
 * The baseline a queue row gives the attempt that follows it.
 * @param {Object} action - Enhance row from the queue
 * @returns {Object|null} Baseline, or null when the row names no item
 */
function baselineFrom(action) {
    const { itemHrid, level } = parseItemHash(action?.primaryItemHash);
    if (!itemHrid) return null;
    return {
        actionId: action.id ?? null,
        itemHrid,
        level,
        currentCount: Number.isFinite(action.currentCount) ? action.currentCount : null,
    };
}

/**
 * Take the pending baseline for this attempt, if it describes it: the same item, the same
 * queue action, and the count just before this one. Consumed either way.
 * @param {Object} action - endCharacterAction of the attempt
 * @param {string} itemHrid - Item being enhanced
 * @returns {number|null} The level the attempt started from, or null when unknown
 */
function takeBaseline(action, itemHrid) {
    const baseline = pendingBaseline;
    pendingBaseline = null;
    if (!baseline || baseline.itemHrid !== itemHrid) return null;
    if (baseline.actionId != null && action.id != null && baseline.actionId !== action.id) return null;
    if (
        baseline.currentCount != null &&
        Number.isFinite(action.currentCount) &&
        action.currentCount !== baseline.currentCount + 1
    ) {
        return null;
    }
    return baseline.level;
}

/**
 * Setup enhancement event handlers
 */
export function setupEnhancementHandlers() {
    // A fresh setup re-derives this from scratch via the bootstrap below rather than carrying
    // over a stale id from whatever ran before it (a previous character, or a prior setup/
    // cleanup cycle within the same one).
    trackedEnhanceActionId = null;
    pendingBaseline = null;

    // Listen for action_completed (when enhancement completes)
    webSocketHook.on('action_completed', handleActionCompleted);

    // Listen on dataManager rather than the raw socket: dataManager merges the actions_updated
    // delta into the full queue before re-emitting, so by the time this fires
    // dataManager.getCurrentActions() already reflects the merge (see handleActionsUpdated).
    dataManager.on('actions_updated', handleActionsUpdated);

    // TLA-043 Layer A: handlers are registered above FIRST so a completion can never land in a
    // gap between subscribing and inspecting current state. Only now do we check DataManager's
    // already-cached current action for an Enhance queue that was already running before these
    // handlers existed (setting enabled mid-run, page reload, or character switch).
    bootstrapFromCurrentEnhancingAction();
}

/**
 * TLA-043 Layer A of the mid-run bootstrap: if Enhancing is already the running action per
 * DataManager's cached current-character actions and there is no session yet, arm the same
 * pendingSessionStart flag a live actions_updated would have set, so the next action_completed
 * creates a session regardless of currentCount. Does not backfill history from the cached action.
 * Uses runningAction() (execution order, lowest ordinal) rather than array position — a requeued
 * repeat sits first in the queue with a higher ordinal, so positional reads pick the wrong entry.
 */
function bootstrapFromCurrentEnhancingAction() {
    if (!config.getSetting('enhancementTracker')) return;
    if (!enhancementTracker.isInitialized) return;

    const activeEnhancingAction = runningAction(
        dataManager.getCurrentActions(),
        (action) => action.actionHrid === ENHANCE_ACTION_HRID
    );

    // A session left in progress whose run is no longer the one going ended while no page was
    // connected (target reached, materials or protection run out, stopped from another device).
    // No actions_updated will ever say so: close it now, at its last recorded attempt, rather
    // than leave it open until some later run finalizes it with that later moment as its end —
    // which stretched its duration and its gold-sources day span over the idle gap. Only
    // against a loaded character: an empty queue before the snapshot lands means nothing.
    //
    // The same item is not the same run: a new queue action for it (a different id than the
    // session's last attempt) is a run started after the stored one ended.
    let currentSession = enhancementTracker.getCurrentSession();
    let closedEndedRun = false;
    const sameRun = isSameRun(currentSession, activeEnhancingAction);
    if (currentSession && currentSession.state === SessionState.TRACKING && dataManager.characterData && !sameRun) {
        // The last attempt seen: lastUpdateTime moves only on a scored one, lastAttempt on any
        const lastSeen = Math.max(currentSession.lastUpdateTime || 0, currentSession.lastAttempt?.timestamp || 0);
        void enhancementTracker.finalizeCurrentSession(lastSeen || currentSession.startTime);
        currentSession = null;
        closedEndedRun = true;
    }

    if (!activeEnhancingAction) return;

    // The snapshot is the level the item stands at now, after anything that completed while no
    // page was connected — the one baseline the next live attempt can be scored against.
    pendingBaseline = baselineFrom(activeEnhancingAction);

    if (currentSession) {
        trackedEnhanceActionId = activeEnhancingAction.id;
        void reconcileReloadGap(currentSession, activeEnhancingAction);
        return;
    }

    // A completed session for this item near this level is meant to be picked back up by
    // extending it (see findExtendableSession below in handleEnhancementResult), not shadowed by
    // a brand-new one — the same failure mode enhancement-tracker.js's disable() already guards
    // against for a character switch that lands with pendingSessionStart still set. Leave that
    // case alone here too; the next action_completed still finds and extends it on its own.
    // Not the run just closed as ended, though: it is the same item near the same level, and
    // extending it would fold the new run into the old one after all.
    const { itemHrid, level } = parseItemHash(activeEnhancingAction.primaryItemHash);
    if (!closedEndedRun && itemHrid && enhancementTracker.findExtendableSession(itemHrid, level)) return;

    enhancementTracker.setPendingStart();
    trackedEnhanceActionId = activeEnhancingAction.id;
}

/**
 * Whether the running enhance in a snapshot is the run a stored session was recording.
 *
 * The queue action id settles it when both sides have one. A session saved before attempts
 * carried their action id has none, and a missing id is unknown, not a match: the run is then
 * the same only if everything else the snapshot says agrees — the same target and protect-from
 * levels, a count no lower than the attempts this leg recorded (a new action counts from zero),
 * and, when both sides carry a count, a level reachable from the session's in that many
 * attempts (at most +2 each, with Blessed Tea).
 * @param {Object|null} session - The tracker's current session
 * @param {Object|null} active - The running enhance row from the snapshot
 * @returns {boolean}
 */
function isSameRun(session, active) {
    if (!session || !active) return false;
    const { itemHrid, level } = parseItemHash(active.primaryItemHash);
    if (itemHrid !== session.itemHrid) return false;

    const last = session.lastAttempt;
    if (last?.actionId != null && active.id != null) return last.actionId === active.id;

    if ((active.enhancingMaxLevel || 0) !== (session.targetLevel || 0)) return false;
    if ((active.enhancingProtectionMinLevel || 0) !== (session.protectFrom || 0)) return false;

    const count = Number.isFinite(active.currentCount) ? active.currentCount : null;
    if (count !== null && count < getCurrentLegCounters(session).attempts) return false;
    if (count !== null && Number.isFinite(last?.currentCount)) {
        const delta = count - last.currentCount;
        const from = Number.isFinite(last.level) ? last.level : session.currentLevel;
        if (delta < 0) return false;
        if (delta === 0 ? level !== from : level > from + 2 * delta) return false;
    }
    return true;
}

/**
 * A page that comes up on a session already in progress: the game kept enhancing while no page
 * was connected, and the attempt that completed in that gap was never delivered as an
 * action_completed — the login snapshot already includes it. When the snapshot is exactly one
 * attempt on from the last one recorded, on the same queue action, that attempt is known in
 * full (its start level is the one recorded, its end level the snapshot's) and is scored now.
 * A longer gap cannot be told apart attempt by attempt; the snapshot baseline still keeps the
 * next live attempt from being scored against the stale level.
 * @param {Object} session - The tracker's current session
 * @param {Object} active - The running enhance row from the snapshot
 * @returns {Promise<void>}
 */
async function reconcileReloadGap(session, active) {
    const { itemHrid, level } = parseItemHash(active.primaryItemHash);
    const last = session.lastAttempt;
    if (!itemHrid || session.itemHrid !== itemHrid || !last) return;
    if (last.actionId == null || last.actionId !== active.id) return;
    if (!Number.isFinite(last.currentCount) || !Number.isFinite(active.currentCount)) return;
    if (active.currentCount - last.currentCount !== 1) return;

    try {
        await applyAttempt({
            session,
            action: active,
            itemHrid,
            previousLevel: last.level,
            newLevel: level,
            scored: true,
        });
    } catch (error) {
        console.error('[EnhancementHandlers] Reconciling the reload gap failed:', error);
    }
}

/**
 * Handle actions_updated message (detects new enhancing queue)
 * Sets pendingSessionStart so the next action_completed creates a session regardless of currentCount.
 * @param {Object} data - WebSocket message data
 */
async function handleActionsUpdated(data) {
    if (!config.getSetting('enhancementTracker')) return;
    if (!enhancementTracker.isInitialized) return;

    const actions = data.endCharacterActions;
    if (!Array.isArray(actions)) return;
    // Decide from the merged queue (dataManager has already folded this delta into it before
    // emitting), not the delta rows — the delta lists only what changed, so a second enhance
    // queued behind the running one would otherwise be mistaken for the row actually running
    // and wrongly end the live session's stats/history.
    const enhancingAction = runningAction(
        dataManager.getCurrentActions(),
        (action) => action.actionHrid === ENHANCE_ACTION_HRID
    );

    // Nothing about enhancing changed — unless an enhance queued behind something else has just
    // come to the front. The delta then carries only the row that finished ahead of it, and
    // this is the one message that says the run has started (and at what level).
    const deltaHasEnhance = actions.some((a) => a?.actionHrid === ENHANCE_ACTION_HRID);
    if (!deltaHasEnhance && (!enhancingAction || enhancingAction.id === trackedEnhanceActionId)) return;

    if (enhancingAction && enhancingAction.id === trackedEnhanceActionId) {
        // Same run still executing (e.g. a differently-targeted enhance queued behind it) —
        // nothing to react to.
        return;
    }
    const previousActionId = trackedEnhanceActionId;
    trackedEnhanceActionId = enhancingAction?.id ?? null;
    pendingBaseline = enhancingAction ? baselineFrom(enhancingAction) : null;

    if (!enhancingAction) {
        // No enhance action is running anymore — a real stop.
        if (enhancementTracker.getCurrentSession()) {
            await enhancementTracker.finalizeCurrentSession();
        }
        return;
    }

    enhancementTracker.setPendingStart();

    // If the target level or protection level changed, finalize the current session so the
    // next action_completed starts a fresh one instead of continuing the old one.
    const currentSession = enhancementTracker.getCurrentSession();
    if (currentSession) {
        // A new queue id is a new run even when the player queues the same item with
        // the same target and protection settings again. Keep its attempts and XP separate.
        const runChanged =
            previousActionId != null && enhancingAction.id != null && previousActionId !== enhancingAction.id;
        const targetChanged = enhancingAction.enhancingMaxLevel !== currentSession.targetLevel;
        const protectionChanged =
            (enhancingAction.enhancingProtectionMinLevel || 0) !== (currentSession.protectFrom || 0);
        if (runChanged || targetChanged || protectionChanged) {
            await enhancementTracker.finalizeCurrentSession();
        }
    }
}

/**
 * Handle action_completed message (detects enhancement results)
 * @param {Object} data - WebSocket message data
 */
async function handleActionCompleted(data) {
    if (!config.getSetting('enhancementTracker')) return;
    if (!enhancementTracker.isInitialized) return;

    const action = data.endCharacterAction;
    if (!action) return;

    // Check if this is an enhancement action
    // Ultimate Enhancement Tracker checks: actionHrid === "/actions/enhancing/enhance"
    if (action.actionHrid !== ENHANCE_ACTION_HRID) {
        return;
    }

    // Handle the enhancement
    await handleEnhancementResult(action, data);
}

/**
 * Extract protection item HRID from action data
 * @param {Object} action - Enhancement action data
 * @returns {string|null} Protection item HRID or null
 */
function getProtectionItemHrid(action) {
    // Check if protection is enabled
    if (!action.enhancingProtectionMinLevel || action.enhancingProtectionMinLevel < 2) {
        return null;
    }

    // Extract protection item from secondaryItemHash (Ultimate Tracker method)
    if (action.secondaryItemHash) {
        const parts = action.secondaryItemHash.split('::');
        if (parts.length >= 3 && parts[2].startsWith('/items/')) {
            return parts[2];
        }
    }

    // Fallback: check if there's a direct enhancingProtectionItemHrid field
    if (action.enhancingProtectionItemHrid) {
        return action.enhancingProtectionItemHrid;
    }

    return null;
}

/**
 * Get enhancement materials and costs for an item
 * Based on Ultimate Enhancement Tracker's getEnhancementMaterials function
 * @param {string} itemHrid - Item HRID
 * @returns {Array|null} Array of [hrid, count] pairs or null
 */
function getEnhancementMaterials(itemHrid) {
    try {
        const gameData = dataManager.getInitClientData();
        const itemData = gameData?.itemDetailMap?.[itemHrid];

        if (!itemData) {
            return null;
        }

        // Get the costs array
        const costs = itemData.enhancementCosts;

        if (!costs) {
            return null;
        }

        let materials = [];

        // Case 1: Array of objects (current format)
        if (Array.isArray(costs) && costs.length > 0 && typeof costs[0] === 'object') {
            materials = costs.map((cost) => [cost.itemHrid, cost.count]);
        }
        // Case 2: Already in correct format [["/items/foo", 30], ["/items/bar", 20]]
        else if (Array.isArray(costs) && costs.length > 0 && Array.isArray(costs[0])) {
            materials = costs;
        }
        // Case 3: Object format {"/items/foo": 30, "/items/bar": 20}
        else if (typeof costs === 'object' && !Array.isArray(costs)) {
            materials = Object.entries(costs);
        }

        // Filter out any invalid entries
        materials = materials.filter(
            (m) => Array.isArray(m) && m.length === 2 && typeof m[0] === 'string' && typeof m[1] === 'number'
        );

        return materials.length > 0 ? materials : null;
    } catch {
        return null;
    }
}

/**
 * Track material costs for current attempt
 * Based on Ultimate Enhancement Tracker's trackMaterialCosts function
 * @param {string} itemHrid - Item HRID
 * @returns {Promise<void>}
 */
async function trackMaterialCosts(itemHrid) {
    const materials = getEnhancementMaterials(itemHrid) || [];

    for (const [resourceHrid, count] of materials) {
        if (resourceHrid.includes('/items/coin')) {
            await enhancementTracker.trackCoinCost(count);
        } else {
            await enhancementTracker.trackMaterialCost(resourceHrid, count);
        }
    }
}

/**
 * Price of one unit of an item at an enhancement level: the Iron Cow book, then the market's
 * ask, then its bid, then the vendor price.
 * @param {string} itemHrid - Item HRID
 * @param {number} level - Enhancement level
 * @returns {number} Unit price (0 when nothing prices it)
 */
function unitPrice(itemHrid, level = 0) {
    const marketPrice = ironCowBook(itemHrid, level) ?? marketAPI.getPrice(itemHrid, level);
    const price = marketPrice?.ask || marketPrice?.bid || 0;
    if (price > 0) return price;

    const item = dataManager.getInitClientData()?.itemDetailMap?.[itemHrid];
    if (!item) {
        console.warn(`[EnhancementHandlers] Item not found in game data: ${itemHrid}`);
    }
    return item?.sellPrice || 0;
}

/**
 * Whether the action's protection slot holds a Philosopher's Mirror.
 * @param {Object} action - Enhance action
 * @returns {boolean}
 */
function usesPhilosophersMirror(action) {
    // The loaded item's hash first; the configured field when the action carries no hash, the
    // same precedence getProtectionItemHrid and the queue display use
    const loaded = parseItemHash(action?.secondaryItemHash).itemHrid || action?.enhancingProtectionItemHrid || null;
    return loaded === PHILOSOPHERS_MIRROR_HRID;
}

/**
 * Charge one Philosopher's Mirror attempt. The game replaces the enhancement costs of a mirror
 * attempt with one copy of the base item at one level below the item, and the mirror itself is
 * consumed every attempt (game client: getPhilosophersMirrorCost, and the mirror's item
 * description). None of the item's normal materials or coins are spent.
 * @param {string} itemHrid - Item being enhanced
 * @param {number} fromLevel - Level the attempt started at
 * @returns {Promise<void>}
 */
async function trackMirrorCosts(itemHrid, fromLevel) {
    const baseHrid = dataManager.getInitClientData()?.itemDetailMap?.[itemHrid]?.baseItemHrids?.[0] || itemHrid;
    const copyLevel = Math.max(0, fromLevel - 1);
    const copyPrice = copyLevel === 0 ? getEnhancementMaterialPrice(baseHrid, 'ask') : unitPrice(baseHrid, copyLevel);
    await enhancementTracker.trackMaterialCost(baseHrid, 1, copyPrice);
    await enhancementTracker.trackProtectionCost(PHILOSOPHERS_MIRROR_HRID, unitPrice(PHILOSOPHERS_MIRROR_HRID));
}

/**
 * Charge and, when its start level is known, score one attempt against the session.
 *
 * The level baseline is claimed and handed on in one synchronous step at the top. websocket.js
 * calls handlers fire-and-forget — it never awaits the promise an async handler returns — so a
 * second action_completed runs while the first is still suspended on the cost writes below.
 * Reading lastAttempt after those awaits, and writing it after them too, let a slower handler
 * stamp its own older level over a newer one.
 *
 * Game rules (client guide text): a success raises the level by 1 (Blessed Tea: 2); a failure
 * resets it to 0, or, protected, drops it by exactly 1 and consumes one protection item.
 * Protection is effective from +2. A Philosopher's Mirror attempt always succeeds.
 *
 * @param {Object} p
 * @param {Object} p.session - The session the attempt belongs to (the tracker's current one)
 * @param {Object} p.action - The enhance action as it stood after the attempt
 * @param {string} p.itemHrid - Item being enhanced
 * @param {number|null} p.previousLevel - Level the attempt started at, null when unknown
 * @param {number} p.newLevel - Level the attempt ended at
 * @param {boolean} p.scored - False when the start level is not known: costs only
 * @returns {Promise<void>}
 */
async function applyAttempt({ session, action, itemHrid, previousLevel, newLevel, scored }) {
    session.lastAttempt = {
        attemptNumber: calculateAdjustedAttemptCount(session),
        level: newLevel,
        timestamp: Date.now(),
        actionId: action.id ?? null,
        currentCount: Number.isFinite(action.currentCount) ? action.currentCount : null,
    };

    const knownStart = scored && Number.isFinite(previousLevel);
    const mirror = usesPhilosophersMirror(action);
    // The mirror needs an item at +2 or higher; below that the attempt is an ordinary one.
    //
    // With no known start the result has to say it. The Blessed buff is "+2 instead of +1 on
    // enhancing success" and nothing in the client excludes a mirror success from it (the roll
    // is server-side), so a mirror result N came from N-1 or N-2. Only N >= 4 puts both at +2
    // or above, where the mirror certainly applied; the copy is then priced at the un-Blessed
    // reading. At N <= 3 a Blessed ordinary attempt from +1 fits too, and it stays ordinary.
    const mirrorFrom = knownStart ? previousLevel : newLevel >= 4 ? newLevel - 1 : -1;
    if (mirror && mirrorFrom >= 2) {
        await trackMirrorCosts(itemHrid, mirrorFrom);
    } else {
        await trackMaterialCosts(itemHrid);
    }

    if (!knownStart) {
        // Not scored — the level it started from is unknown, so it is no success or failure at
        // any level — but where the item now stands, and when that was seen, are known. Left
        // stale, the tile showed the pre-gap level, worth-it and gold sources valued the item
        // at it, and the extend guard compared a later run against it. Milestones stay as they
        // are: they record levels crossed, and the path to this one was not seen.
        session.currentLevel = newLevel;
        session.lastUpdateTime = Date.now();
        await enhancementTracker.saveSessions();
        enhancementUI.scheduleUpdate();
        return;
    }

    const wasSuccess = newLevel > previousLevel;
    // A failure resets to 0 or, protected, drops exactly one level. Level unchanged above 0 is
    // not an outcome the game produces — it means the baseline was wrong, so it is not scored.
    const wasFailure = newLevel < previousLevel || (previousLevel === 0 && newLevel === 0);
    const wasProtectedFailure = wasFailure && previousLevel >= 2 && newLevel === previousLevel - 1;

    if (wasProtectedFailure && !mirror) {
        const protectionItemHrid = getProtectionItemHrid(action);
        if (protectionItemHrid) {
            await enhancementTracker.trackProtectionCost(protectionItemHrid, unitPrice(protectionItemHrid));
        }
    }

    if (wasSuccess) {
        session.totalXP += calculateSuccessXP(previousLevel, itemHrid);
        await enhancementTracker.recordSuccess(previousLevel, newLevel, newLevel - previousLevel >= 2);
        enhancementUI.scheduleUpdate();
    } else if (wasFailure) {
        session.totalXP += calculateFailureXP(previousLevel, itemHrid);
        await enhancementTracker.recordFailure(previousLevel, newLevel);
        enhancementUI.scheduleUpdate();
    }
}

/**
 * Start a session for the attempt in hand.
 * @param {Object} action - endCharacterAction
 * @param {string} itemHrid - Item being enhanced
 * @param {number} newLevel - Level the attempt ended at
 * @param {number|null} baselineLevel - Level it started at, when known
 * @returns {Promise<Object|null>} The new session
 */
async function startSessionFor(action, itemHrid, newLevel, baselineLevel) {
    const protectFrom = action.enhancingProtectionMinLevel || 0;
    let startLevel = baselineLevel;
    if (startLevel == null) {
        // No queue row was seen before this attempt. Best guess only — the attempt is not
        // scored — so the session tile has a level to show: below the protection threshold a
        // non-zero result most likely came from one level down.
        startLevel = newLevel;
        if (newLevel > 0 && newLevel < Math.max(2, protectFrom)) {
            startLevel = newLevel - 1;
        }
    }
    const targetLevel = action.enhancingMaxLevel || Math.min(newLevel + 5, 20);
    const sessionId = await enhancementTracker.startSession(itemHrid, startLevel, targetLevel, protectFrom);
    enhancementUI.switchToSession(sessionId);
    enhancementUI.scheduleUpdate();
    return enhancementTracker.getCurrentSession();
}

/**
 * Handle enhancement result (success or failure)
 * @param {Object} action - Enhancement action data
 * @param {Object} _data - Full WebSocket message data
 */
async function handleEnhancementResult(action, _data) {
    try {
        const { itemHrid, level: newLevel } = parseItemHash(action.primaryItemHash);
        const rawCount = action.currentCount || 0;

        if (!itemHrid) {
            return;
        }

        // Taken first and synchronously, before anything below can yield to another attempt
        const baselineLevel = takeBaseline(action, itemHrid);

        let currentSession = enhancementTracker.getCurrentSession();
        let isNewSession = false;

        // A session for a different item ends here; this attempt starts the next one
        if (currentSession && currentSession.itemHrid !== itemHrid) {
            await enhancementTracker.finalizeCurrentSession();
            currentSession = await startSessionFor(action, itemHrid, newLevel, baselineLevel);
            if (!currentSession) return;
            isNewSession = true;
        }

        // On first attempt (rawCount === 1) OR after a clear/new-queue (pendingSessionStart),
        // start a session if none is active yet.
        if (!currentSession && (rawCount === 1 || enhancementTracker.pendingSessionStart)) {
            enhancementTracker.pendingSessionStart = false;
            currentSession = await startSessionFor(action, itemHrid, newLevel, baselineLevel);
            if (!currentSession) return;
            isNewSession = true;
        }

        // If no active session, check if we can extend a completed session
        if (!currentSession) {
            const extendableSessionId = enhancementTracker.findExtendableSession(itemHrid, baselineLevel ?? newLevel);
            if (extendableSessionId) {
                const newTarget = action.enhancingMaxLevel || Math.min(newLevel + 5, 20);
                await enhancementTracker.extendSessionTarget(extendableSessionId, newTarget);
                currentSession = enhancementTracker.getCurrentSession();

                enhancementUI.switchToSession(extendableSessionId);
                enhancementUI.scheduleUpdate();
            } else {
                // Mid-run pickup: the script came up after the queue started (a page load
                // during a run) with nothing flagging a pending start.
                enhancementTracker.pendingSessionStart = false;
                currentSession = await startSessionFor(action, itemHrid, newLevel, baselineLevel);
                if (!currentSession) return;
                isNewSession = true;
            }
        }
        if (!currentSession) return;

        // The level the attempt started from: the queue row seen just before it when there was
        // one, else the level the session's previous attempt ended at — provided that attempt
        // was the one just before this on the same queue action. A count that skipped ahead
        // means attempts completed unseen (a dropped connection), and the stored level is stale.
        let previousLevel = baselineLevel;
        if (previousLevel == null && !isNewSession) {
            const last = currentSession.lastAttempt;
            const skipped =
                last?.actionId != null &&
                action.id != null &&
                last.actionId === action.id &&
                Number.isFinite(last.currentCount) &&
                Number.isFinite(action.currentCount) &&
                action.currentCount - last.currentCount > 1;
            if (!skipped) previousLevel = last?.level ?? currentSession.startLevel;
        }

        await applyAttempt({
            session: currentSession,
            action,
            itemHrid,
            previousLevel,
            newLevel,
            scored: previousLevel != null,
        });
    } catch (error) {
        console.error('[EnhancementHandlers] Enhancement result handler failed:', error);
    }
}

/**
 * Cleanup event handlers
 */
export function cleanupEnhancementHandlers() {
    webSocketHook.off('action_completed', handleActionCompleted);
    dataManager.off('actions_updated', handleActionsUpdated);
    trackedEnhanceActionId = null;
    pendingBaseline = null;
}
