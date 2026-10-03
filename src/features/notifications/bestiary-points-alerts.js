/**
 * Bestiary Points Alerts
 *
 * Says so once the character's total Bestiary points reach a chosen target.
 *
 * ## Where the reading comes from
 *
 * The game sends the Bestiary (`monsters_updated`) only when something asks for it: the
 * Achievements tab on open, or the combat sim's own fetch. This module never asks, because a
 * request on a timer is a server call the player did not make. A real reading is the baseline.
 * Between readings the counts are *estimated* from kills the combat stream already shows:
 *
 * - `new_battle` names the wave: `monsters` keyed by slot, each with its `hrid` and
 *   `currentHitpoints`, and `players` (the party size).
 * - `battle_updated` carries `mMap`, a delta of `{cHP}` per slot. A slot whose `cHP` reaches 0
 *   while it was alive is one kill.
 * - A kill credits `creditsPerKill({difficultyTier, partySize})` (tier from the running combat
 *   action, as the sim and the Bestiary planner do), added to that monster's last real count.
 *
 * A real reading replaces the estimate entirely, so drift never outlives one reading. Guild trial
 * monsters (`/monsters/trial_*`) are not tier-weighted at all (see `bestiary.js`), so they are
 * not estimated; neither are fights with no running combat action (labyrinth). Both are simply
 * corrected by the next real reading.
 *
 * With no real reading since the character loaded there is nothing to add kills to, and nothing
 * is guessed. The last real counts are kept per character (`toolasha_local_bestiaryCounts_<id>`,
 * device-local: another device's counts are not this one's kills) so a reload keeps a baseline.
 *
 * ## The target
 *
 * See `utils/bestiary-target.js`. It is re-read on every check, so a target set from the Bestiary
 * planner (which emits `bestiary_target_changed`) takes effect at once.
 *
 * ## Repeats
 *
 * One armed bit and the target it belongs to. A target not seen before (first look after load, or
 * changed by the player) is armed only if the total is below it: reaching a target before anyone
 * was listening is old news, lowering it below the total is not a crossing, raising it above
 * re-arms. The bit disarms only once the notice was delivered. An estimated crossing says "about"
 * and is not repeated when the real reading later confirms it.
 *
 * ## Character switches
 *
 * Reads that await (target, stored baseline) capture the character id first and drop the result if
 * it changed; `disable()` on `character_switching` clears every piece of in-memory state.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import notificationService from './notification-service.js';
import { countsByMonster, totalBestiaryPoints, creditsPerKill } from '../../utils/bestiary.js';
import { runningCombatAction } from '../../utils/combat-actions.js';
import { readScoped, writeScoped } from '../../utils/character-key.js';
import {
    ALERT_SETTING as MASTER_SETTING,
    TARGET_CHANGED_EVENT,
    getBestiaryTarget,
} from '../../utils/bestiary-target.js';
import { formatWithSeparator } from '../../utils/formatters.js';

export { MASTER_SETTING };

/** Prefix for the notification service's event keys */
const EVENT_KEY_PREFIX = 'bestiary-points';

/** Device-local (`toolasha_local_`), per character: the last real counts, so a reload has a baseline */
export const BASELINE_KEY = 'toolasha_local_bestiaryCounts';

/**
 * Device-local, per character: the target value an alert last fired for. An estimated crossing is
 * never stored as a reading, so without this a reload restores the older baseline, re-arms, and the
 * next kill announces the same crossing again.
 */
export const FIRED_KEY = 'toolasha_local_bestiaryFiredTarget';

/** Guild trial monsters are not tier-weighted, so a kill's credit cannot be estimated from tier */
const TRIAL_MONSTER_PREFIX = '/monsters/trial_';

/**
 * A payload's units as `[slot, unit]` pairs, whether it sent an array or a slot-keyed map.
 * @param {Object|Array|undefined} units - `monsters` or `players` of a `new_battle`
 * @returns {Array<[string, Object]>}
 */
function unitEntries(units) {
    if (!units || typeof units !== 'object') return [];
    return Array.isArray(units) ? units.map((u, i) => [String(i), u]) : Object.entries(units);
}

class BestiaryPointsAlerts {
    constructor() {
        this.resetState();
        this.handlers = [];
        this.isInitialized = false;
    }

    /** Forget every reading, estimate and armed bit */
    resetState() {
        /** monsterHrid → count from the last real reading; null until there is one */
        this.real = null;
        /** monsterHrid → credits added by observed kills since that reading */
        this.credits = {};
        /** slot → {hrid, alive} of the wave on screen */
        this.slots = new Map();
        /** Party size and tier of the fight on screen */
        this.partySize = 1;
        this.seenTarget = null;
        this.armed = false;
        /** The target value the alert last fired for (stored, so a reload stays disarmed); null if none */
        this.firedTarget = null;
    }

    /**
     * Start watching. Never sends a request to the game.
     * @returns {Promise<void>}
     */
    async initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting(MASTER_SETTING)) return;
        this.isInitialized = true;

        const onData = (event, handler) => {
            dataManager.on(event, handler);
            this.handlers.push(() => dataManager.off(event, handler));
        };
        const onWire = (event, handler) => {
            // A combat message from a socket that is not the active character's is not this character's kill
            const fromActive = (data, context) => {
                if (dataManager.isFromActiveSocket?.(context) === false) return;
                handler(data);
            };
            webSocketHook.on(event, fromActive);
            this.handlers.push(() => webSocketHook.off(event, fromActive));
        };
        const guard = (name, fn) => (data) => {
            try {
                const result = fn(data);
                if (result?.catch)
                    result.catch((error) => console.error(`[BestiaryPointsAlerts] ${name} failed:`, error));
            } catch (error) {
                console.error(`[BestiaryPointsAlerts] ${name} failed:`, error);
            }
        };

        onData(
            'monsters_updated',
            guard('Reading the Bestiary', (data) => this.onReading(data?.monsters))
        );
        onData(
            TARGET_CHANGED_EVENT,
            guard('Re-reading the target', () => this.check(true))
        );
        onData('character_switching', () => this.disable());
        onWire(
            'new_battle',
            guard('Reading a battle', (data) => this.onNewBattle(data))
        );
        onWire(
            'battle_updated',
            guard('Reading a battle tick', (data) => this.onBattleUpdated(data))
        );

        // The target already announced, so an estimated crossing is not announced again after a reload
        const firedWho = dataManager.getCurrentCharacterId?.();
        const fired = await readScoped(FIRED_KEY, 'settings', null);
        if (!this.isInitialized || dataManager.getCurrentCharacterId?.() !== firedWho) return;
        if (typeof fired === 'number' && Number.isFinite(fired)) this.firedTarget = fired;

        // A reading already held this session, else the one kept from the last page load
        const held = dataManager.getCharacterMonsters?.();
        if (Array.isArray(held)) {
            this.real = countsByMonster(held);
            // Kept too: the alert may start after the reading it is built on (the planner's fetch)
            writeScoped(BASELINE_KEY, this.real, 'settings').catch(() => {});
        } else {
            const who = dataManager.getCurrentCharacterId?.();
            const stored = await readScoped(BASELINE_KEY, 'settings', null);
            if (!this.isInitialized || dataManager.getCurrentCharacterId?.() !== who) return;
            // A real reading that landed while the read was pending wins
            if (this.real === null && stored && typeof stored === 'object') this.real = { ...stored };
        }
        await this.check(true);
    }

    /**
     * A real reading: replaces the estimate entirely.
     * @param {Array} monsters - `monsters_updated.monsters`
     * @returns {Promise<void>}
     */
    async onReading(monsters) {
        if (!Array.isArray(monsters)) return;
        this.real = countsByMonster(monsters);
        this.credits = {};
        const who = dataManager.getCurrentCharacterId?.();
        if (who) writeScoped(BASELINE_KEY, this.real, 'settings').catch(() => {});
        await this.check(true);
    }

    /**
     * Remember the wave: which monster sits in which slot, and how many players share the kills.
     * @param {Object} data - `new_battle`
     */
    onNewBattle(data) {
        this.slots = new Map();
        for (const [slot, unit] of unitEntries(data?.monsters)) {
            const hrid = unit?.hrid ?? unit?.combatMonsterHrid;
            if (typeof hrid !== 'string') continue;
            const hp = Number(unit?.currentHitpoints ?? unit?.combatDetails?.currentHitpoints);
            this.slots.set(slot, { hrid, alive: !(Number.isFinite(hp) && hp <= 0) });
        }
        this.partySize = Math.max(1, unitEntries(data?.players).length);
    }

    /**
     * Credit the kills a tick shows: a slot that was alive and now has no hitpoints.
     * @param {Object} data - `battle_updated`
     * @returns {Promise<void>|undefined}
     */
    onBattleUpdated(data) {
        if (this.real === null || !data?.mMap) return;
        const action = runningCombatAction(dataManager.getCurrentActions?.());
        let killed = false;
        for (const [slot, unit] of unitEntries(data.mMap)) {
            const known = this.slots.get(slot);
            if (!known || !known.alive) continue;
            const hp = Number(unit?.cHP ?? unit?.currentHitpoints);
            if (!Number.isFinite(hp) || hp > 0) continue;
            known.alive = false;
            if (!action || known.hrid.startsWith(TRIAL_MONSTER_PREFIX)) continue;
            const credit = creditsPerKill({ difficultyTier: action.difficultyTier || 0, partySize: this.partySize });
            this.credits[known.hrid] = (this.credits[known.hrid] || 0) + credit;
            killed = true;
        }
        if (killed) return this.check(false);
    }

    /**
     * The counts as best known: the last real reading plus the credits since.
     * @returns {Object|null} monsterHrid → count, or null with no baseline
     */
    estimatedCounts() {
        if (this.real === null) return null;
        const counts = { ...this.real };
        for (const [hrid, credit] of Object.entries(this.credits)) counts[hrid] = (counts[hrid] || 0) + credit;
        return counts;
    }

    /**
     * Compare the total with the target and announce a crossing.
     * @param {boolean} real - True when this follows a real reading (or a load), false on an estimate
     * @returns {Promise<void>}
     */
    async check(real) {
        if (!this.isInitialized || !config.getSetting(MASTER_SETTING)) return;

        const who = dataManager.getCurrentCharacterId?.();
        const target = await getBestiaryTarget();
        // Dropped, not retried: the next reading for the new character checks again
        if (!this.isInitialized || dataManager.getCurrentCharacterId?.() !== who) return;
        if (target === null) {
            this.seenTarget = null;
            return;
        }

        // No baseline: nothing to add kills to, and nothing is guessed
        const counts = this.estimatedCounts();
        if (!counts) return;
        const total = totalBestiaryPoints(counts);

        if (this.seenTarget !== target) {
            this.seenTarget = target;
            this.armed = total < target && this.firedTarget !== target;
        }
        if (!this.armed || total < target) return;

        const shown = real ? formatWithSeparator(total) : `about ${formatWithSeparator(total)}`;
        const result = notificationService.notify(
            `${EVENT_KEY_PREFIX}:${target}`,
            `Bestiary: ${shown} points — target ${formatWithSeparator(target)} reached${real ? '' : ' (estimated from kills)'}.`,
            { title: 'Bestiary target reached', subject: `${formatWithSeparator(target)} points` }
        );
        if (result?.fired) {
            this.armed = false;
            this.firedTarget = target;
            writeScoped(FIRED_KEY, target, 'settings').catch(() => {});
        }
    }

    /**
     * Cleanup
     */
    disable() {
        this.handlers.forEach((off) => off());
        this.handlers = [];
        this.resetState();
        this.isInitialized = false;
    }
}

const bestiaryPointsAlerts = new BestiaryPointsAlerts();

export default bestiaryPointsAlerts;
