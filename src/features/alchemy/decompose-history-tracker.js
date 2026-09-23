/**
 * Decompose History Tracker
 * Records decompose sessions via WebSocket and persists to IndexedDB.
 *
 * Session lifecycle:
 * - Start: actions_updated with actionHrid === '/actions/alchemy/decompose'
 * - Result: action_completed with same actionHrid
 * - End: actions_updated with no decompose action, or different input item/enhancement level
 *
 * Result detection:
 * - `endCharacterItems` rows carry a stack's NEW absolute total, one row per
 *   changed stack — not one row per success. A message can cover a batch of
 *   efficiency procs, so the count delta on each decompose-output stack — not
 *   the number of rows — is what says how many successes it holds.
 * - Every decompose success yields every entry in the input's decomposeItems
 *   together, so each output row's delta is an independent estimate of the
 *   same success count; the largest of them is used rather than the sum,
 *   which would multiply-count one batch once per output item.
 * - Read against a baseline seeded from the inventory when the session starts
 *   from the queue, so the first message of a run is measured like every other
 * - Failure: no items from decomposeItems appear in endCharacterItems
 * - Incidental drops (essences, artisan's crates) are excluded
 *   because they are not listed in the input item's decomposeItems
 */

import config from '../../core/config.js';
import webSocketHook from '../../core/websocket.js';
import dataManager from '../../core/data-manager.js';
import { getItemPrice } from '../../utils/market-data.js';
import { createAlchemySessionStore, NO_CHARACTER } from './alchemy-session-store.js';
import { predictedSuccessStamp } from './alchemy-success-stamp.js';
import { createItemCountLedger, deltasByItem, seedLedgerFromInventory } from './alchemy-item-deltas.js';
import { recordCatalystUse } from './alchemy-catalyst-use.js';
import { runningAlchemyAction } from './alchemy-running-action.js';
import { mergeReloadSplitSessions, expandKeptSessions } from './alchemy-session-merge.js';
import { ALCHEMY_TRACKER_VERSION } from './alchemy-tracker-version.js';

const DECOMPOSE_ACTION_HRID = '/actions/alchemy/decompose';
const CATALYST_OF_DECOMPOSITION_HRID = '/items/catalyst_of_decomposition';
const PRIME_CATALYST_HRID = '/items/prime_catalyst';
const COIN_ITEM_HRID = '/items/coin';
const STORAGE_KEY = 'decomposeSessions';
/** What an enhanced item yields on top of its `decomposeItems` */
const ENHANCING_ESSENCE_HRID = '/items/enhancing_essence';

/**
 * Whether a message came over this character's current connection.
 * @param {Object} [context] - Delivery context from the WebSocket hook
 * @returns {boolean} False only when dataManager can tell the message is stale
 */
function isFromActiveSocket(context) {
    return typeof dataManager.isFromActiveSocket !== 'function' || dataManager.isFromActiveSocket(context);
}

/**
 * The two catalysts this tracker has always had a dedicated field for, kept
 * populated so the viewer and the gold attribution keep reading them. Any OTHER
 * catalyst is still recorded, under its own hrid in `catalystsUsed` — see
 * `alchemy-catalyst-use.js` for why an allowlist on its own records an unknown
 * catalyst as free.
 */
const LEGACY_CATALYST_FIELDS = {
    [CATALYST_OF_DECOMPOSITION_HRID]: 'catalystOfDecompositionUsed',
    [PRIME_CATALYST_HRID]: 'primeCatalystUsed',
};

/**
 * The sessions, one record per day rather than one array rewritten per action.
 * See `alchemy-session-store.js` for what that is worth.
 */
const sessionStore = createAlchemySessionStore(STORAGE_KEY, 'DecomposeHistoryTracker');

class DecomposeHistoryTracker {
    constructor() {
        this.isInitialized = false;
        this.characterId = null;
        this.activeSession = null; // Current in-progress session object
        // `endCharacterItems` rows carry a stack's NEW total, one row per
        // changed stack — not one row per success. A count delta is the only
        // thing in the message that scales with a batch.
        this.itemCounts = createItemCountLedger();
        // Items whose every stack the ledger was seeded with at session start
        this.seededHrids = new Set();
        // The queue action `lastCurrentCount` belongs to. A new action for the
        // same item — the next queued copy, or the player pressing Start again
        // — counts from its own zero.
        this.trackedActionId = null;
        this.lastCurrentCount = null;
        this.handlers = {
            actionsUpdated: () => this.handleActionsUpdated(),
            actionCompleted: (data, context) => this.handleActionCompleted(data, context),
            itemsUpdated: (data, context) => this.handleItemsUpdated(data, context),
            initCharacterData: () => this.handleReconnect(),
            characterInitialized: () => this.seedFromQueue(),
            characterSwitched: (data) => this.handleCharacterSwitched(data),
        };
    }

    /**
     * Whose sessions these are.
     * @returns {string} The character id, or the pre-login scope
     */
    getCharacterScope() {
        return this.characterId || NO_CHARACTER;
    }

    /**
     * Initialize the tracker
     */
    initialize() {
        if (this.isInitialized) {
            return;
        }

        if (!config.getSetting('alchemy_decomposeHistory')) {
            return;
        }

        this.isInitialized = true;
        this.characterId = dataManager.getCurrentCharacterId();

        // Subscribed on dataManager's re-emitted `actions_updated`, not the raw
        // websocket event: dataManager merges the delta into its cached queue
        // and only then re-emits, so `dataManager.getCurrentActions()` inside
        // `handleActionsUpdated` is guaranteed to already reflect this update.
        // Listening on the raw event instead would depend on registration
        // order between this tracker and dataManager's own websocket handler —
        // both listen for the same event name, and whichever registered first
        // runs first.
        dataManager.on('actions_updated', this.handlers.actionsUpdated);
        webSocketHook.on('action_completed', this.handlers.actionCompleted);
        webSocketHook.on('items_updated', this.handlers.itemsUpdated);
        webSocketHook.on('init_character_data', this.handlers.initCharacterData);
        dataManager.on('character_initialized', this.handlers.characterInitialized);
        dataManager.on('character_switched', this.handlers.characterSwitched);

        // A run already going when the page loads is picked up now, between
        // messages, so its first message is measured rather than floored
        this.seedFromQueue();
    }

    /**
     * Start a session from the queue if a decompose is running and none is open.
     *
     * Sound at any moment outside a message handler: dataManager writes a
     * message's inventory rows and its action's `currentCount` in the same
     * handler, so the cached pair always describes the same instant.
     *
     * @returns {Promise<void>}
     */
    async seedFromQueue() {
        try {
            if (!this.activeSession) await this.handleActionsUpdated();
        } catch (error) {
            console.error('[DecomposeHistoryTracker] Could not start a session from the queue:', error);
        }
    }

    /**
     * Keep the ledger's baselines on stacks something other than the action moved.
     *
     * Selling the essences on the market mid-run, or buying more, changes an
     * output stack between two `action_completed`s, and the next message's
     * delta would otherwise read that change as the action's doing.
     *
     * @param {Object} data - `items_updated` message
     * @param {Object} [context] - Delivery context from the WebSocket hook
     */
    handleItemsUpdated(data, context) {
        if (!this.activeSession || !isFromActiveSocket(context)) return;
        this.itemCounts.noteEach(data?.endCharacterItems || []);
    }

    /**
     * Disable the tracker.
     *
     * Async, and the session is awaited before anything else is torn down: an
     * unawaited `endSession()` resumed after `characterId` had been nulled and
     * `sessionStore.forget()` had run, so the record was saved under the
     * 'default' scope — over whatever was already there — while the forget
     * raced the load it was meant to cancel. `handleCharacterSwitched` has
     * always awaited it; this is the same order.
     *
     * @returns {Promise<void>}
     */
    async disable() {
        dataManager.off('actions_updated', this.handlers.actionsUpdated);
        webSocketHook.off('action_completed', this.handlers.actionCompleted);
        webSocketHook.off('items_updated', this.handlers.itemsUpdated);
        webSocketHook.off('init_character_data', this.handlers.initCharacterData);
        dataManager.off('character_initialized', this.handlers.characterInitialized);
        dataManager.off('character_switched', this.handlers.characterSwitched);

        if (this.activeSession) {
            await this.endSession();
        }

        sessionStore.forget();
        this.isInitialized = false;
        this.characterId = null;
    }

    /**
     * Handle actions_updated — detect session start or end.
     *
     * Reads the full queue (`dataManager.getCurrentActions()`) rather than the
     * `actions_updated` delta that triggered this call: the delta only lists
     * actions that changed, so it cannot say on its own whether the decompose
     * is still the one running. See `alchemy-running-action.js` for why, and
     * `initialize()` for why this is safe to read synchronously here.
     */
    async handleActionsUpdated() {
        const decomposeAction = runningAlchemyAction(dataManager.getCurrentActions(), DECOMPOSE_ACTION_HRID);

        if (decomposeAction) {
            const inputItemHrid = this.extractItemHrid(decomposeAction.primaryItemHash);
            const enhancementLevel = this.extractEnhancementLevel(decomposeAction.primaryItemHash);

            if (!inputItemHrid) {
                return;
            }

            // Read between messages, so the cached inventory and the action's
            // count are exactly what the next action_completed moves away from
            const baseline = {
                actionId: decomposeAction.id ?? null,
                currentCount: decomposeAction.currentCount,
                catalystHrid: this.extractItemHrid(decomposeAction.secondaryItemHash),
            };
            if (!this.activeSession) {
                // No active session — start one
                await this.startSession(inputItemHrid, enhancementLevel, Date.now(), baseline);
            } else if (
                this.activeSession.inputItemHrid !== inputItemHrid ||
                this.activeSession.enhancementLevel !== enhancementLevel
            ) {
                // Different item or enhancement level — end current session and start new one
                await this.endSession();
                await this.startSession(inputItemHrid, enhancementLevel, Date.now(), baseline);
            } else {
                // Same item and level, same session. A different action — the
                // next queued copy, or a restart with another catalyst or count
                // — counts from its own currentCount, and its catalyst needs a baseline
                this.activeSession.lastActivityTime = Date.now();
                if (baseline.actionId !== this.trackedActionId) this.rebaseline(baseline);
            }
        } else if (this.activeSession) {
            // No decompose action in the update — end any active session
            await this.endSession();
        }
    }

    /**
     * Handle action_completed — record one attempt result
     * @param {Object} data - WebSocket message data
     * @param {Object} [context] - Delivery context from the WebSocket hook
     */
    async handleActionCompleted(data, context) {
        const action = data.endCharacterAction;
        if (!action || action.actionHrid !== DECOMPOSE_ACTION_HRID) {
            return;
        }
        // A message from a connection that is no longer this character's
        if (!isFromActiveSocket(context)) return;

        const inputItemHrid = this.extractItemHrid(action.primaryItemHash);
        const enhancementLevel = this.extractEnhancementLevel(action.primaryItemHash);

        if (!inputItemHrid) {
            return;
        }

        // Ensure we have an active session for this item and level
        if (
            !this.activeSession ||
            this.activeSession.inputItemHrid !== inputItemHrid ||
            this.activeSession.enhancementLevel !== enhancementLevel
        ) {
            await this.startSession(inputItemHrid, enhancementLevel, Date.now(), null, action);
        }
        const session = this.activeSession;
        session.lastActivityTime = Date.now();

        const itemDetails = dataManager.getItemDetails(inputItemHrid);
        const bulkMultiplier = itemDetails?.alchemyDetail?.bulkMultiplier ?? 1;

        // Build a Set of valid output HRIDs from the input item's decompose items.
        // This filters out incidental drops (essences, artisan's crates).
        const decomposeItems = itemDetails?.alchemyDetail?.decomposeItems || [];
        const validOutputHrids = new Set(decomposeItems.map((entry) => entry.itemHrid));

        // Build a map of expected count per output for value calculation
        const expectedCountMap = {};
        for (const entry of decomposeItems) {
            expectedCountMap[entry.itemHrid] = entry.count || 1;
        }

        // Every row is noted so the ledger has a baseline for next time; only
        // the drop-table rows say anything about what this action produced.
        //
        // `noteEach` folds a message's repeated snapshots of one stack down to
        // the last of them, so each entry here is one stack's whole change over
        // the batch rather than one step of it.
        const noted = this.itemCounts.noteEach(data.endCharacterItems || []);
        const outputRows = noted.filter(
            ({ row }) => row.itemHrid !== COIN_ITEM_HRID && validOutputHrids.has(row.itemHrid)
        );

        // Every decompose success yields every entry in decomposeItems
        // together, so each output row's own delta is an independent estimate
        // of the same success count — the largest is used rather than the
        // sum, which would multiply-count one batch once per output item. An
        // item with no baseline (the first message of a session that did not
        // start from the queue) reads as "at least one".
        let successCount = 0;
        for (const [outputItemHrid, delta] of deltasByItem(outputRows, this.seededHrids)) {
            const expectedCount = expectedCountMap[outputItemHrid] || 1;
            const perActionYield = bulkMultiplier * expectedCount;
            let actions;
            if (delta === null) {
                actions = 1;
            } else if (perActionYield > 0) {
                actions = Math.round(delta / perActionYield);
            } else {
                actions = 0;
            }
            successCount = Math.max(successCount, actions);
        }

        // Derive actual attempt count from currentCount delta (handles batched
        // efficiency procs). A count left by another action says nothing about this one.
        const currentCount = action.currentCount || 0;
        if (action.id !== undefined && action.id !== this.trackedActionId) {
            if (this.trackedActionId !== null) this.lastCurrentCount = null;
            this.trackedActionId = action.id;
        }
        let attemptCount;
        if (this.lastCurrentCount !== null && currentCount > this.lastCurrentCount) {
            attemptCount = currentCount - this.lastCurrentCount;
        } else {
            // No baseline: at least one attempt, and at least the successes
            // seen. Not one per output row — one success yields every output.
            attemptCount = Math.max(successCount, 1);
        }
        this.lastCurrentCount = currentCount;

        successCount = Math.min(Math.max(successCount, 0), attemptCount);

        session.totalAttempts += attemptCount;

        if (successCount > 0) {
            session.totalSuccesses += successCount;

            for (const entry of decomposeItems) {
                // Each success hands over bulkMultiplier × expectedCount items
                this.addResult(session, entry.itemHrid, successCount * bulkMultiplier * (entry.count || 1));
            }

            this.recordEnhancingEssence(session, enhancementLevel, validOutputHrids, noted);
        }

        // What the slot actually spent — whatever catalyst is in it, measured
        // from its own stack where the message gives a baseline to measure
        // against. No success guard: a failure shows as a zero decrement, and
        // where there is no baseline the success count is the fallback anyway.
        const catalystHrid = this.extractItemHrid(action.secondaryItemHash);
        recordCatalystUse(session, {
            catalystHrid,
            noted,
            successCount,
            attemptCount,
            legacyFields: LEGACY_CATALYST_FIELDS,
            stackKnown: this.seededHrids.has(catalystHrid),
        });

        await this.saveSession(session);
    }

    /**
     * Add received items to a session's results, priced now.
     *
     * `null` from the market means the item cannot be priced at all — folding
     * that into the total as 0 would report "earned nothing" for "could not tell
     * what this was worth", so the tick is excluded from totalValue and the
     * result is marked unpriced instead. Sticky across the session: once any
     * tick could not be priced, the total stays incomplete.
     *
     * @param {Object} session - The session, mutated
     * @param {string} outputItemHrid - The item received
     * @param {number} received - How many
     */
    addResult(session, outputItemHrid, received) {
        if (!session.results[outputItemHrid]) {
            session.results[outputItemHrid] = {
                count: 0,
                totalValue: 0,
                priceEach: 0,
                unpriced: false,
            };
        }
        const result = session.results[outputItemHrid];
        result.count += received;

        const price = getItemPrice(outputItemHrid, { context: 'profit', side: 'sell' });
        if (price === null) {
            result.unpriced = true;
        } else {
            result.priceEach = price;
            result.totalValue += price * received;
        }
    }

    /**
     * Record the Enhancing Essence an enhanced item's decompose yields.
     *
     * It is not in `decomposeItems` — the amount scales with the enhancement
     * level — so the output filter above never sees it, and a +10 decompose
     * whose essence is most of its value was recorded as if it yielded only
     * the base outputs. Read from the essence stack's own delta, and only where
     * the ledger has a baseline for it: with none, the gain cannot be told apart
     * from the stack's whole total.
     *
     * @param {Object} session - The session, mutated
     * @param {number} enhancementLevel - The input's enhancement level
     * @param {Set<string>} validOutputHrids - The item's `decomposeItems`
     * @param {Array<{row: Object, delta: number|null}>} noted - The folded ledger entries
     */
    recordEnhancingEssence(session, enhancementLevel, validOutputHrids, noted) {
        if (!(enhancementLevel > 0) || validOutputHrids.has(ENHANCING_ESSENCE_HRID)) return;
        const entries = noted.filter(({ row }) => row.itemHrid === ENHANCING_ESSENCE_HRID);
        const gained = deltasByItem(entries, this.seededHrids).get(ENHANCING_ESSENCE_HRID) ?? null;
        if (gained === null || gained <= 0) return;
        this.addResult(session, ENHANCING_ESSENCE_HRID, gained);
    }

    /**
     * Handle reconnect — finalize any open session
     */
    async handleReconnect() {
        if (this.activeSession) {
            await this.endSession();
        }
    }

    /**
     * Handle character switch — update character ID and clear active session
     * @param {Object} data - { newId, newName }
     */
    async handleCharacterSwitched(data) {
        if (this.activeSession) {
            await this.endSession();
        }
        sessionStore.forget();
        this.characterId = data.newId || null;
    }

    /**
     * Start a new session
     * @param {string} inputItemHrid - Input item HRID
     * @param {number} enhancementLevel - Enhancement level of input item
     * @param {number} timestamp - Start timestamp in ms
     * @param {{actionId: *, currentCount: number, catalystHrid: string|null}|null} [baseline] - Present
     *   only when the session starts from the queue, between messages, so the
     *   cached inventory and the action's count predate every message it will read
     * @param {Object|null} [action] - The message's action, when the session
     *   starts from an `action_completed` instead
     */
    async startSession(inputItemHrid, enhancementLevel, timestamp, baseline = null, action = null) {
        // Recorded, not recomputed at read time: the coin fee that was actually
        // billed scales with the bulk size the item had while the session ran,
        // and a later game change to that number would otherwise silently
        // restate every past session's profit.
        const itemDetails = dataManager.getItemDetails(inputItemHrid);
        // Taken now, for the same reason the bulk multiplier is: the model that
        // predicted this run is the one it has to be judged against, and the
        // tea, catalyst and level penalty behind it will all have moved by the
        // time the record is read. Unstamped sessions are excluded, never
        // retro-stamped.
        const stamp = predictedSuccessStamp('decompose', inputItemHrid, timestamp, this.stampOptions(baseline, action));
        this.activeSession = {
            id: `decompose_${timestamp}`,
            startTime: timestamp,
            // Which counting rules produced this record; see alchemy-tracker-version.js
            trackerVersion: ALCHEMY_TRACKER_VERSION,
            // The last moment this run was seen acting. A multi-day AFK grind
            // is one session, and the gold attribution spreads its net over
            // [startTime, lastActivityTime] rather than dropping the lot on the
            // day it began. Sessions recorded before this field existed have
            // none, and are read as their start instant — exactly as before.
            lastActivityTime: timestamp,
            inputItemHrid,
            enhancementLevel,
            totalAttempts: 0,
            totalSuccesses: 0,
            catalystOfDecompositionUsed: 0,
            primeCatalystUsed: 0,
            // What was actually spent, hrid → count, recorded per message as the
            // run goes. Kept ALONGSIDE the two fields above rather than
            // replacing them: they are what stored sessions and the existing
            // readers have. This record is the one that can hold a catalyst
            // nobody listed.
            catalystsUsed: {},
            bulkMultiplier: itemDetails?.alchemyDetail?.bulkMultiplier ?? 1,
            predictedRate: stamp?.predictedRate ?? null,
            predictedAt: stamp?.predictedAt ?? null,
            predictedCatalystHrid: stamp?.predictedCatalystHrid ?? null,
            results: {},
        };
        this.itemCounts.reset();
        this.seededHrids = new Set();
        this.lastCurrentCount = null;
        this.trackedActionId = baseline ? baseline.actionId : (action?.id ?? null);
        if (baseline) this.rebaseline(baseline);
    }

    /**
     * The catalyst the run is actually played with, for the success stamp.
     * @param {{catalystHrid: string|null}|null} baseline - The queued action's slots
     * @param {Object|null} action - The message's action
     * @returns {Object} Stamp options; empty, so the action panel is read, when neither is known
     */
    stampOptions(baseline, action) {
        if (baseline) return { catalystHrid: baseline.catalystHrid };
        if (action) return { catalystHrid: this.extractItemHrid(action.secondaryItemHash) };
        return {};
    }

    /**
     * Measure the next message against the queue as it stands now.
     *
     * Only sound between messages. The outputs' stacks are where the successes
     * are read, the catalyst's stack is where its spend is, and an enhanced
     * input's Enhancing Essence stack is where that yield is; without their
     * baselines a first message packing several actions was recorded as one
     * attempt and one success. A stack already in the ledger is re-noted at the
     * total the inventory holds, which is the same value unless something other
     * than the action moved it.
     *
     * @param {{actionId: *, currentCount: number, catalystHrid: string|null}} baseline - The running action
     */
    rebaseline(baseline) {
        const startCount = Number(baseline.currentCount);
        this.lastCurrentCount = Number.isFinite(startCount) ? startCount : null;
        this.trackedActionId = baseline.actionId;
        const { inputItemHrid, enhancementLevel } = this.activeSession;
        const itemDetails = dataManager.getItemDetails(inputItemHrid);
        const outputHrids = (itemDetails?.alchemyDetail?.decomposeItems || []).map((entry) => entry?.itemHrid);
        const seeded = seedLedgerFromInventory(this.itemCounts, dataManager.characterItems, [
            ...outputHrids.filter((hrid) => hrid !== COIN_ITEM_HRID),
            enhancementLevel > 0 ? ENHANCING_ESSENCE_HRID : null,
            baseline.catalystHrid,
        ]);
        this.seededHrids = new Set([...this.seededHrids, ...seeded]);
    }

    /**
     * End the active session
     */
    async endSession() {
        const session = this.activeSession;
        if (!session) {
            return;
        }

        // Closed before the save is awaited: a session the queue starts while
        // the save is in flight must not be the one that gets closed
        this.activeSession = null;
        await this.saveSession(session);
    }

    /**
     * Save the active session to storage (upsert by id).
     * Skips persist if no attempts recorded yet (avoids empty sessions from queue changes).
     */
    async saveActiveSession() {
        await this.saveSession(this.activeSession);
    }

    /**
     * Save one session (upsert by id) under the character it was recorded for.
     *
     * The session and the scope are taken before the load is awaited, so a
     * session started, or a character switched to, while it is in flight is not
     * what gets written.
     *
     * @param {Object|null} session - The session to save
     */
    async saveSession(session) {
        if (!session || session.totalAttempts === 0) {
            return;
        }

        const scope = this.getCharacterScope();
        try {
            // The UNMERGED history: the reload merge is a reader's view, and
            // upserting into it would write a merged record back over the parts
            // it was made from
            const sessions = await this.loadStoredSessions(scope);
            const index = sessions.findIndex((s) => s.id === session.id);

            if (index !== -1) {
                sessions[index] = session;
            } else {
                sessions.push(session);
            }

            // Only the record for the day this session started is written;
            // every earlier day is settled and never touched again
            await sessionStore.save(scope, sessions);
        } catch (error) {
            console.error('[DecomposeHistoryTracker] Failed to save session:', error);
        }
    }

    /**
     * Load the sessions as they are stored, one record per run as recorded
     * @param {string} [scope] - Whose sessions; the current character's by default
     * @returns {Promise<Array>} Array of session objects
     */
    async loadStoredSessions(scope = this.getCharacterScope()) {
        try {
            return await sessionStore.load(scope);
        } catch (error) {
            console.error('[DecomposeHistoryTracker] Failed to load sessions:', error);
            return [];
        }
    }

    /**
     * Load all sessions for reading, with reload splits rejoined.
     *
     * Every page load ends the open session — `init_character_data` calls
     * `handleReconnect()` — so one grind interrupted by five reloads was
     * recorded as five runs. Parts too close together to have hidden a completed
     * action are shown as the one run they were; see `alchemy-session-merge.js`
     * for the threshold and why it is measured rather than chosen. Nothing is
     * rewritten: the stored records stay split.
     *
     * @returns {Promise<Array>} Array of session objects
     */
    async loadSessions() {
        return mergeReloadSplitSessions(await this.loadStoredSessions());
    }

    /**
     * Clear all history from storage.
     * The in-progress session is only dropped once the stored ones are gone: a
     * refused clear deleted nothing, so discarding it would lose the attempts
     * recorded since it started while leaving on disk exactly the history the
     * user asked to delete.
     * @returns {Promise<boolean>} Whether the sessions are gone; false when the
     *   store could not be listed and they are therefore still on disk
     */
    async clearHistory() {
        try {
            const cleared = await sessionStore.clear(this.getCharacterScope());
            if (cleared) this.activeSession = null;
            return cleared;
        } catch (error) {
            console.error('[DecomposeHistoryTracker] Failed to clear history:', error);
            return false;
        }
    }

    /**
     * Persist a caller-supplied sessions array (used by viewer for single-row delete).
     *
     * The caller was shown the MERGED view, so what it hands back is mapped onto
     * the stored records first: deleting a merged row deletes every part behind
     * it, and keeping one keeps them all.
     *
     * @param {Array} sessions - The sessions the caller wants kept
     */
    async deleteSessions(sessions) {
        try {
            const stored = await this.loadStoredSessions();
            await sessionStore.save(this.getCharacterScope(), expandKeptSessions(sessions, stored));
        } catch (error) {
            console.error('[DecomposeHistoryTracker] Failed to save sessions after delete:', error);
        }
    }

    /**
     * Persist a merged sessions array from a JSON backup import (see
     * `alchemy-session-import.js`). The caller has already computed the merge
     * against `loadStoredSessions()`'s result, so this writes the merged array
     * whole, the same way `deleteSessions` writes its expanded kept array.
     *
     * @param {Array} sessions - The merged sessions to store
     * @returns {Promise<boolean>} Whether the write landed
     */
    async importSessions(sessions) {
        try {
            await sessionStore.save(this.getCharacterScope(), sessions);
            return true;
        } catch (error) {
            console.error('[DecomposeHistoryTracker] Failed to save imported sessions:', error);
            return false;
        }
    }

    /**
     * Extract item HRID from a primaryItemHash string
     * Format: "characterId::/item_locations/inventory::/items/item_name::N"
     * @param {string} hash - Primary item hash
     * @returns {string|null} Item HRID or null
     */
    extractItemHrid(hash) {
        if (!hash) {
            return null;
        }

        const parts = hash.split('::');
        if (parts.length < 3) {
            return null;
        }

        const hrid = parts[2];
        return hrid.startsWith('/items/') ? hrid : null;
    }

    /**
     * Extract enhancement level from a primaryItemHash string
     * The level is the last segment after :: if it is a non-negative integer
     * @param {string} hash - Primary item hash
     * @returns {number} Enhancement level (0 if not present or not a number)
     */
    extractEnhancementLevel(hash) {
        if (!hash) {
            return 0;
        }

        const parts = hash.split('::');
        const last = parts[parts.length - 1];

        if (last && !last.startsWith('/')) {
            const parsed = parseInt(last, 10);
            if (!isNaN(parsed) && parsed >= 0) {
                return parsed;
            }
        }

        return 0;
    }

    /**
     * Get the item name from HRID via dataManager
     * @param {string} itemHrid - Item HRID
     * @returns {string} Item display name
     */
    getItemName(itemHrid) {
        const details = dataManager.getItemDetails(itemHrid);
        return details?.name || itemHrid.split('/').pop().replace(/_/g, ' ');
    }
}

const decomposeHistoryTracker = new DecomposeHistoryTracker();

export { decomposeHistoryTracker };

export default {
    name: 'Decompose History Tracker',
    initialize: () => decomposeHistoryTracker.initialize(),
    // Awaited, so a rejection from the now-async disable is caught here rather
    // than escaping as an unhandled promise
    cleanup: async () => {
        try {
            await decomposeHistoryTracker.disable();
        } catch (error) {
            console.error('[Decompose History Tracker] Disable failed part-way:', error);
        } finally {
            decomposeHistoryTracker.isInitialized = false;
        }
    },
};
