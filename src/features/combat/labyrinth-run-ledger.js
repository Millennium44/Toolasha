/**
 * Labyrinth run ledger
 *
 * What each run left unspent. The Consumables panel plans a run as full
 * consumption of the whole torch/shroud/beacon capacity — the honest ceiling —
 * but the interesting question afterwards is the opposite one: how much came
 * back. A run that keeps ending with two hundred torches to spare is a run
 * whose "rush for exit" floor could come down (rushing fewer floors means
 * fully clearing more of them, and a full clear costs a floor's whole grid in
 * torches where a rush costs one path across it).
 *
 * So every run's ending is recorded: the last supply counts the run reported
 * before it ended, the deepest floor it reached, and when. A bounded ring,
 * character-scoped, in the labyrinth store.
 *
 * The transition detection mirrors labyrinth-run-alerts, including its two
 * traps: a payload that says nothing about the run is not evidence the run
 * ended, and the server re-sends labyrinth messages after a run ends, so each
 * ending is keyed by the run's own start stamp and recorded once.
 *
 * ## The run that ended twice
 *
 * "Recorded once" has to hold across a reload as well as within a session. A
 * post-run re-send that omits `isActive` still carries the grid and the queued
 * path, which is exactly what the active test falls back on, so it reads as a
 * live run — and the supply figures on it are no longer the run's own stock but
 * the restocked pile (the trap `labyrinth-supplies` documents from the other
 * side). Re-opening the finished run on those counts banked it a second time
 * with a whole capacity left unspent, and the ring's merge lets the newer
 * record win: the run's true leftovers were replaced by its capacity. So a key
 * seen to end is never re-opened, and an ending already in the ring is never
 * appended over.
 *
 * ## Endings nobody watched
 *
 * A socket that drops mid-run and reconnects after the next run has started
 * shows a new `startedAt` with no `ended` sighting in between. The run in hand
 * did end — so it is closed out on the last counts seen and marked
 * `endedByInference`, rather than dropped, which used to lose that run's whole
 * torch/shroud/beacon spend. The mark is load-bearing: those counts are a lower
 * bound (whatever the run spent after the last sighting went unseen), so an
 * inferred close is kept as a record but excluded from every average, on the
 * same grounds as a run joined mid-way.
 *
 * ## The grid arithmetic
 *
 * From the game's own guide: floor 1 is a 4×4 grid, each floor one wider, to
 * 8×8 at floor 5 and beyond; entry at one corner, exit at the opposite. A
 * torch is spent per room entered, so a full clear costs the grid squared and
 * a rush costs the shortest corner-to-corner path — one room per step,
 * (g−1)+(g−1)+1 rooms. Those two figures per floor are what the rush-floor
 * advisor sums.
 */

import config from '../../core/config.js';
import webSocketHook from '../../core/websocket.js';
import dataManager from '../../core/data-manager.js';
import { isFromActiveSocket } from './labyrinth-activity.js';
import { createPersistedRecord, mergeById } from '../../utils/persisted-record.js';
import { registerSyncMerge } from '../../utils/sync-merge-registry.js';
import { labyrinthRunState } from '../notifications/notification-predicates.js';

const STORAGE_KEY = 'labyrinthRunLedger';
const STORE = 'labyrinth';
/** Endings kept; older ones fall off the back */
const MAX_RUNS = 30;

/** Newest ending first, the order the ring is kept in */
const newestFirst = (a, b) => (Number(b?.endedAt) || 0) - (Number(a?.endedAt) || 0);

/**
 * The ring on disk, kept through the shared load/save discipline: a read that
 * could not be made cannot truncate it to one run, and a save folds in
 * endings another tab recorded. Merged by the run's own start stamp (`key`),
 * newest first, capped at MAX_RUNS.
 */
const mergeLedgers = (base, fresh) => mergeById((run) => run?.key, newestFirst)(base, fresh).slice(0, MAX_RUNS);

const ledgerRecord = createPersistedRecord({
    base: STORAGE_KEY,
    store: STORE,
    empty: () => [],
    merge: mergeLedgers,
    label: 'LabyrinthRunLedger',
});

/*
 * Registered so a cross-device sync PULL combines this record instead of
 * overwriting it. Registration runs at import time, which is long before the
 * earliest pull (the staggered startup pull, 20s+ after load), so the registry
 * is complete by the time sync consults it. See utils/sync-merge-registry.js.
 */
registerSyncMerge({
    store: STORE,
    base: STORAGE_KEY,
    merge: mergeLedgers,
    label: 'Labyrinth run ledger',
    // Every write goes through `ledgerRecord.update`, a plain persisted record that folds stored under memory
    liveSafe: true,
});

/**
 * Fold one labyrinth sighting into the tracker's state, pure.
 *
 * An active sighting with no `startedAt` and no run in hand opens nothing: a
 * genuine run always carries the server's stamp, and that is the only name a
 * run may be known by.
 *
 * @param {Object} state - `{phase, run, endedKey}` where run is
 *   `{key, floor, left: {torch, shroud, beacon}, itemHrids}` and `endedKey`
 *   names the last run seen to end, which no re-send may re-open
 * @param {Object|null} labyrinth - A payload's labyrinth object
 * @param {number} nowMs - Clock
 * @returns {{state: Object, ended: Object|null}} The next state, and a
 *   completed run record when this sighting was the run's ending
 */
export function foldSighting(state, labyrinth, nowMs) {
    const phase = labyrinthRunState(labyrinth);
    // Nothing about the run is not the run ending — the alerts' hard lesson
    if (phase === 'unknown') return { state, ended: null };

    if (phase === 'active') {
        // A run is named by the server's `startedAt`, which every genuine
        // labyrinth payload carries and three modules key the run on. An
        // active sighting with no stamp and no run in hand is therefore not a
        // run beginning — it is the post-run re-send, which still carries the
        // grid and so reads as active. Minting a synthetic key for it opened a
        // phantom run that neither ending guard could catch: `endedKey` names
        // the real run's key and the ring holds that key, so a made-up one
        // matches nothing, and it banked the restocked supply pile as a run's
        // spend. The same invention duplicated a run across a reload, since
        // the second load minted a different name for the same run. No run is
        // the safe answer: a stamped payload that follows opens it properly.
        const key = labyrinth?.startedAt ? String(labyrinth.startedAt) : (state.run?.key ?? null);
        if (!key) return { state, ended: null };
        // The run that just ended is not a new run. The server re-sends
        // labyrinth messages after a run ends, and a re-send that omits
        // `isActive` still carries the grid and the queued path — which is
        // what `labyrinthRunState` falls back on, so it reads as active. That
        // re-opened the finished run on counts that are no longer the run's:
        // once it is over the payload's supply figures are the restocked pile,
        // so the run was banked a second time with a whole capacity left
        // unspent. Remembered by key, so a genuinely new `startedAt` is
        // followed as normal.
        if (!state.run && state.endedKey && state.endedKey === key) return { state, ended: null };
        const previous = state.run?.key === key ? state.run : null;
        // A different run arriving with no `ended` sighting between them — the
        // socket dropped mid-run and reconnected after the next run had begun.
        // The run in hand did end; nothing was here to watch it. Closing it on
        // the last counts seen keeps its spend, where discarding it lost the
        // whole run. Marked, because those counts are a lower bound: whatever
        // the run spent after the last sighting is unrecorded.
        const inferred =
            state.phase === 'active' && state.run && state.run.key !== key
                ? { ...state.run, endedAt: nowMs, endedByInference: true }
                : null;
        const count = (field) => {
            const n = Number(labyrinth?.[field]);
            return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : (previous?.left?.[field] ?? null);
        };
        const left = {
            torch: count('torchCount'),
            shroud: count('shroudCount'),
            beacon: count('beaconCount'),
        };
        // The first counts a run was seen with stand as its start, so the
        // ending can say what was spent. A run first seen mid-way (a reload)
        // starts from wherever it was seen — the usage it reports is a floor,
        // not an overstatement
        const start = {
            torch: previous?.start?.torch ?? left.torch,
            shroud: previous?.start?.shroud ?? left.shroud,
            beacon: previous?.start?.beacon ?? left.beacon,
        };
        // Only a run first seen at the door measures true spend; one first
        // seen on floor 2+ was joined mid-way and its start is just "wherever
        // we came in"
        const firstFloor = Math.floor(Number(labyrinth?.currentFloor) || 0);
        const startTrusted = previous ? (previous.startTrusted ?? false) : firstFloor <= 1;
        // True spend, accumulated sighting to sighting: a fall in `left` is a
        // room entered and is added in, a rise is a mid-run shop purchase (the
        // labyrinth shop sells more supplies for points earned in the run) and
        // is left alone rather than netted against past spending. See
        // observedUse for why this beats `start - left` once a run can buy
        // back in.
        const spent = {};
        for (const kind of ['torch', 'shroud', 'beacon']) {
            const prevLeft = previous?.left?.[kind];
            const fall = Number.isFinite(prevLeft) && Number.isFinite(left[kind]) ? prevLeft - left[kind] : 0;
            spent[kind] = (previous?.spent?.[kind] ?? 0) + Math.max(0, fall);
        }
        return {
            state: {
                phase: 'active',
                endedKey: state.endedKey ?? null,
                run: {
                    key,
                    startTrusted,
                    floor: Math.max(previous?.floor ?? 0, Math.floor(Number(labyrinth?.currentFloor) || 0)),
                    left,
                    start,
                    spent,
                    itemHrids: {
                        torch: labyrinth?.torchItemHrid || previous?.itemHrids?.torch || null,
                        shroud: labyrinth?.shroudItemHrid || previous?.itemHrids?.shroud || null,
                        beacon: labyrinth?.beaconItemHrid || previous?.itemHrids?.beacon || null,
                    },
                },
            },
            ended: inferred,
        };
    }

    // phase === 'ended': only an active→ended edge with a run in hand records
    if (state.phase !== 'active' || !state.run) {
        return { state: { phase: 'ended', run: null, endedKey: state.endedKey ?? null }, ended: null };
    }
    return {
        state: { phase: 'ended', run: null, endedKey: state.run.key },
        ended: { ...state.run, endedAt: nowMs },
    };
}

class LabyrinthRunLedger {
    constructor() {
        this.state = { phase: 'unknown', run: null };
        this.unregister = null;
        this.recorded = new Set();
        /** Whose endings the record in memory holds; a change means forget them first */
        this.ledgerOwner = null;
        /** Whose run `state` is following; the same rule, for the run in flight */
        this.stateOwner = null;
    }

    /**
     * The ring, with the departing character's endings forgotten when the
     * character has changed since — the key is resolved per access, and the
     * memory behind it must never be written under another character's key.
     * @returns {Object} The persisted record
     */
    _ledger() {
        const owner = dataManager.getCurrentCharacterId?.() || null;
        if (owner !== this.ledgerOwner) {
            ledgerRecord.reset();
            this.ledgerOwner = owner;
        }
        return ledgerRecord;
    }

    initialize() {
        if (this.unregister) return;
        const onUpdate = (data, context) => {
            if (!isFromActiveSocket(context)) return;
            try {
                this.observe(data?.labyrinth);
            } catch (error) {
                console.error('[LabyrinthRunLedger] Handling a labyrinth update failed:', error);
            }
        };
        webSocketHook.on('labyrinth_updated', onUpdate);
        this.unregister = () => webSocketHook.off('labyrinth_updated', onUpdate);

        // The character data in hand at start-up says whether a run is already
        // going, so an ending seen later has an active edge to fall from
        const lab = dataManager.characterData?.characterLabyrinth || dataManager.characterData?.labyrinth;
        if (lab) this.observe(lab);
    }

    cleanup() {
        this.unregister?.();
        this.unregister = null;
        this.state = { phase: 'unknown', run: null };
        this.stateOwner = null;
        this.recorded.clear();
    }

    /**
     * The feature registry tears features down by calling `disable()`, so a
     * `cleanup()` alone is never called on a character switch — which left the
     * websocket handler hooked and the departing character's run still in
     * flight. Aliased rather than renamed: the module has always called this
     * cleanup, and both names are now honoured.
     */
    disable() {
        this.cleanup();
    }

    /** @param {Object|null} labyrinth - A payload's labyrinth object */
    observe(labyrinth) {
        // A run in flight belongs to whoever was running it. The arriving
        // character's first sighting reports no active labyrinth, which reads
        // as the active→ended edge and would file the departing character's
        // torch and shroud spend into the arriving character's ledger — the
        // key is resolved when the append runs, not when the run started.
        // Forgetting the run instead loses it, which is the trade `_ledger`
        // already makes for the same reason: a lost run beats a misfiled one.
        const owner = dataManager.getCurrentCharacterId?.() || null;
        if (owner !== this.stateOwner) {
            this.state = { phase: 'unknown', run: null };
            this.recorded.clear();
            this.stateOwner = owner;
        }

        const { state, ended } = foldSighting(this.state, labyrinth, Date.now());
        this.state = state;
        if (ended && !this.recorded.has(ended.key)) {
            this.recorded.add(ended.key);
            this._append(ended).catch((error) =>
                console.error('[LabyrinthRunLedger] Recording a run ending failed:', error)
            );
        }
    }

    /**
     * Append one ending to the ring. Loaded first, so a read that could not be
     * made keeps what is in memory rather than truncating the ring to this
     * one run; the save itself folds in what another tab stored meanwhile.
     * @param {Object} ended - The ending
     * @returns {Promise<boolean>} Whether a write landed
     */
    async _append(ended) {
        const ledger = this._ledger();
        await ledger.load();
        // A run's first ending stands. `recorded` only knows this session, and
        // the ring's merge lets what is in memory win over what is stored — so
        // a run re-recorded after a reload (the server's post-run re-sends land
        // with no memory of what was already banked) would replace its true
        // leftovers with a post-run snapshot rather than sit beside it.
        if (ledger.get().some((run) => run?.key === ended.key)) return false;
        return ledger.update((runs) => [ended, ...runs].slice(0, MAX_RUNS));
    }

    /**
     * The recorded endings, newest first.
     * @returns {Promise<Array<Object>>}
     */
    async runs() {
        if (!config.getSetting('labyrinthRunLedger')) return [];
        const ledger = this._ledger();
        await ledger.load();
        return ledger.get().slice();
    }
}

const labyrinthRunLedger = new LabyrinthRunLedger();
export default labyrinthRunLedger;
