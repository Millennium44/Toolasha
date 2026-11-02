/**
 * The difficulty tier the player last RAN each combat zone at, remembered per character.
 *
 * A task card's combat estimate (and Go, which opens the zone) needs a tier. The player's own action
 * queue answers it while the zone is in the queue; once the zone has left the queue nothing did, and the
 * estimate fell back to T0 for a player who runs that zone at T3. This remembers the last tier the
 * server told us the character actually fought each zone at.
 *
 * ## Where it is recorded from
 *
 * The action data the server sends (`init_character_data` on login, `actions_updated` as the queue
 * moves; both reach `dataManager.getCurrentActions()`), never the Difficulty combobox in the page. So
 * it records with no panel or tab on screen. Only the RUNNING combat action is recorded
 * (`runningCombatAction`): an action merely queued behind it may never run, and a tier set on a queued
 * copy is not a tier the player fought. (Reads are wider: a zone sitting in the queue at all, running
 * or queued, beats the memory, because the queue is the freshest statement of what the player set up.)
 * A tier of 0 is a real tier: running a zone at T0 overwrites a remembered T3.
 *
 * ## Shape and sync
 *
 * `combatZoneTiers_<characterId>` in the `settings` store: `{ [zoneHrid]: { tier, at } }`. `at` is the
 * moment the tier last CHANGED for that zone (an unchanged tier is not rewritten). The fold is per
 * zone, the later `at` winning and a tie going to the incoming side. An older build does not own the
 * key (it is not in its ownership list), so it neither reads nor syncs it and leaves the stored value
 * alone; a build with no record reads an empty map. Rolling back loses nothing.
 *
 * ## Loaded versus empty
 *
 * Reads answer `null` until the character's record has been read from storage (`isReady()`), and the
 * resolver then says the T0 it falls back to is still pending. `ZONE_TIER_MEMORY_EVENT` fires when the
 * record arrives or changes, so a card that estimated at T0 meanwhile can redo its estimate.
 *
 * Lives in `utils` and is shared by global (rollup.config.js) because the recorder (ui bundle), the
 * task cards and the Task Statistics rows all read the one in-memory record.
 */

import dataManager from '../core/data-manager.js';
import { createPersistedRecord } from './persisted-record.js';
import { registerSyncMerge } from './sync-merge-registry.js';
import { runningCombatAction, lastUsedTierForZone } from './combat-actions.js';

/** Storage key base; the character id is appended by `character-key.js` */
export const ZONE_TIERS_KEY = 'combatZoneTiers';

/** Emitted on the data manager when the record arrives or a remembered tier changes */
export const ZONE_TIER_MEMORY_EVENT = 'zone_tier_memory_changed';

/** @param {*} entry @returns {boolean} A well-formed `{tier, at}` */
function validEntry(entry) {
    return Boolean(entry) && Number.isInteger(entry.tier) && entry.tier >= 0 && Number.isFinite(Number(entry.at));
}

/**
 * Fold two records for one character: per zone, the later change wins, a tie going to `fresh`.
 * Malformed entries are dropped, so a record from a future build that this one cannot read is ignored.
 * @param {*} base - The older copy (stored, or this device's)
 * @param {*} fresh - The copy folded on top
 * @returns {Object} `{ [zoneHrid]: { tier, at } }`
 */
export function mergeZoneTiers(base, fresh) {
    const out = {};
    for (const side of [base, fresh]) {
        if (!side || typeof side !== 'object' || Array.isArray(side)) continue;
        for (const [zone, entry] of Object.entries(side)) {
            if (!validEntry(entry)) continue;
            if (!out[zone] || Number(entry.at) >= Number(out[zone].at)) out[zone] = { tier: entry.tier, at: entry.at };
        }
    }
    return out;
}

const record = createPersistedRecord({
    base: ZONE_TIERS_KEY,
    store: 'settings',
    empty: () => ({}),
    merge: mergeZoneTiers,
    label: 'ZoneTierMemory',
    // A pull wrote this character's key under the running page: fold it under what is held
    onPulled: async (rec) => {
        if (!ownerId || ownerId !== dataManager.getCurrentCharacterId?.()) return;
        const token = epoch;
        await rec.load();
        if (token !== epoch) return;
        announce();
    },
});

// Live-safe: the only writer saves the in-memory record folded under what is stored with this same
// fold, and a pull is taken in through `onPulled` above
registerSyncMerge({
    store: 'settings',
    base: ZONE_TIERS_KEY,
    merge: mergeZoneTiers,
    label: 'Zone tiers last run',
    liveSafe: true,
});

/** The character whose record is loaded into memory, or null while none is */
let ownerId = null;
/** Bumped on every character change and stop; an await that finds it moved stands down */
let epoch = 0;
/** What was seen running before the record loaded: `{ ownerId, zoneHrid, tier }` */
let pending = null;
let started = false;

function announce(detail = {}) {
    dataManager.emit?.(ZONE_TIER_MEMORY_EVENT, { characterId: ownerId, ...detail });
}

/** @returns {boolean} Whether the current character's record has been read, so an empty answer means empty */
export function isReady() {
    return Boolean(ownerId) && ownerId === dataManager.getCurrentCharacterId?.();
}

/**
 * The tier the current character last ran a zone at.
 * @param {string} zoneHrid
 * @returns {number|null} Null when none is remembered or the record is not loaded yet (see {@link isReady})
 */
export function rememberedTier(zoneHrid) {
    if (!zoneHrid || !isReady()) return null;
    const entry = record.get()?.[zoneHrid];
    return validEntry(entry) ? entry.tier : null;
}

/**
 * The tier a combat estimate (and Go) should use for a zone, and where it came from.
 *
 * Order: the zone in the character's action queue, then the tier last run there, then T0.
 * @param {string} zoneHrid
 * @param {Array<Object>} [actions] - The action queue; defaults to the data manager's
 * @returns {{tier: number, known: boolean, source: 'queue'|'remembered'|'default', pending: boolean}}
 *   `pending` is true only for the default when the remembered tiers have not loaded yet
 */
export function resolveZoneTier(zoneHrid, actions = dataManager.getCurrentActions?.() || []) {
    const queued = lastUsedTierForZone(actions, zoneHrid);
    if (queued !== null) return { tier: queued, known: true, source: 'queue', pending: false };
    const remembered = rememberedTier(zoneHrid);
    if (remembered !== null) return { tier: remembered, known: true, source: 'remembered', pending: false };
    return { tier: 0, known: false, source: 'default', pending: !isReady() };
}

/**
 * Words for where a tier came from, for the card's tooltip and breakdown.
 * @param {number} tier
 * @param {{known: boolean, source: string, pending?: boolean}} resolved
 * @returns {string} For example "T3 (the tier you last ran here)"
 */
export function describeZoneTier(tier, resolved) {
    if (resolved.source === 'remembered') return `T${tier} (the tier you last ran here)`;
    if (resolved.source === 'queue') return `T${tier}`;
    return `T${tier}, no recorded tier for this zone${resolved.pending ? ' yet' : ''}`;
}

/**
 * Note what the character is running now, and remember its tier if it changed.
 * Reads the server's action data, never the page.
 */
export function observeRunningZone() {
    const who = dataManager.getCurrentCharacterId?.();
    if (!who) return;
    const running = runningCombatAction(dataManager.getCurrentActions?.() || []);
    if (!running?.actionHrid) return;
    // A tier absent from the data is not a tier of 0: the game omits nothing here, but a record that
    // cannot say is better left unwritten than stamped T0
    if (running.difficultyTier === undefined || running.difficultyTier === null) return;
    const tier = Number(running.difficultyTier);
    if (!Number.isInteger(tier) || tier < 0) return;

    if (!isReady() || ownerId !== who) {
        // Not loaded yet: written once the record arrives, for the same character only
        pending = { ownerId: who, zoneHrid: running.actionHrid, tier };
        return;
    }
    applyObservation(running.actionHrid, tier);
}

function applyObservation(zoneHrid, tier) {
    const current = record.get()?.[zoneHrid];
    if (validEntry(current) && current.tier === tier) return;
    const at = Date.now();
    record.set({ ...record.get(), [zoneHrid]: { tier, at } });
    announce({ zoneHrid });
    record
        .save()
        .then((written) => {
            if (!written) {
                console.error(
                    `[ZoneTierMemory] Saving the tier for ${zoneHrid} failed; the stored copy is unchanged ` +
                        'and the new tier is kept for this session only'
                );
            }
        })
        .catch((error) => console.error('[ZoneTierMemory] Saving failed:', error));
}

/** Read the current character's record, then take any observation made while it loaded. */
async function adopt() {
    const who = dataManager.getCurrentCharacterId?.();
    if (!who) return;
    if (isReady() && ownerId === who) {
        observeRunningZone();
        return;
    }
    epoch += 1;
    const token = epoch;
    ownerId = null;
    record.reset();
    const ok = await record.load();
    // A switch or a stop landed during the read: this is not that character's record any more
    if (token !== epoch || dataManager.getCurrentCharacterId?.() !== who) return;
    if (!ok) {
        console.warn('[ZoneTierMemory] The remembered tiers could not be read; estimates fall back to T0');
        return;
    }
    ownerId = who;
    announce();
    // What was seen while the record loaded first, then what is running now (the later one wins)
    if (pending && pending.ownerId === who) applyObservation(pending.zoneHrid, pending.tier);
    pending = null;
    observeRunningZone();
}

function onSwitching() {
    epoch += 1;
    ownerId = null;
    pending = null;
    record.reset();
}

/**
 * Start recording. Safe to call twice.
 */
export function startZoneTierMemory() {
    if (started) return;
    started = true;
    dataManager.on?.('character_switching', onSwitching);
    dataManager.on?.('character_initialized', adopt);
    dataManager.on?.('actions_updated', observeRunningZone);
    // The character may already be in (the feature starts after login)
    if (dataManager.getCurrentCharacterId?.()) adopt();
}

/**
 * Stop recording: removes every listener and forgets the in-memory record. Storage is untouched.
 */
export function stopZoneTierMemory() {
    if (!started) return;
    started = false;
    dataManager.off?.('character_switching', onSwitching);
    dataManager.off?.('character_initialized', adopt);
    dataManager.off?.('actions_updated', observeRunningZone);
    onSwitching();
    announce();
}

/** Test hook: drop all module state. */
export function _resetZoneTierMemoryForTests() {
    started = false;
    ownerId = null;
    pending = null;
    epoch += 1;
    record.reset();
}
