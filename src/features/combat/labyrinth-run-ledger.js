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
import { createPersistedRecord, mergeById } from '../../utils/persisted-record.js';
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
const ledgerRecord = createPersistedRecord({
    base: STORAGE_KEY,
    store: STORE,
    empty: () => [],
    merge: (stored, memory) => mergeById((run) => run?.key, newestFirst)(stored, memory).slice(0, MAX_RUNS),
    label: 'LabyrinthRunLedger',
});

/**
 * The grid width of a floor — 4×4 on floor 1, one wider per floor, 8×8 from
 * floor 5 on (the game guide's own table).
 * @param {number} floor - 1-based floor number
 * @returns {number}
 */
export function gridSize(floor) {
    const f = Math.max(1, Math.floor(Number(floor) || 1));
    return Math.min(3 + f, 8);
}

/** Rooms a full clear of a floor enters — the whole grid. */
export function roomsFullClear(floor) {
    const g = gridSize(floor);
    return g * g;
}

/** Rooms a rush across a floor enters — the shortest corner-to-corner path. */
export function roomsRush(floor) {
    const g = gridSize(floor);
    return 2 * g - 1;
}

/**
 * Torches a run costs, one per room entered: floors at or under the rush
 * floor are crossed by the shortest path, floors above it are fully cleared.
 *
 * ("Rush for exit up to floor N" — the game's own setting — rushes the early
 * floors and clears the rest, which is the shape this sums.)
 *
 * @param {number} rushFloor - Floors 1..rushFloor are rushed; 0 rushes none
 * @param {number} deepestFloor - The last floor the run reaches
 * @returns {number} Rooms entered, i.e. torches spent
 */
export function torchesForPlan(rushFloor, deepestFloor) {
    const deepest = Math.max(1, Math.floor(Number(deepestFloor) || 1));
    const rush = Math.max(0, Math.floor(Number(rushFloor) || 0));
    let rooms = 0;
    for (let floor = 1; floor <= deepest; floor++) {
        rooms += floor <= rush ? roomsRush(floor) : roomsFullClear(floor);
    }
    return rooms;
}

/**
 * The advisor's table: what a run to `deepestFloor` costs in torches at each
 * candidate rush floor, beside the capacity, so "can I rush less?" is a read
 * rather than a calculation.
 *
 * @param {number} deepestFloor - The floor runs actually reach
 * @param {number} torchCap - What a run can carry
 * @returns {Array<{rushFloor: number, torches: number, fits: boolean}>}
 */
export function rushFloorTable(deepestFloor, torchCap) {
    const deepest = Math.max(1, Math.floor(Number(deepestFloor) || 1));
    const cap = Math.max(0, Math.floor(Number(torchCap) || 0));
    const rows = [];
    for (let rush = 0; rush <= deepest; rush++) {
        const torches = torchesForPlan(rush, deepest);
        rows.push({ rushFloor: rush, torches, fits: cap > 0 ? torches <= cap : false });
    }
    return rows;
}

/**
 * Fold one labyrinth sighting into the tracker's state, pure.
 *
 * @param {Object} state - `{phase, run}` where run is
 *   `{key, floor, left: {torch, shroud, beacon}, itemHrids}`
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
        const key = labyrinth?.startedAt ? String(labyrinth.startedAt) : (state.run?.key ?? `run-${nowMs}`);
        const previous = state.run?.key === key ? state.run : null;
        const count = (field) => {
            const n = Number(labyrinth?.[field]);
            return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : (previous?.left?.[field] ?? null);
        };
        return {
            state: {
                phase: 'active',
                run: {
                    key,
                    floor: Math.max(previous?.floor ?? 0, Math.floor(Number(labyrinth?.currentFloor) || 0)),
                    left: {
                        torch: count('torchCount'),
                        shroud: count('shroudCount'),
                        beacon: count('beaconCount'),
                    },
                    itemHrids: {
                        torch: labyrinth?.torchItemHrid || previous?.itemHrids?.torch || null,
                        shroud: labyrinth?.shroudItemHrid || previous?.itemHrids?.shroud || null,
                        beacon: labyrinth?.beaconItemHrid || previous?.itemHrids?.beacon || null,
                    },
                },
            },
            ended: null,
        };
    }

    // phase === 'ended': only an active→ended edge with a run in hand records
    if (state.phase !== 'active' || !state.run) {
        return { state: { phase: 'ended', run: null }, ended: null };
    }
    return {
        state: { phase: 'ended', run: null },
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
        const onUpdate = (data) => {
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
    }

    /** @param {Object|null} labyrinth - A payload's labyrinth object */
    observe(labyrinth) {
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
