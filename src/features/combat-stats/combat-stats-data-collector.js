/**
 * Combat Statistics Data Collector
 * Listens for new_battle WebSocket messages and stores combat data
 */

import webSocketHook from '../../core/websocket.js';
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import { sessionKey, archiveSession } from './combat-session-history.js';
import { characterKey, readScoped, writeScoped } from '../../utils/character-key.js';
import { captureOwner, stillOurs, noteTeardown } from '../../utils/init-ownership.js';
import { runningCombatAction } from '../../utils/combat-actions.js';
import {
    reconcileSnapshot,
    wavesElapsed,
    estimateFightingSeconds,
    UNOBSERVED_GAP_SECONDS,
} from './consumable-reconcile.js';

/**
 * How long a finished run stays on the overlay.
 *
 * Long enough to read what you just earned after combat stops, short enough that
 * a rate dividing by a clock nobody stopped does not sit there looking like a
 * measurement. Only ever consulted when the character is *not* in combat — a run
 * still under way is never withheld, however old its snapshot.
 */
const STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * Keys under the 'combatStats' store, scoped per character.
 *
 * All four describe one character's live run — what it drank, what its party
 * drank, what it looted — so a shared key had the iron cow reading the market
 * cow's consumption rates. Keys are resolved at each read and write, never
 * cached, because the user switches characters without reloading.
 *
 * The pre-scoping global values are *discarded* rather than adopted: this is
 * live session state measured against one character's gear and one party's
 * roster, and starting empty is better than starting wrong.
 */
const CONSUMABLE_TRACKER_KEY = 'consumableTracker';
const PARTY_TRACKERS_KEY = 'partyConsumableTrackers';
const PARTY_SNAPSHOTS_KEY = 'partyConsumableSnapshots';
const LATEST_RUN_KEY = 'latestCombatRun';

/**
 * Whether this character's copy of a record can be read right now.
 *
 * The trackers here are live counters of the run in hand — memory is the
 * truth and is written out whole, which is right for a counter. What must not
 * happen is the write landing when the read side is down: a tab that could
 * not read its stored counts would then write its own, smaller ones over
 * them. So every write probes first and stands down when the probe cannot
 * be made. (The loads already keep memory on a failed read: `readScoped`
 * answers null there and null is never adopted.)
 *
 * The probe is a real IndexedDB read, and `onNewBattle` used to make it
 * several times per wave — once per tracker write — which on a party dungeon
 * was more reads than the data being protected was worth. A probe that
 * succeeded is trusted for a few seconds (`READ_PROBE_TTL_MS`): a connection
 * that drops inside that window costs at most one write landing on a database
 * the next probe will find unreadable, and a failed probe is never cached, so
 * the next save asks again.
 * @param {string} base - The unscoped key
 * @returns {Promise<boolean>}
 */
/**
 * One character's scoped key, from an id the caller captured.
 *
 * Deliberately not `writeScoped()`: that resolves `characterKey()` when the
 * write runs, and every write here sits on the far side of at least one await.
 * @param {string} base - The unscoped key
 * @param {string} charId - Whose key
 * @returns {string} `base_<charId>`
 */
function scopedFor(base, charId) {
    return `${base}_${charId}`;
}

async function storeReadable(base) {
    const now = Date.now();
    if (readProbe.ok && now - readProbe.at < READ_PROBE_TTL_MS) return true;

    const probed = await storage.tryGet(characterKey(base), COMBAT_STORE);
    if (probed === null) {
        readProbe.ok = false;
        console.warn(`[Combat Stats] ${base} not saved: storage could not be read first`);
        return false;
    }
    readProbe.ok = true;
    readProbe.at = now;
    return true;
}

/** How long one successful readability probe stands in for the next ones */
const READ_PROBE_TTL_MS = 5000;
/** The last successful probe: when it was made, and whether it is still trusted */
const readProbe = { ok: false, at: 0 };

/**
 * Test-only: forget the cached readability probe, so the next save probes again.
 * @returns {void}
 */
export function _resetReadProbe() {
    readProbe.ok = false;
    readProbe.at = 0;
}
const COMBAT_STORE = 'combatStats';
const DISCARD_LEGACY = { migrate: 'discard' };

/**
 * Stored shape of the trackers that carries a wall-clock `startTime` plus the
 * time deliberately left out of the rate (`excludedMs`), the last snapshot
 * reconciled (`lastSnapshotAt`) and the battle-traffic clock (`trafficAt`,
 * `silenceMs`). Older records carry only
 * `elapsedMs`, which already dropped the time the page was closed, so they
 * have no observation point to reconcile from and start from a fresh baseline.
 */
const TRACKER_VERSION = 2;

/**
 * A fresh tracker for the current player.
 *
 * Besides the counters, it carries what reconciling against `new_battle`
 * snapshots needs: the time left out of the rate, the last time anything about
 * this character was observed, and the run position used to estimate how long
 * an unobserved gap was spent fighting.
 * @param {number|null} startTime - When tracking started
 * @returns {Object}
 */
function createSelfTracker(startTime) {
    return {
        actualConsumed: {}, // { itemHrid: count }
        defaultConsumed: {}, // { itemHrid: baselineCount }
        inventoryAmount: {}, // { itemHrid: currentCount }
        startTime, // When tracking started
        lastUpdate: null, // Last consumption event timestamp
        lastEventByItem: {}, // { itemHrid: timestamp } - for deduplication
        excludedMs: 0, // Unobserved time left out of the rate
        lastSnapshotAt: null, // When this tracker was last reconciled against a snapshot
        // The observation clock, shared by the whole party: the last battle message of
        // any kind, and the total of the silences longer than UNOBSERVED_GAP_SECONDS
        trafficAt: null,
        silenceMs: 0,
        silenceAtSnapshot: 0, // silenceMs when this tracker's last snapshot was reconciled
        silenceAtLastBattle: 0, // silenceMs at the last new_battle, for the wave samples
        runKey: null, // combatStartTime of the run being tracked
        lastBattleId: null,
        lastWave: null,
        lastBattleAt: null,
        waveIntervalSum: 0, // Ordinary new_battle intervals, for the average wave time
        waveIntervalCount: 0,
        // Not persisted: the count a snapshot credited a use at, so the event for
        // that same use arriving after the snapshot is not counted a second time
        snapshotCreditedAt: {},
    };
}

/**
 * Consumables of one player's `new_battle` entry, one per item.
 *
 * Duplicated slots would otherwise be reconciled twice against the same
 * baseline and credit the same drop twice. The first entry wins, as it does
 * where the snapshot is built.
 * @param {Object|undefined} player - A `players[]` entry
 * @returns {Array<{itemHrid: string, count: number}>}
 */
function snapshotConsumables(player) {
    const seen = new Set();
    const result = [];
    for (const consumable of player?.combatConsumables || []) {
        if (!consumable?.itemHrid || typeof consumable.count !== 'number') continue;
        if (seen.has(consumable.itemHrid)) continue;
        seen.add(consumable.itemHrid);
        result.push({ itemHrid: consumable.itemHrid, count: consumable.count });
    }
    return result;
}

class CombatStatsDataCollector {
    constructor() {
        this.isInitialized = false;
        this.newBattleHandler = null;
        this.consumableEventHandler = null;
        this.battleTrafficHandler = null;
        this.socketCloseHandler = null;
        /** Set when the game socket closed during the current session; cleared when a new session starts */
        this.connectionInterrupted = false;
        /** The game socket the session's battles last arrived on; see `onSocketClosed` */
        this.sessionSocket = null;
        /** The character the session's battles were fought as; the owner of the snapshot a close marks */
        this.sessionOwner = null;
        this.latestCombatData = null;
        this.currentBattleId = null;
        /** Which run the snapshot belongs to; a change means the last one ended */
        this.sessionKey = null;

        // Consumable tracking state for current player (persisted to storage like MCS)
        this.consumableTracker = createSelfTracker(null);

        // Party member consumable tracking (MCS-style)
        this.partyConsumableTrackers = {}; // { playerName: tracker }
        this.partyConsumableSnapshots = {}; // { playerName: { itemHrid: previousCount } }
        this.partyLastKnownConsumables = {}; // { playerName: { itemHrid: { itemHrid, lastSeenCount } } }

        // Character switch listeners, registered once (see initialize)
        this.switchingHandler = null;
        this.switchedHandler = null;
    }

    /**
     * Initialize the data collector
     */
    async initialize() {
        if (this.isInitialized) {
            return;
        }

        this.isInitialized = true;

        // `isInitialized` is set *before* the two reads below, so a
        // `character_switching` teardown landing inside either never made the
        // switch's re-initialise early-return. The resumed tail instead ran on
        // top of a `cleanup()` that had already unhooked both socket handlers
        // and nulled the fields holding them, and re-stored its own into those
        // same fields — leaving the previous `new_battle` and
        // `battle_consumable_ability_updated` handlers live with no handle left
        // to remove them by. One leaked pair per switch, each one counting the
        // same tick again: doubled damage and doubled consumable counts in the
        // Combat Statistics panel.
        const ticket = captureOwner(this);

        // Load persisted tracking state from storage (MCS-style)
        await this.loadConsumableTracking();
        if (!stillOurs(ticket)) return;

        // And the last run itself. Without this the overlay showed "No loot
        // tracked yet" after every refresh until the next battle started — in a
        // dungeon that is a whole wave of nothing — while the Combat Statistics
        // popup showed the run perfectly, because the popup was the only caller
        // of loadLatestData. The snapshot was written all along and never read
        // back at start-up.
        //
        // Safe to restore unconditionally: the rows date it from
        // `combatStartTime`, and the next `new_battle` overwrites it outright.
        await this.loadLatestData();
        // Guards the whole resumed tail — both handlers below, and the switch
        // pair after them.
        if (!stillOurs(ticket)) return;

        // Store handler references for cleanup
        this.newBattleHandler = (data, context) => this.onNewBattle(data, context);
        this.consumableEventHandler = (data) => this.onConsumableUsed(data);

        // Listen for new_battle messages (fires during combat, continuously updated)
        webSocketHook.on('new_battle', this.newBattleHandler);

        // Listen for battle_consumable_ability_updated (fires on each consumable use)
        webSocketHook.on('battle_consumable_ability_updated', this.consumableEventHandler);

        // Every combat tick, for the whole party: the clock that says whether anybody
        // was watching between two snapshots (see noteBattleTraffic). Only a timestamp.
        this.battleTrafficHandler = () => this.noteBattleTraffic(Date.now());
        webSocketHook.on('battle_updated', this.battleTrafficHandler);

        // A mid-session disconnect means events during the gap may have been missed, so the
        // session's numbers are flagged as possibly incomplete rather than silently trusted.
        this.socketCloseHandler = (_event, socket) => this.onSocketClosed(socket);
        webSocketHook.onSocketEvent('close', this.socketCloseHandler);

        // Everything above is one character's live run. This pair is registered
        // once and never removed — but not, as this comment used to claim,
        // because the collector is "not always disabled on a switch". It always
        // is: `entrypoint.js` normalises a module's `cleanup()` into the
        // registry entry's `.disable`, `feature-registry.js`'s
        // `disableAllFeatures()` calls every registered feature's `.disable()`
        // unconditionally on `character_switching`, and Combat Statistics is
        // registered exactly that way (`module: Combat.combatStats`, whose
        // `cleanup()` calls this one's).
        //
        // The real reason is what `cleanup()` deliberately does *not* do: it
        // leaves the consumable trackers in memory, because they are persisted.
        // Forgetting them is `onCharacterSwitching`'s job, and it has to happen
        // while the collector is down — the teardown and the switch are the
        // same event — or the departing character's in-memory run is written
        // straight back out under the arriving character's key. So the pair
        // outlives the feature lifecycle on purpose, and this guard is what
        // keeps each re-initialise from stacking a second pair on top of it.
        if (!this.switchingHandler) {
            this.switchingHandler = () => this.onCharacterSwitching();
            this.switchedHandler = () => this.onCharacterSwitched();
            dataManager.on('character_switching', this.switchingHandler);
            dataManager.on('character_switched', this.switchedHandler);
        }
    }

    /**
     * Forget the departing character's run.
     *
     * The keys are per character and derived at each access, so nothing here
     * needs re-keying — what needs doing is forgetting, since the in-memory
     * copy is the one thing a scoped key cannot protect. Nothing is read or
     * written: dataManager still reports the departing character at this point,
     * so a read here would fetch the run we are trying to forget.
     */
    onCharacterSwitching() {
        this._resetTrackersInMemory();
        this.latestCombatData = null;
        this.currentBattleId = null;
        this.sessionKey = null;
        // The departing socket's close, whenever it lands, is no gap in the
        // arriving character's session
        this.sessionSocket = null;
        this.sessionOwner = null;
    }

    /**
     * The game socket closed. Flags the running session as possibly incomplete.
     *
     * Only a session being fought on the wire counts: its battles arrived on
     * the socket that closed, and its combat action is still running. That
     * leaves out a close while idle after combat stopped (the trackers' clock
     * outlives the fighting), a run only restored from storage, and a
     * character switch, whose departing socket can close before or after the
     * arriving one attaches (the switch forgets the session's socket). The
     * mark goes on the session's snapshot too, so its archive keeps it, and
     * that snapshot is written back to storage: a reload before the next
     * `new_battle` restores it from there, and the unmarked copy would be
     * archived as a complete run.
     *
     * @param {WebSocket} [socket] - The socket that closed
     * @returns {Promise<void>|undefined} The storage write, when one was started
     */
    onSocketClosed(socket) {
        if (!socket || socket !== this.sessionSocket) return;
        const session = this.latestCombatData;
        if (!session || session.restored) return;
        // The running combat action must be this session's: after a switch to another zone, the old
        // session is over even before the new one's first battle replaces the snapshot
        const running = this.currentCombatAction();
        // An unknown session action (the battle arrived before the action list loaded) proves nothing
        if (!running || !session.actionHrid || running !== session.actionHrid) return;
        this.connectionInterrupted = true;
        session.connectionInterrupted = true;
        return this.persistInterruptedSnapshot(this.sessionOwner, session);
    }

    /**
     * Write the marked session snapshot under the character it belongs to.
     *
     * `owner` is the character the session was fought as, captured when its
     * battles arrived, never resolved here: the close can land during a switch,
     * and the probe below awaits. Re-checked after it, and skipped when a newer
     * `new_battle` has replaced the snapshot (that write carries the mark itself
     * and is fresher than this one).
     *
     * @param {string|null} owner - Character id the session belongs to
     * @param {Object} session - The snapshot that was marked
     * @returns {Promise<void>}
     */
    async persistInterruptedSnapshot(owner, session) {
        try {
            if (!owner || !(await storeReadable(LATEST_RUN_KEY))) return;
            if (dataManager.getCurrentCharacterId() !== owner || this.latestCombatData !== session) return;
            await storage.set(scopedFor(LATEST_RUN_KEY, owner), session, COMBAT_STORE);
        } catch (error) {
            console.error('[Combat Stats] Could not persist the interrupted-connection mark:', error);
        }
    }

    /**
     * Whether the game socket closed during the current tracking session, meaning
     * some events may have been missed and its numbers may be incomplete.
     * @returns {boolean}
     */
    isConnectionInterrupted() {
        return this.connectionInterrupted;
    }

    /** Bring in the arriving character's own run, now that they are current. */
    async onCharacterSwitched() {
        try {
            await this.loadConsumableTracking();
            await this.loadLatestData();
        } catch (error) {
            console.error('[Combat Stats] Reloading after a character switch failed:', error);
        }
    }

    /**
     * Get game-theoretical maximum consumption rate per day for an item
     * Based on cooldown floors: drinks 300s / 1.2 max concentration, food 60s flat
     * @param {string} itemHrid - Item HRID
     * @returns {number} Max consumptions per day
     */
    getMaxRatePerDay(itemHrid) {
        const name = itemHrid.toLowerCase();
        if (name.includes('coffee') || name.includes('drink')) {
            return 345.6; // 300s / (1 + 0.20 max drink concentration) = 250s cooldown
        }
        return 1440; // 60s food cooldown
    }

    /**
     * @param {string} itemHrid - Item HRID
     * @returns {number} Default consumed count (2 for drinks, 10 for food)
     */
    getDefaultConsumed(itemHrid) {
        const name = itemHrid.toLowerCase();
        if (name.includes('coffee') || name.includes('drink')) return 2;
        if (
            name.includes('donut') ||
            name.includes('cupcake') ||
            name.includes('cake') ||
            name.includes('gummy') ||
            name.includes('yogurt')
        )
            return 10;
        return 0;
    }

    /**
     * Calculate elapsed seconds since tracking started (MCS-style)
     * @param {Object} tracker - Tracker object (current player or party member)
     * @returns {number} Elapsed seconds
     */
    calcElapsedSeconds(tracker = null) {
        const targetTracker = tracker || this.consumableTracker;
        if (!targetTracker.startTime) {
            return 0;
        }
        // Less the unobserved time reconciliation left out of the rate
        return Math.max(0, (Date.now() - targetTracker.startTime - (targetTracker.excludedMs || 0)) / 1000);
    }

    /**
     * Create a new party member tracker (MCS-style)
     * @returns {Object} New tracker object
     */
    createPartyTracker() {
        return {
            actualConsumed: {},
            defaultConsumed: {},
            inventoryAmount: {},
            startTime: Date.now(),
            lastUpdate: null,
            excludedMs: 0,
            lastSnapshotAt: null,
            silenceAtSnapshot: this.consumableTracker.silenceMs || 0,
        };
    }

    /**
     * Record a battle message of any kind arriving.
     *
     * During a fight the page hears about the whole party on every tick, so the
     * time since the last battle message is the one observation clock for every
     * tracker. A silence longer than `UNOBSERVED_GAP_SECONDS` (a closed or
     * suspended page, a dropped connection, the feature switched off) is added to
     * `silenceMs`; a long battle watched throughout adds nothing.
     * @param {number} now - Timestamp (ms)
     */
    noteBattleTraffic(now) {
        const tracker = this.consumableTracker;
        if (typeof tracker.trafficAt === 'number') {
            const silentMs = now - tracker.trafficAt;
            if (silentMs > UNOBSERVED_GAP_SECONDS * 1000) tracker.silenceMs = (tracker.silenceMs || 0) + silentMs;
        }
        tracker.trafficAt = now;
    }

    /**
     * Max waves of a dungeon, from game data.
     * @param {string|null} actionHrid - Combat action hrid
     * @returns {number|null} Null when not a dungeon (or not known to be one), 0 when its wave count is unknown
     */
    getDungeonMaxWaves(actionHrid) {
        if (!actionHrid) return null;
        try {
            const zoneInfo = dataManager.getActionDetails?.(actionHrid)?.combatZoneInfo;
            if (zoneInfo?.isDungeon !== true) return null;
            return Number(zoneInfo.dungeonInfo?.maxWaves) || 0;
        } catch {
            return null;
        }
    }

    /**
     * How long the character was actually fighting since the previous
     * `new_battle`, from the wave count and the run's average wave time.
     * @param {Object} data - new_battle message data
     * @returns {number|null} Seconds, or null when it cannot be derived
     */
    estimateGapFightingSeconds(data) {
        const tracker = this.consumableTracker;
        const dungeonMaxWaves = this.getDungeonMaxWaves(this.currentCombatAction());
        // A dungeon whose wave count is unknown cannot turn its run counter into waves
        if (dungeonMaxWaves === 0) return null;

        const waves = wavesElapsed({
            previousBattleId: tracker.lastBattleId,
            previousWave: tracker.lastWave,
            battleId: data.battleId || 0,
            wave: typeof data.wave === 'number' ? data.wave : null,
            dungeonMaxWaves,
        });
        return estimateFightingSeconds(waves, { sum: tracker.waveIntervalSum, count: tracker.waveIntervalCount });
    }

    /**
     * Record this message's run position and, for ordinary intervals, feed the
     * average wave time.
     * @param {Object} data - new_battle message data
     * @param {number} now - Timestamp (ms)
     */
    updateRunPosition(data, now) {
        const tracker = this.consumableTracker;
        if (tracker.lastBattleAt) {
            const intervalSeconds = (now - tracker.lastBattleAt) / 1000;
            // A battle watched throughout is a sample however long it ran; one with a
            // silence in it is not, since the page cannot say how much of it was fighting
            const watched = (tracker.silenceMs || 0) === (tracker.silenceAtLastBattle || 0);
            if (intervalSeconds > 0 && watched) {
                tracker.waveIntervalSum += intervalSeconds;
                tracker.waveIntervalCount++;
            }
        }
        tracker.silenceAtLastBattle = tracker.silenceMs || 0;
        tracker.lastBattleAt = now;
        tracker.lastBattleId = data.battleId || 0;
        tracker.lastWave = typeof data.wave === 'number' ? data.wave : null;
        if (data.combatStartTime) tracker.runKey = data.combatStartTime;
    }

    /**
     * Reconcile one tracker against one player's snapshot and apply the result:
     * credit the consumption the events missed, and leave the unobserved part
     * of the gap out of the tracker's time base.
     *
     * Every snapshot of the player counts as an observation, consumables or
     * not: a stretch with nothing slotted was still watched, and must not be
     * excluded later as though it had not been.
     *
     * @param {Object} tracker - The current player's tracker or a party member's
     * @param {Object} lastKnown - Counts last held, by item hrid
     * @param {Array<{itemHrid: string, count: number}>} consumables - From `snapshotConsumables`
     * @param {number|null} fightingSeconds - Estimated fighting time in the gap
     * @param {number} now - Timestamp (ms)
     * @returns {{excludeSeconds: number, items: Array<{itemHrid: string, action: string, credited: number}>}}
     */
    reconcileTracker(tracker, lastKnown, consumables, fightingSeconds, now) {
        const gapSeconds = typeof tracker.lastSnapshotAt === 'number' ? (now - tracker.lastSnapshotAt) / 1000 : null;
        const silenceMs = this.consumableTracker.silenceMs || 0;
        const unobservedSeconds = Math.max(0, (silenceMs - (tracker.silenceAtSnapshot || 0)) / 1000);
        const result = reconcileSnapshot({
            items: consumables.map((consumable) => ({
                itemHrid: consumable.itemHrid,
                lastKnown: lastKnown?.[consumable.itemHrid],
                snapshot: consumable.count,
                maxRatePerSecond: this.getMaxRatePerDay(consumable.itemHrid) / 86400,
            })),
            gapSeconds,
            unobservedSeconds,
            fightingSeconds,
        });

        for (const entry of result.items) {
            if (entry.action !== 'credit') continue;
            // Consumption recovered before anything started the clock starts it where we last looked
            if (!tracker.startTime) tracker.startTime = tracker.lastSnapshotAt || now;
            if (tracker.actualConsumed[entry.itemHrid] === undefined) {
                tracker.actualConsumed[entry.itemHrid] = 0;
                tracker.defaultConsumed[entry.itemHrid] = this.getDefaultConsumed(entry.itemHrid);
            }
            tracker.actualConsumed[entry.itemHrid] += entry.credited;
            tracker.lastUpdate = now;
        }
        // Only once the clock runs: time excluded before it starts would be taken off
        // a clock that starts later, and hold the rate's time base at zero for that long
        if (tracker.startTime) {
            tracker.excludedMs = (tracker.excludedMs || 0) + Math.round(result.excludeSeconds * 1000);
        }
        tracker.lastSnapshotAt = now;
        tracker.silenceAtSnapshot = silenceMs;
        return result;
    }

    /**
     * Load consumable tracking state from storage
     */
    async loadConsumableTracking() {
        try {
            // Load current player tracker
            // Whose run this is. A switch landing inside any of the reads below has
            // already blanked memory for the arriving character, and the departing
            // character's records must not be poured back into it.
            const owner = dataManager.getCurrentCharacterId();
            const saved = await readScoped(CONSUMABLE_TRACKER_KEY, COMBAT_STORE, null, DISCARD_LEGACY);
            if (dataManager.getCurrentCharacterId() !== owner) return;
            if (saved) {
                // Restore tracking state
                const tracker = this.consumableTracker;
                tracker.actualConsumed = saved.actualConsumed || {};
                tracker.defaultConsumed = saved.defaultConsumed || {};
                tracker.inventoryAmount = saved.inventoryAmount || {};
                tracker.lastUpdate = saved.lastUpdate || null;
                tracker.snapshotCreditedAt = {};

                if (saved.trackerVersion === TRACKER_VERSION) {
                    // Wall-clock start plus the time explicitly left out, so the time the
                    // page spent closed is reconciled against the next snapshot instead of
                    // silently dropped
                    tracker.startTime = typeof saved.startTime === 'number' ? saved.startTime : null;
                    tracker.excludedMs = saved.excludedMs || 0;
                    tracker.lastSnapshotAt = typeof saved.lastSnapshotAt === 'number' ? saved.lastSnapshotAt : null;
                    // The closed time becomes a silence when the next battle message arrives
                    tracker.trafficAt = typeof saved.trafficAt === 'number' ? saved.trafficAt : tracker.lastSnapshotAt;
                    tracker.silenceMs = saved.silenceMs || 0;
                    tracker.silenceAtSnapshot = saved.silenceAtSnapshot || 0;
                    tracker.silenceAtLastBattle = saved.silenceAtLastBattle || 0;
                    tracker.runKey = saved.runKey || null;
                    tracker.lastBattleId = typeof saved.lastBattleId === 'number' ? saved.lastBattleId : null;
                    tracker.lastWave = typeof saved.lastWave === 'number' ? saved.lastWave : null;
                    tracker.lastBattleAt = saved.lastBattleAt || null;
                    tracker.waveIntervalSum = saved.waveIntervalSum || 0;
                    tracker.waveIntervalCount = saved.waveIntervalCount || 0;
                } else {
                    // Older record (or one pulled from a device on an older build): its
                    // elapsed time already left the closed time out and it has no
                    // observation point, so the next snapshot is a fresh baseline
                    if (saved.elapsedMs !== undefined && saved.saveTimestamp) {
                        tracker.startTime = Date.now() - saved.elapsedMs;
                    } else if (saved.startTime) {
                        // Legacy: direct startTime (will include offline time)
                        tracker.startTime = typeof saved.startTime === 'number' ? saved.startTime : null;
                    }
                    tracker.excludedMs = 0;
                    tracker.lastSnapshotAt = null;
                    tracker.trafficAt = null;
                    tracker.silenceMs = 0;
                    tracker.silenceAtSnapshot = 0;
                    tracker.silenceAtLastBattle = 0;
                    tracker.runKey = null;
                    tracker.lastBattleId = null;
                    tracker.lastWave = null;
                    tracker.lastBattleAt = null;
                    tracker.waveIntervalSum = 0;
                    tracker.waveIntervalCount = 0;
                }
            }

            // Load party member trackers (MCS-style)
            const savedPartyTrackers = await readScoped(PARTY_TRACKERS_KEY, COMBAT_STORE, null, DISCARD_LEGACY);
            if (dataManager.getCurrentCharacterId() !== owner) return;
            if (savedPartyTrackers) {
                const now = Date.now();
                this.partyConsumableTrackers = {};
                Object.keys(savedPartyTrackers).forEach((playerName) => {
                    const playerTracker = savedPartyTrackers[playerName];
                    if (
                        playerTracker.actualConsumed &&
                        playerTracker.defaultConsumed &&
                        playerTracker.inventoryAmount
                    ) {
                        const elapsedMs = playerTracker.elapsedMs || 0;
                        const current = playerTracker.trackerVersion === TRACKER_VERSION;
                        this.partyConsumableTrackers[playerName] = {
                            actualConsumed: playerTracker.actualConsumed || {},
                            defaultConsumed: playerTracker.defaultConsumed || {},
                            inventoryAmount: playerTracker.inventoryAmount || {},
                            startTime: current && playerTracker.startTime ? playerTracker.startTime : now - elapsedMs,
                            lastUpdate: playerTracker.lastUpdate || null,
                            excludedMs: current ? playerTracker.excludedMs || 0 : 0,
                            lastSnapshotAt:
                                current && typeof playerTracker.lastSnapshotAt === 'number'
                                    ? playerTracker.lastSnapshotAt
                                    : null,
                            silenceAtSnapshot: current ? playerTracker.silenceAtSnapshot || 0 : 0,
                        };
                    }
                });
            }

            // Load party snapshots
            const savedSnapshots = await readScoped(PARTY_SNAPSHOTS_KEY, COMBAT_STORE, null, DISCARD_LEGACY);
            if (dataManager.getCurrentCharacterId() !== owner) return;
            if (savedSnapshots) {
                this.partyConsumableSnapshots = savedSnapshots;
            }
        } catch (error) {
            console.error('[Combat Stats] Error loading consumable tracking:', error);
        }
    }

    /**
     * Cap elapsed time and counts to a maximum window, preserving the rate ratio.
     * Prevents long-running sessions from dominating the rate after a reload.
     * @param {Object} counts - actualConsumed or defaultConsumed map (not mutated)
     * @param {number} elapsedMs - Raw elapsed time in ms
     * @param {number} maxMs - Maximum window in ms
     * @returns {{counts: Object, elapsedMs: number}}
     */
    capToWindow(counts, elapsedMs, maxMs) {
        if (elapsedMs <= maxMs) {
            return { counts, elapsedMs };
        }
        const ratio = maxMs / elapsedMs;
        const capped = {};
        Object.keys(counts).forEach((k) => {
            capped[k] = Math.round(counts[k] * ratio);
        });
        return { counts: capped, elapsedMs: maxMs };
    }

    /**
     * Save consumable tracking state to storage
     */
    async saveConsumableTracking(owner = dataManager.getCurrentCharacterId()) {
        try {
            // Every key below is built from `owner`, captured before the first
            // await, rather than resolved again by `writeScoped` when each
            // write runs. There are four suspension points in this method and a
            // non-immediate `storage.set` resolves only when its three-second
            // debounce fires, so the three writes are seconds apart — wide
            // enough for a switch to split one save across two characters. And
            // `onCharacterSwitching` blanks these trackers synchronously, so
            // what the resumed half writes is an EMPTY record over the arriving
            // character's stored counts, resetting their consumption rates.
            if (!owner) return false;
            if (!(await storeReadable(CONSUMABLE_TRACKER_KEY))) return false;
            if (dataManager.getCurrentCharacterId() !== owner) return false;
            const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

            // Save current player tracker
            const self = this.consumableTracker;
            const selfExcludedMs = self.excludedMs || 0;
            const rawElapsedMs = self.startTime ? Math.max(0, Date.now() - self.startTime - selfExcludedMs) : 0;
            const { counts: cappedActual, elapsedMs: cappedElapsed } = this.capToWindow(
                this.consumableTracker.actualConsumed,
                rawElapsedMs,
                MAX_WINDOW_MS
            );
            const { counts: cappedDefault } = this.capToWindow(
                this.consumableTracker.defaultConsumed,
                rawElapsedMs,
                MAX_WINDOW_MS
            );
            const toSave = {
                actualConsumed: cappedActual,
                defaultConsumed: cappedDefault,
                inventoryAmount: this.consumableTracker.inventoryAmount,
                lastUpdate: this.consumableTracker.lastUpdate,
                // What older builds read; they ignore the fields below
                elapsedMs: cappedElapsed,
                saveTimestamp: Date.now(),
                trackerVersion: TRACKER_VERSION,
                // Moved forward with the 24-hour cap, so the capped counts and the clock stay in step
                startTime: self.startTime ? Date.now() - cappedElapsed - selfExcludedMs : null,
                excludedMs: selfExcludedMs,
                lastSnapshotAt: self.lastSnapshotAt,
                trafficAt: self.trafficAt,
                silenceMs: self.silenceMs,
                silenceAtSnapshot: self.silenceAtSnapshot,
                silenceAtLastBattle: self.silenceAtLastBattle,
                runKey: self.runKey,
                lastBattleId: self.lastBattleId,
                lastWave: self.lastWave,
                lastBattleAt: self.lastBattleAt,
                waveIntervalSum: self.waveIntervalSum,
                waveIntervalCount: self.waveIntervalCount,
            };
            await storage.set(scopedFor(CONSUMABLE_TRACKER_KEY, owner), toSave, COMBAT_STORE);
            if (dataManager.getCurrentCharacterId() !== owner) return false;

            // Save party member trackers (MCS-style)
            const partyTrackersToSave = {};
            Object.keys(this.partyConsumableTrackers).forEach((playerName) => {
                const tracker = this.partyConsumableTrackers[playerName];
                if (tracker && tracker.actualConsumed && tracker.defaultConsumed && tracker.inventoryAmount) {
                    const partyExcludedMs = tracker.excludedMs || 0;
                    const rawPartyElapsedMs = tracker.startTime
                        ? Math.max(0, Date.now() - tracker.startTime - partyExcludedMs)
                        : 0;
                    const { counts: pCappedActual, elapsedMs: pCappedElapsed } = this.capToWindow(
                        tracker.actualConsumed,
                        rawPartyElapsedMs,
                        MAX_WINDOW_MS
                    );
                    const { counts: pCappedDefault } = this.capToWindow(
                        tracker.defaultConsumed,
                        rawPartyElapsedMs,
                        MAX_WINDOW_MS
                    );
                    partyTrackersToSave[playerName] = {
                        actualConsumed: pCappedActual,
                        defaultConsumed: pCappedDefault,
                        inventoryAmount: tracker.inventoryAmount || {},
                        elapsedMs: pCappedElapsed,
                        lastUpdate: tracker.lastUpdate || null,
                        saveTimestamp: Date.now(),
                        trackerVersion: TRACKER_VERSION,
                        startTime: tracker.startTime ? Date.now() - pCappedElapsed - partyExcludedMs : null,
                        excludedMs: partyExcludedMs,
                        lastSnapshotAt: tracker.lastSnapshotAt ?? null,
                        silenceAtSnapshot: tracker.silenceAtSnapshot || 0,
                    };
                }
            });
            await storage.set(scopedFor(PARTY_TRACKERS_KEY, owner), partyTrackersToSave, COMBAT_STORE);
            if (dataManager.getCurrentCharacterId() !== owner) return false;

            // Save party snapshots
            await storage.set(scopedFor(PARTY_SNAPSHOTS_KEY, owner), this.partyConsumableSnapshots, COMBAT_STORE);
            return true;
        } catch (error) {
            console.error('[Combat Stats] Error saving consumable tracking:', error);
            return false;
        }
    }

    /**
     * Reset consumable tracking (for new combat session)
     */
    async resetConsumableTracking() {
        this._resetTrackersInMemory();
        // Fire-and-forget: don't await debounced writes so callers aren't blocked
        writeScoped(CONSUMABLE_TRACKER_KEY, null, COMBAT_STORE);
        writeScoped(PARTY_TRACKERS_KEY, null, COMBAT_STORE);
        writeScoped(PARTY_SNAPSHOTS_KEY, null, COMBAT_STORE);
    }

    /**
     * Blank the in-memory trackers without touching storage.
     *
     * Split out of `resetConsumableTracking` for the character switch, which
     * must not write: the departing character's counts have their own key and
     * belong there, and clearing them under the arriving character's key would
     * be writing one character's zeroes over another character's record.
     * @private
     */
    _resetTrackersInMemory() {
        this.consumableTracker = createSelfTracker(Date.now());
        this.partyConsumableTrackers = {};
        this.partyConsumableSnapshots = {};
        this.partyLastKnownConsumables = {};
        this.connectionInterrupted = false;
    }

    /**
     * Handle battle_consumable_ability_updated event (fires on each consumption)
     * NOTE: This event only fires for the CURRENT PLAYER (solo tracking)
     * @param {Object} data - Consumable update data
     */
    async onConsumableUsed(data) {
        try {
            // Skip ability consumptions
            const itemHrid = data.consumable?.itemHrid;
            if (!itemHrid || itemHrid.includes('/ability/')) {
                return;
            }

            if (!data || !data.consumable) {
                return;
            }

            const now = Date.now();

            // Deduplicate: skip if we already processed this item within 100ms
            // (game sometimes sends duplicate events)
            const lastEventTime = this.consumableTracker.lastEventByItem[itemHrid] || 0;
            if (now - lastEventTime < 100) {
                return; // Skip duplicate event
            }
            this.consumableTracker.lastEventByItem[itemHrid] = now;
            this.noteBattleTraffic(now);

            // A snapshot that arrived ahead of this use's event has already credited
            // it: the event then carries the very count that snapshot was credited at
            const credited = this.consumableTracker.snapshotCreditedAt;
            const creditedAt = credited?.[itemHrid];
            if (credited) delete credited[itemHrid];
            if (creditedAt !== undefined && data.consumable.count === creditedAt) {
                return;
            }

            // Initialize tracking if first event
            if (!this.consumableTracker.startTime) {
                this.consumableTracker.startTime = now;
            }

            // Initialize item if first time seen (MCS-style)
            if (this.consumableTracker.actualConsumed[itemHrid] === undefined) {
                this.consumableTracker.actualConsumed[itemHrid] = 0;
                this.consumableTracker.defaultConsumed[itemHrid] = this.getDefaultConsumed(itemHrid);
            }

            // Increment consumption count
            this.consumableTracker.actualConsumed[itemHrid]++;
            this.consumableTracker.lastUpdate = now;

            // Update inventory amount from event data
            if (typeof data.consumable.count === 'number') {
                this.consumableTracker.inventoryAmount[itemHrid] = data.consumable.count;
            } else if (typeof this.consumableTracker.inventoryAmount[itemHrid] === 'number') {
                // Keep the baseline in step with the use just counted, or the next snapshot
                // would credit the same use a second time
                this.consumableTracker.inventoryAmount[itemHrid] = Math.max(
                    0,
                    this.consumableTracker.inventoryAmount[itemHrid] - 1
                );
            }

            // Persist after each consumption (MCS-style)
            await this.saveConsumableTracking();
        } catch (error) {
            console.error('[Combat Stats] Error processing consumable event:', error);
        }
    }

    /**
     * Handle new_battle message (fires during combat)
     * @param {Object} data - new_battle message data
     * @param {{socket?: WebSocket}} [context] - Dispatch context: the socket that delivered the message
     */
    async onNewBattle(data, context) {
        try {
            // Only process if we have players data
            if (!data.players || data.players.length === 0) {
                return;
            }

            const battleId = data.battleId || 0;

            // The socket this session is being fought on, for `onSocketClosed`
            // The socket that delivered this battle, which the dispatcher passes: during a reconnect or a
            // switch two sockets overlap, and the most recently attached one need not be it
            this.sessionSocket = context?.socket ?? webSocketHook.activeGameSocket ?? null;
            this.sessionOwner = dataManager.getCurrentCharacterId() || null;

            // Calculate duration from combat start time. Clamped at zero: the
            // start time is the server's clock and "now" is ours, so a short
            // run on a client a second or two behind measured negative — which
            // the session picker then rendered as no duration at all.
            const combatStartTime = new Date(data.combatStartTime).getTime() / 1000;
            const currentTime = Date.now() / 1000;
            const durationSeconds = Number.isFinite(combatStartTime) ? Math.max(0, currentTime - combatStartTime) : 0;

            // Detect new combat session and reset consumable tracking
            // Primary: battleId decreased (went back to 1 or lower)
            // Also: a different combatStartTime is a different run, even when the page was
            // closed across the change and the new run's battleId is already past the old one's
            // Fallback: combat duration is shorter than tracking duration (missed a reset while offline)
            const trackedRun = this.consumableTracker.runKey;
            const runChanged =
                Boolean(trackedRun) && Boolean(data.combatStartTime) && trackedRun !== data.combatStartTime;
            const trackedSeconds = this.calcElapsedSeconds();
            const shouldResetTracking =
                runChanged ||
                (this.currentBattleId !== null && battleId < this.currentBattleId) ||
                (trackedSeconds > 0 && durationSeconds < trackedSeconds);

            if (shouldResetTracking) {
                this.resetConsumableTracking();
            }

            // Update current battle ID
            this.currentBattleId = battleId;

            // Get current character ID to identify which player is the current user
            const currentCharacterId = dataManager.getCurrentCharacterId();
            const now = Date.now();
            // After any reset above, so a fresh tracker's clock starts here
            this.noteBattleTraffic(now);

            // Recover the consumption the event stream missed while the page was closed,
            // suspended or reconnecting. Only the current player's own entry feeds the
            // current player's tracker; party members are reconciled from theirs below.
            // Runs before anything below copies this snapshot's counts over the baseline.
            const fightingSeconds = this.estimateGapFightingSeconds(data);
            const selfPlayer = currentCharacterId
                ? data.players.find((player) => player?.character?.id === currentCharacterId)
                : undefined;
            if (selfPlayer) {
                const self = this.consumableTracker;
                const result = this.reconcileTracker(
                    self,
                    self.inventoryAmount,
                    snapshotConsumables(selfPlayer),
                    fightingSeconds,
                    now
                );
                if (!self.snapshotCreditedAt) self.snapshotCreditedAt = {};
                for (const entry of result.items) {
                    if (entry.action === 'credit') {
                        self.snapshotCreditedAt[entry.itemHrid] = self.inventoryAmount[entry.itemHrid] - entry.missed;
                    } else {
                        delete self.snapshotCreditedAt[entry.itemHrid];
                    }
                }
                this.updateRunPosition(data, now);
            }

            // Tracking time, read after any reset and reconciliation above changed it (MCS-style)
            const elapsedSeconds = this.calcElapsedSeconds();

            // Track party member consumables via inventory snapshots (MCS-style)
            const currentPartyMembers = new Set();
            data.players.forEach((player) => {
                if (!player || !player.character) return;
                const playerName = player.character.name;
                currentPartyMembers.add(playerName);

                // Skip current player (tracked via consumable events)
                if (player.character.id === currentCharacterId) {
                    return;
                }

                // Initialize snapshot storage if needed
                if (!this.partyConsumableSnapshots[playerName]) {
                    this.partyConsumableSnapshots[playerName] = {};
                }

                if (!this.partyLastKnownConsumables) {
                    this.partyLastKnownConsumables = {};
                }
                if (!this.partyLastKnownConsumables[playerName]) {
                    this.partyLastKnownConsumables[playerName] = {};
                }

                // Initialize tracker if needed
                if (!this.partyConsumableTrackers[playerName]) {
                    this.partyConsumableTrackers[playerName] = this.createPartyTracker();
                    // Initialize all consumables
                    if (player.combatConsumables) {
                        player.combatConsumables.forEach((consumable) => {
                            if (consumable && consumable.itemHrid) {
                                this.partyConsumableTrackers[playerName].actualConsumed[consumable.itemHrid] = 0;
                                this.partyConsumableTrackers[playerName].defaultConsumed[consumable.itemHrid] =
                                    this.getDefaultConsumed(consumable.itemHrid);
                            }
                        });
                    }
                }

                const tracker = this.partyConsumableTrackers[playerName];

                // Remove items no longer in consumables
                if (player.combatConsumables && player.combatConsumables.length > 0 && tracker) {
                    const currentConsumableHrids = new Set(
                        player.combatConsumables.filter((c) => c && c.itemHrid).map((c) => c.itemHrid)
                    );

                    Object.keys(tracker.actualConsumed).forEach((itemHrid) => {
                        if (!currentConsumableHrids.has(itemHrid)) {
                            delete tracker.actualConsumed[itemHrid];
                            delete tracker.defaultConsumed[itemHrid];
                            delete tracker.inventoryAmount[itemHrid];
                        }
                    });
                }

                // Credit what this member used since their last snapshot (however long ago
                // that was), from their own entry only; the loop below takes the new baseline.
                // The baseline is the tracker's own `inventoryAmount`, saved in the same record
                // as its counts and its clock: the separate snapshots record lands seconds
                // apart, and a stale copy of it would credit the same drop a second time.
                this.reconcileTracker(
                    tracker,
                    tracker.inventoryAmount,
                    snapshotConsumables(player),
                    fightingSeconds,
                    now
                );

                // Track current consumables
                const currentlySeenHrids = new Set();
                if (player.combatConsumables && player.combatConsumables.length > 0) {
                    player.combatConsumables.forEach((consumable) => {
                        if (!consumable || !consumable.itemHrid) return;

                        const itemHrid = consumable.itemHrid;
                        const currentCount = consumable.count;

                        currentlySeenHrids.add(itemHrid);

                        this.partyLastKnownConsumables[playerName][itemHrid] = {
                            itemHrid: itemHrid,
                            lastSeenCount: currentCount,
                        };

                        // Update snapshot
                        this.partyConsumableSnapshots[playerName][itemHrid] = currentCount;
                        tracker.inventoryAmount[itemHrid] = currentCount;
                    });
                }

                // Handle items that disappeared (ran out or removed)
                Object.keys(this.partyLastKnownConsumables[playerName] || {}).forEach((itemHrid) => {
                    if (!currentlySeenHrids.has(itemHrid)) {
                        const previousCount = this.partyConsumableSnapshots[playerName][itemHrid];
                        if (previousCount !== undefined && previousCount > 0) {
                            tracker.inventoryAmount[itemHrid] = 0;
                            this.partyConsumableSnapshots[playerName][itemHrid] = 0;
                        }
                    }
                });
            });

            // Clean up trackers for players who left the party
            Object.keys(this.partyConsumableTrackers).forEach((playerName) => {
                if (!currentPartyMembers.has(playerName)) {
                    delete this.partyConsumableTrackers[playerName];
                }
            });
            Object.keys(this.partyConsumableSnapshots).forEach((playerName) => {
                if (!currentPartyMembers.has(playerName)) {
                    delete this.partyConsumableSnapshots[playerName];
                }
            });
            Object.keys(this.partyLastKnownConsumables).forEach((playerName) => {
                if (!currentPartyMembers.has(playerName)) {
                    delete this.partyLastKnownConsumables[playerName];
                }
            });

            // The party trackers are persisted once, at the end of this handler,
            // together with the player's own — one write per wave, not two

            // Extract combat data
            const combatData = {
                timestamp: Date.now(),
                battleId: battleId,
                combatStartTime: data.combatStartTime,
                // Which zone this run was, so a restored snapshot can be told
                // apart from the run the character is in now. Time alone cannot
                // do it: a character left fighting overnight has an old snapshot
                // of a run that is still going.
                actionHrid: this.currentCombatAction(),
                durationSeconds: durationSeconds,
                players: data.players.map((player) => {
                    // Check if this player is the current user by matching character ID
                    const isCurrentPlayer = player.character.id === currentCharacterId;

                    // Process consumables
                    const consumablesWithConsumed = [];
                    const seenItems = new Set();

                    if (player.combatConsumables) {
                        for (const consumable of player.combatConsumables) {
                            if (seenItems.has(consumable.itemHrid)) {
                                continue;
                            }
                            seenItems.add(consumable.itemHrid);

                            // Get tracking data
                            let actualConsumed;
                            let defaultConsumed;
                            let trackingElapsed;
                            let inventoryAmount;

                            if (isCurrentPlayer) {
                                // Current player: use event-based tracking
                                this.consumableTracker.inventoryAmount[consumable.itemHrid] = consumable.count;
                                actualConsumed = this.consumableTracker.actualConsumed[consumable.itemHrid] || 0;
                                defaultConsumed =
                                    this.consumableTracker.defaultConsumed[consumable.itemHrid] ||
                                    this.getDefaultConsumed(consumable.itemHrid);
                                trackingElapsed = elapsedSeconds;
                                inventoryAmount =
                                    this.consumableTracker.inventoryAmount[consumable.itemHrid] || consumable.count;
                            } else {
                                // Party member: use snapshot-based tracking (MCS-style)
                                const playerName = player.character.name;
                                const partyTracker = this.partyConsumableTrackers[playerName];

                                if (partyTracker) {
                                    actualConsumed = partyTracker.actualConsumed[consumable.itemHrid] || 0;
                                    defaultConsumed =
                                        partyTracker.defaultConsumed[consumable.itemHrid] ||
                                        this.getDefaultConsumed(consumable.itemHrid);
                                    trackingElapsed = this.calcElapsedSeconds(partyTracker);
                                    inventoryAmount =
                                        partyTracker.inventoryAmount[consumable.itemHrid] || consumable.count;
                                } else {
                                    // Fallback if tracker not initialized yet
                                    actualConsumed = 0;
                                    defaultConsumed = this.getDefaultConsumed(consumable.itemHrid);
                                    trackingElapsed = 0;
                                    inventoryAmount = consumable.count;
                                }
                            }

                            // MCS formula (exact match to MCS code lines 26027-26030)
                            const DEFAULT_TIME = 10 * 60; // 600 seconds
                            const actualRate = trackingElapsed > 0 ? actualConsumed / trackingElapsed : 0;
                            const combinedRate = (defaultConsumed + actualConsumed) / (DEFAULT_TIME + trackingElapsed);
                            const rawRate = actualRate * 0.9 + combinedRate * 0.1;

                            // Cap at game-theoretical maximum (cooldown-based):
                            // Drinks: 300s base / 1.2 max concentration (+20 guzzling pouch) = 345.6/day
                            // Food: 60s base cooldown = 1440/day (drink concentration doesn't affect food)
                            const maxRatePerDay = this.getMaxRatePerDay(consumable.itemHrid);
                            const consumptionRate = Math.min(rawRate, maxRatePerDay / 86400);

                            // Per-day rate (MCS uses Math.ceil)
                            const consumedPerDay = Math.ceil(consumptionRate * 86400);

                            // Estimate for this combat session
                            const estimatedConsumed = consumptionRate * durationSeconds;

                            // Time until inventory runs out (MCS-style)
                            const timeToZeroSeconds =
                                consumptionRate > 0 ? inventoryAmount / consumptionRate : Infinity;

                            const consumableData = {
                                itemHrid: consumable.itemHrid,
                                currentCount: consumable.count,
                                actualConsumed: actualConsumed,
                                defaultConsumed: defaultConsumed,
                                consumed: estimatedConsumed,
                                consumedPerDay: consumedPerDay,
                                consumptionRate: consumptionRate,
                                elapsedSeconds: trackingElapsed,
                                inventoryAmount: inventoryAmount,
                                timeToZeroSeconds: timeToZeroSeconds,
                            };
                            consumablesWithConsumed.push(consumableData);
                        }
                    }

                    return {
                        name: player.character.name,
                        characterId: player.character.id,
                        isCurrentPlayer: isCurrentPlayer,
                        loot: player.totalLootMap || {},
                        experience: player.totalSkillExperienceMap || {},
                        deathCount: player.deathCount || 0,
                        consumables: consumablesWithConsumed,
                        combatStats: {
                            combatDropQuantity: player.combatDetails?.combatStats?.combatDropQuantity || 0,
                            combatDropRate: player.combatDetails?.combatStats?.combatDropRate || 0,
                            combatRareFind: player.combatDetails?.combatStats?.combatRareFind || 0,
                            drinkConcentration: player.combatDetails?.combatStats?.drinkConcentration || 0,
                        },
                    };
                }),
            };

            // A different run means the one before it has ended, which is the
            // first moment that is knowable — nothing on the wire announces it.
            // Archived before the snapshot is replaced, so what goes into the
            // history is that session's final state.
            const key = sessionKey(combatData);
            if (this.sessionKey && key && key !== this.sessionKey) {
                if (this.latestCombatData) archiveSession(this.latestCombatData);
                // An interruption belonged to the session that just ended
                this.connectionInterrupted = false;
            }
            if (key) this.sessionKey = key;
            if (this.connectionInterrupted) combatData.connectionInterrupted = true;

            // Store in memory
            this.latestCombatData = combatData;

            // Store in IndexedDB — unless storage cannot be read, in which
            // case the stored run stays and memory carries this one
            // `currentCharacterId` was captured at the top of this handler and
            // `combatData` is built entirely from it. `storeReadable` awaits a
            // real read whenever its five-second probe is cold, so a switch can
            // land between it and the write — and `writeScoped` would resolve
            // the key against whoever is current by then, filing this run's
            // loot, xp and party roster under the arriving character.
            if (currentCharacterId && (await storeReadable(LATEST_RUN_KEY))) {
                if (dataManager.getCurrentCharacterId() !== currentCharacterId) return;
                await storage.set(scopedFor(LATEST_RUN_KEY, currentCharacterId), combatData, COMBAT_STORE);
            }

            // Save the tracking state (player and party alike) once per wave
            await this.saveConsumableTracking(currentCharacterId);
        } catch (error) {
            console.error('[Combat Stats] Error collecting combat data:', error);
        }
    }

    /**
     * The combat zone the character is fighting in right now, if any.
     *
     * @returns {string|null} Action hrid, or null when not in combat or when the
     *   character's actions have not loaded yet — which are different things and
     *   the caller has to treat them differently
     */
    currentCombatAction() {
        try {
            const actions = dataManager.getCurrentActions?.();
            if (!Array.isArray(actions)) return null;

            // The running action, and only if it is combat — a combat action
            // queued behind a running craft is not being fought
            const combat = runningCombatAction(actions);
            return combat?.actionHrid || null;
        } catch {
            return null;
        }
    }

    /**
     * Whether a run restored from storage still describes what is happening.
     *
     * A restored snapshot is a photograph of the run as it stood when the tab was
     * last open, and there are two quite different reasons it might be old:
     *
     * - **The run is still going.** The character kept fighting while the tab was
     *   shut, so the snapshot understates a run that is very much alive. Showing
     *   it is right: it is the correct run, a little behind, and the next battle
     *   corrects it. Blanking here would reintroduce exactly the gap this was
     *   meant to close.
     * - **The run is over.** Combat stopped hours ago and the figures describe
     *   something finished. Presenting them as live is the thing worth avoiding —
     *   the per-day rates keep dividing by a clock that never stopped, so they
     *   decay towards zero and read as a run going badly rather than as a run
     *   that is not happening.
     *
     * Elapsed time cannot tell those apart, which is why the current action
     * decides it and the clock is only the fallback for when there is nothing to
     * ask. A different zone in progress means the snapshot is somebody else's
     * run entirely.
     *
     * @returns {boolean}
     */
    isRestoredRunCurrent() {
        const data = this.latestCombatData;
        if (!data) return false;

        const current = this.currentCombatAction();

        // Fighting somewhere else: whatever this is, it is not that
        if (current && data.actionHrid && current !== data.actionHrid) return false;
        // The same run, still under way — age is irrelevant
        if (current && (!data.actionHrid || current === data.actionHrid)) return true;

        // Not in combat, or not yet able to tell. A short grace period so the run
        // you have just finished is still on screen while you look at it, and
        // then it belongs to the popup rather than to the overlay.
        return Date.now() - (data.timestamp || 0) < STALE_AFTER_MS;
    }

    /**
     * Get the latest combat data
     *
     * Live data is returned as-is. A snapshot restored from storage is withheld
     * once it stops describing what is happening — see `isRestoredRunCurrent`.
     *
     * @returns {Object|null} Latest combat data
     */
    getLatestData() {
        if (!this.latestCombatData) return null;
        if (!this.latestCombatData.restored) return this.latestCombatData;

        return this.isRestoredRunCurrent() ? this.latestCombatData : null;
    }

    /**
     * The last run this character fought, however long ago it ended.
     *
     * `getLatestData` withholds a restored run once it stops describing what is
     * happening, which is right for an overlay and wrong for a ledger: a run is
     * only archived when the NEXT one starts, so a run that finished before a
     * reload sits here, withheld and unarchived, until the character fights
     * again. Anything totting up what past combat earned needs it regardless.
     *
     * @returns {Object|null} The snapshot, live or restored, or null
     */
    getLastRun() {
        return this.latestCombatData;
    }

    /**
     * Load latest combat data from storage
     * @returns {Promise<Object|null>} Latest combat data
     */
    async loadLatestData() {
        const data = await readScoped(LATEST_RUN_KEY, COMBAT_STORE, null, DISCARD_LEGACY);
        if (data) {
            // Marked so `getLatestData` knows this came out of storage rather
            // than off the wire, and can stop offering it once it stops being
            // true. Live data is never withheld.
            this.latestCombatData = { ...data, restored: true };

            // Without this, a run that finished while the tab was closed (or
            // between one page load and the next) is never archived: the first
            // `new_battle` after reload is for whatever the character is doing
            // now, `this.sessionKey` was still null from the constructor, and
            // `onNewBattle`'s "a different key means the old one just ended"
            // check only fires when `this.sessionKey` is already set. The
            // restored run was silently dropped instead of archived, and its
            // loot never reached the gold attribution's combat row.
            this.sessionKey = sessionKey(this.latestCombatData);
            // A restored session still in progress keeps its interruption: the next new_battle of the same
            // session builds its snapshot from this flag, and would otherwise overwrite the stored mark
            if (data.connectionInterrupted === true) this.connectionInterrupted = true;
        }
        return this.latestCombatData;
    }

    /**
     * Cleanup
     */
    cleanup() {
        // First of all, so an `initialize()` parked on either storage read
        // cannot resume into the handler fields this teardown is about to null.
        noteTeardown(this);
        if (this.newBattleHandler) {
            webSocketHook.off('new_battle', this.newBattleHandler);
            this.newBattleHandler = null;
        }

        if (this.consumableEventHandler) {
            webSocketHook.off('battle_consumable_ability_updated', this.consumableEventHandler);
            this.consumableEventHandler = null;
        }

        if (this.battleTrafficHandler) {
            webSocketHook.off('battle_updated', this.battleTrafficHandler);
            this.battleTrafficHandler = null;
        }

        if (this.socketCloseHandler) {
            webSocketHook.offSocketEvent('close', this.socketCloseHandler);
            this.socketCloseHandler = null;
        }

        this.isInitialized = false;
        this.latestCombatData = null;
        this.currentBattleId = null;
        // Note: Don't reset consumableTracker here - it's persisted
    }
}

const combatStatsDataCollector = new CombatStatsDataCollector();

export default combatStatsDataCollector;
