/**
 * Transmute History Tracker
 * Records transmute sessions via WebSocket and persists to IndexedDB.
 *
 * Session lifecycle:
 * - Start: actions_updated with actionHrid === '/actions/alchemy/transmute'
 * - Result: action_completed with same actionHrid
 * - End: actions_updated with no transmute action, or different input item
 *
 * Result detection:
 * - Success: a drop-table item's stack total went UP. One message can cover a
 *   batch of attempts and carries one row per changed stack, so the count delta
 *   — not the number of rows — is what says how many actions produced output
 * - Self-return: the input stack fell by less than the attempts consumed. Read
 *   against a baseline seeded from the inventory when the session starts from
 *   the queue, so the first message of a run is measured like every other
 * - Failure: no drop-table item gained
 * - Incidental drops (essences on non-essence transmutes, artisan's crates) are excluded
 *   because they are not listed in the input item's transmuteDropTable
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
import { ensureSessionsRepaired } from './transmute-session-repair.js';

const TRANSMUTE_ACTION_HRID = '/actions/alchemy/transmute';
const COIN_ITEM_HRID = '/items/coin';
const STORAGE_KEY = 'transmuteSessions';

/**
 * The sessions, one record per day rather than one array rewritten per action.
 * See `alchemy-session-store.js` for what that is worth.
 */
const sessionStore = createAlchemySessionStore(STORAGE_KEY, 'TransmuteHistoryTracker');

class TransmuteHistoryTracker {
    constructor() {
        this.isInitialized = false;
        this.characterId = null;
        this.activeSession = null; // Current in-progress session object
        // `endCharacterItems` rows carry a stack's NEW total, one row per
        // changed stack — not one row per action. A count delta is the only
        // thing in the message that scales with a batch.
        this.itemCounts = createItemCountLedger();
        // Items whose every stack the ledger was seeded with at session start
        this.seededHrids = new Set();
        // Whether the ledger holds a baseline for a stack of the input
        this.inputStackKnown = false;
        this.handlers = {
            actionsUpdated: () => this.handleActionsUpdated(),
            actionCompleted: (data) => this.handleActionCompleted(data),
            initCharacterData: () => this.handleReconnect(),
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

        if (!config.getSetting('alchemy_transmuteHistory')) {
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
        webSocketHook.on('init_character_data', this.handlers.initCharacterData);
        dataManager.on('character_switched', this.handlers.characterSwitched);
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
        webSocketHook.off('init_character_data', this.handlers.initCharacterData);
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
     * actions that changed, so it cannot say on its own whether the transmute
     * is still the one running. See `alchemy-running-action.js` for why, and
     * `initialize()` for why this is safe to read synchronously here.
     */
    async handleActionsUpdated() {
        const transmuteAction = runningAlchemyAction(dataManager.getCurrentActions(), TRANSMUTE_ACTION_HRID);

        if (transmuteAction) {
            const inputItemHrid = this.extractItemHrid(transmuteAction.primaryItemHash);
            if (!inputItemHrid) {
                return;
            }

            // Read between messages, so the cached inventory and the action's
            // count are exactly what the next action_completed moves away from
            const baseline = { currentCount: transmuteAction.currentCount };
            if (!this.activeSession) {
                // No active session — start one
                await this.startSession(inputItemHrid, Date.now(), baseline);
            } else if (this.activeSession.inputItemHrid !== inputItemHrid) {
                // Different item — end current session and start new one
                await this.endSession();
                await this.startSession(inputItemHrid, Date.now(), baseline);
            } else {
                // Same item, same session — the player restarted the action, so
                // nothing about the record changes except that it was still
                // running at this moment
                this.activeSession.lastActivityTime = Date.now();
            }
        } else if (this.activeSession) {
            // No transmute action in the update — end any active session
            await this.endSession();
        }
    }

    /**
     * Handle action_completed — record one attempt result
     * @param {Object} data - WebSocket message data
     */
    async handleActionCompleted(data) {
        const action = data.endCharacterAction;
        if (!action || action.actionHrid !== TRANSMUTE_ACTION_HRID) {
            return;
        }

        const inputItemHrid = this.extractItemHrid(action.primaryItemHash);
        if (!inputItemHrid) {
            return;
        }

        // Ensure we have an active session for this item
        if (!this.activeSession || this.activeSession.inputItemHrid !== inputItemHrid) {
            await this.startSession(inputItemHrid, Date.now());
        }
        this.activeSession.lastActivityTime = Date.now();

        // bulkMultiplier defines how many items are consumed and returned per action
        const itemDetailsForBulk = dataManager.getItemDetails(inputItemHrid);
        if (!itemDetailsForBulk?.alchemyDetail?.bulkMultiplier) {
            console.error(`[TransmuteHistoryTracker] Item has no alchemyDetail.bulkMultiplier: ${inputItemHrid}`);
        }
        const bulkMultiplier = itemDetailsForBulk?.alchemyDetail?.bulkMultiplier ?? 1;

        // Build a Set of valid output HRIDs from the input item's transmute drop table.
        // This filters out incidental drops (essences, artisan's crates) that arrive even on failure,
        // while correctly preserving essence outputs when transmuting essence → essence.
        const dropTable = itemDetailsForBulk?.alchemyDetail?.transmuteDropTable || [];
        const validOutputHrids = new Set(dropTable.map((entry) => entry.itemHrid));

        // Every row is recorded so the next message has a baseline; only the
        // drop-table rows say anything about what this action produced, since
        // incidental drops (essences, artisan's crates) arrive even on failure.
        //
        // `noteEach` folds a message's repeated snapshots of one stack down to
        // the last of them, so this is one entry — and one delta — per changed
        // stack. Reading them unfolded applied the arithmetic below once per
        // snapshot and inflated self-returns well past the successes that
        // produced them.
        const noted = this.itemCounts.noteEach(data.endCharacterItems || []);
        const outputRows = noted.filter(
            ({ row }) => row.itemHrid !== COIN_ITEM_HRID && validOutputHrids.has(row.itemHrid)
        );

        // Derive actual attempt count from currentCount delta (handles batched efficiency procs)
        const currentCount = action.currentCount || 0;
        let attemptCount;
        if (this.lastCurrentCount !== null && currentCount > this.lastCurrentCount) {
            attemptCount = currentCount - this.lastCurrentCount;
        } else {
            attemptCount = Math.max(outputRows.length, 1);
        }
        this.lastCurrentCount = currentCount;

        this.activeSession.totalAttempts += attemptCount;

        // How many actions produced each output.
        //
        // Counting rows was only ever right while one message meant one action:
        // `endCharacterItems` carries one row per changed STACK, holding that
        // stack's new absolute total, so a batch of five successes on the same
        // output still arrives as a single row. The count delta is what scales
        // with the batch, and `bulkMultiplier` items arrive per successful
        // action, so the delta divided by it is the number of actions.
        //
        // Deltas are summed per item, not per stack: a stack emptied by the
        // consumption can come back under a new id, and the self-return
        // arithmetic below must see the item's net change, applied once.
        const deltaByHrid = deltasByItem(outputRows, this.seededHrids);

        // Every attempt consumes the input, so a message that moved items but
        // not an input stack known to exist is one where every consumed input
        // was handed back. With no known stack, a missing row says nothing.
        if (deltaByHrid.has(inputItemHrid)) {
            this.inputStackKnown = true;
        } else if (this.inputStackKnown && validOutputHrids.has(inputItemHrid) && noted.length > 0) {
            deltaByHrid.set(inputItemHrid, 0);
        }

        // The input's own row is both consumed and — on a self-return — handed
        // back, so its delta is `(returned - attempts) * bulk`; adding the
        // attempts back recovers the returns. An item with no baseline (the
        // first message of a session that did not start from the queue) can
        // only be read the old way, as one action, and is capped below so it
        // cannot exceed the attempts made.
        const producedActions = new Map();
        for (const [outputItemHrid, delta] of deltaByHrid) {
            const isSelfReturn = outputItemHrid === inputItemHrid;
            let actions;
            if (delta === null) {
                // No baseline: the row says "at least one", and nothing more.
                // A self-return row with no baseline is indistinguishable from
                // the plain consumption of the input, so it is not counted.
                actions = isSelfReturn ? 0 : 1;
            } else if (isSelfReturn) {
                actions = Math.round(delta / bulkMultiplier) + attemptCount;
            } else {
                actions = Math.round(delta / bulkMultiplier);
            }
            actions = Math.min(Math.max(actions, 0), attemptCount);
            if (actions > 0) producedActions.set(outputItemHrid, actions);
        }

        // One action produces one output, so the successes cannot outnumber the
        // attempts however the deltas came out. The excess is taken off the
        // outputs themselves rather than only off the total: recording more
        // items than there were successes is what made a session's self-returns
        // outrun its attempts, and with them its input consumption.
        //
        // A self-return is trimmed first — it is the one output inferred
        // indirectly, from what is left of the input stack rather than from a
        // gain — then the largest remaining estimate.
        let successCount = 0;
        for (const actions of producedActions.values()) successCount += actions;
        let excess = successCount - attemptCount;
        if (excess > 0) {
            const order = [...producedActions.entries()].sort(([hridA, a], [hridB, b]) => {
                if (hridA === inputItemHrid) return -1;
                if (hridB === inputItemHrid) return 1;
                return b - a;
            });
            for (const [outputItemHrid, actions] of order) {
                if (excess <= 0) break;
                const taken = Math.min(excess, actions);
                producedActions.set(outputItemHrid, actions - taken);
                excess -= taken;
            }
        }
        successCount = Math.min(successCount, attemptCount);

        if (successCount > 0) {
            this.activeSession.totalSuccesses += successCount;

            for (const [outputItemHrid, actions] of producedActions) {
                // Trimmed away entirely above — nothing to record, and no empty
                // results row to leave behind
                if (actions <= 0) continue;
                const isOutputSelfReturn = outputItemHrid === inputItemHrid;

                if (!this.activeSession.results[outputItemHrid]) {
                    this.activeSession.results[outputItemHrid] = {
                        count: 0,
                        totalValue: 0,
                        priceEach: 0,
                        isSelfReturn: isOutputSelfReturn,
                        unpriced: false,
                    };
                }

                // Each producing action hands over bulkMultiplier items
                const received = actions * bulkMultiplier;
                this.activeSession.results[outputItemHrid].count += received;

                // Record market price at time of result. `null` means the market
                // cannot price this item at all — folding that into the total as
                // 0 would report "earned nothing" for "could not tell what this
                // was worth", so the tick is excluded from totalValue (there is
                // no number to add) and the result is marked unpriced instead.
                // Sticky across the session: once any tick could not be priced,
                // the total stays incomplete even if a later tick can be. A
                // self-return is never priced — it is the same item handed back,
                // not a sale — so it is exempt.
                if (!isOutputSelfReturn) {
                    const price = getItemPrice(outputItemHrid, { context: 'profit', side: 'sell' });
                    if (price === null) {
                        this.activeSession.results[outputItemHrid].unpriced = true;
                    } else {
                        this.activeSession.results[outputItemHrid].priceEach = price;
                        this.activeSession.results[outputItemHrid].totalValue += price * received;
                    }
                }
            }
        }
        // Failure — totalAttempts already incremented, nothing more to record

        this.recordCatalystUse(action, noted, successCount, attemptCount);

        await this.saveActiveSession();
    }

    /**
     * Record the catalyst this message actually spent.
     *
     * The viewer used to price catalysts as `predictedCatalystHrid ×
     * totalSuccesses` — the catalyst that happened to be in the slot when the
     * session STARTED, multiplied by a count nobody observed. Swap the catalyst
     * mid-run and the whole session is costed against the wrong item.
     *
     * The mechanism is shared with the other two trackers now; see
     * `alchemy-catalyst-use.js` for why the observed stack decrement is
     * preferred and why `noted` has to be the folded ledger.
     *
     * @param {Object} action - `endCharacterAction` from the message
     * @param {Array<{row: Object, delta: number|null}>} noted - The folded ledger entries
     * @param {number} successCount - Successes this message covered
     * @param {number} attemptCount - Attempts this message covered
     * @returns {void}
     */
    recordCatalystUse(action, noted, successCount, attemptCount) {
        recordCatalystUse(this.activeSession, {
            catalystHrid: this.extractItemHrid(action.secondaryItemHash),
            noted,
            successCount,
            attemptCount,
        });
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
     * @param {number} timestamp - Start timestamp in ms
     * @param {{currentCount: number}|null} [baseline] - Present only when the
     *   session starts from the queue, between messages, so the cached
     *   inventory and the action's count predate every message it will read
     */
    async startSession(inputItemHrid, timestamp, baseline = null) {
        // Recorded, not recomputed at read time: the coin fee that was actually
        // billed scales with the bulk size the item had while the session ran,
        // and a later game change to that number would otherwise silently
        // restate every past session's profit.
        const itemDetails = dataManager.getItemDetails(inputItemHrid);
        // What the model says this run will succeed at, taken NOW — the tea,
        // the catalyst in the slot and the level penalty are the ones this run
        // is played with, and every one of them will have moved by the time
        // anybody reads the record back. A session with no stamp is excluded
        // from calibration rather than judged against a later model.
        const stamp = predictedSuccessStamp('transmute', inputItemHrid, timestamp);
        this.activeSession = {
            id: `transmute_${timestamp}`,
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
            totalAttempts: 0,
            totalSuccesses: 0,
            bulkMultiplier: itemDetails?.alchemyDetail?.bulkMultiplier ?? 1,
            predictedRate: stamp?.predictedRate ?? null,
            predictedAt: stamp?.predictedAt ?? null,
            predictedCatalystHrid: stamp?.predictedCatalystHrid ?? null,
            // What was actually spent, hrid → count, recorded per message as
            // the run goes. Kept ALONGSIDE the prediction above rather than
            // replacing it: the prediction is still the only answer a session
            // saved before this existed has. See `recordCatalystUse`.
            catalystsUsed: {},
            results: {},
        };
        this.itemCounts.reset();
        const startCount = Number(baseline?.currentCount);
        this.lastCurrentCount = baseline && Number.isFinite(startCount) ? startCount : null;
        this.inputStackKnown = false;
        this.seededHrids = baseline ? this.seedItemCounts(inputItemHrid, itemDetails) : new Set();
    }

    /**
     * Give the ledger a baseline for the input and every drop-table item.
     *
     * Without one, the first message's input row has no delta, and a
     * self-return there cannot be told apart from plain consumption — a run
     * begun with a single refined cape recorded its first self-return as a
     * failure and charged the cape a second time.
     *
     * Every stack of these items is seeded, so one the ledger later meets
     * without a baseline did not exist at the start.
     *
     * @param {string} inputItemHrid - Input item HRID
     * @param {Object|null} itemDetails - The input's item details
     * @returns {Set<string>} The items whose every stack is now in the ledger;
     *   empty when the inventory is not loaded
     */
    seedItemCounts(inputItemHrid, itemDetails) {
        const inventory = dataManager.characterItems;
        if (!Array.isArray(inventory)) return new Set();

        const hrids = new Set([inputItemHrid]);
        for (const entry of itemDetails?.alchemyDetail?.transmuteDropTable || []) {
            if (entry?.itemHrid && entry.itemHrid !== COIN_ITEM_HRID) hrids.add(entry.itemHrid);
        }
        const seeded = seedLedgerFromInventory(this.itemCounts, inventory, hrids);
        this.inputStackKnown = inventory.some((row) => row?.itemHrid === inputItemHrid);
        return seeded;
    }

    /**
     * End the active session
     */
    async endSession() {
        if (!this.activeSession) {
            return;
        }

        await this.saveActiveSession();
        this.activeSession = null;
    }

    /**
     * Save the active session to storage (upsert by id).
     * Skips persist if no attempts recorded yet (avoids empty sessions from queue changes).
     */
    async saveActiveSession() {
        if (!this.activeSession || this.activeSession.totalAttempts === 0) {
            return;
        }

        try {
            // The UNMERGED history: the reload merge is a reader's view, and
            // upserting into it would write a merged record back over the parts
            // it was made from
            const sessions = await this.loadStoredSessions();
            const index = sessions.findIndex((s) => s.id === this.activeSession.id);

            if (index !== -1) {
                sessions[index] = this.activeSession;
            } else {
                sessions.push(this.activeSession);
            }

            // Only the record for the day this session started is written;
            // every earlier day is settled and never touched again
            await sessionStore.save(this.getCharacterScope(), sessions);
        } catch (error) {
            console.error('[TransmuteHistoryTracker] Failed to save session:', error);
        }
    }

    /**
     * Load the sessions as they are stored, one record per run as recorded.
     *
     * The one-time self-return repair runs here, on the way out, so every
     * reader — the viewer, the totals table, the gold attribution — sees the
     * same corrected history without any of them having to know the repair
     * exists. It is a no-op after the first load of a scope whose write landed;
     * see `transmute-session-repair.js`.
     *
     * @returns {Promise<Array>} Array of session objects
     */
    async loadStoredSessions() {
        const scope = this.getCharacterScope();
        try {
            const sessions = await sessionStore.load(scope);
            return await ensureSessionsRepaired(scope, sessions, (repaired) => sessionStore.save(scope, repaired));
        } catch (error) {
            console.error('[TransmuteHistoryTracker] Failed to load sessions:', error);
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
            console.error('[TransmuteHistoryTracker] Failed to clear history:', error);
            return false;
        }
    }

    /**
     * Persist a caller-supplied sessions array (used by viewer for single-row delete).
     *
     * The caller was shown the MERGED view, so what it hands back is mapped onto
     * the stored records first: deleting a merged row deletes every part behind
     * it, and keeping one keeps them all. Writing the merged array straight to
     * disk would collapse the parts into one record as a side effect of an
     * unrelated delete.
     *
     * @param {Array} sessions - The sessions the caller wants kept
     */
    async deleteSessions(sessions) {
        try {
            const stored = await this.loadStoredSessions();
            await sessionStore.save(this.getCharacterScope(), expandKeptSessions(sessions, stored));
        } catch (error) {
            console.error('[TransmuteHistoryTracker] Failed to save sessions after delete:', error);
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
            console.error('[TransmuteHistoryTracker] Failed to save imported sessions:', error);
            return false;
        }
    }

    /**
     * Extract item HRID from a primaryItemHash string
     * Format: "characterId::/item_locations/inventory::/items/item_name::0"
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
     * Get the item name from HRID via dataManager
     * @param {string} itemHrid - Item HRID
     * @returns {string} Item display name
     */
    getItemName(itemHrid) {
        const details = dataManager.getItemDetails(itemHrid);
        return details?.name || itemHrid.split('/').pop().replace(/_/g, ' ');
    }
}

const transmuteHistoryTracker = new TransmuteHistoryTracker();

export { transmuteHistoryTracker };

export default {
    name: 'Transmute History Tracker',
    initialize: () => transmuteHistoryTracker.initialize(),
    // Awaited, so a rejection from the now-async disable is caught here rather
    // than escaping as an unhandled promise
    cleanup: async () => {
        try {
            await transmuteHistoryTracker.disable();
        } catch (error) {
            console.error('[Transmute History Tracker] Disable failed part-way:', error);
        } finally {
            transmuteHistoryTracker.isInitialized = false;
        }
    },
};
