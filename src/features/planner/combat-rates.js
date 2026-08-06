/**
 * Combat income for the planner, out of the last all-zones simulation.
 *
 * ## Why a saved run and not a fresh one
 *
 * Combat income is not an action rate. It is a drop table against a kill rate
 * against a death rate, and the only thing in the script that can work it out
 * is the simulator — which runs every zone at every tier in a worker and takes
 * minutes. A planner refresh cannot start that, so it reads what the last run
 * left behind: `combat-sim-ui.js` reduces a finished all-zones run to profit and
 * experience per hour per zone and stores it per character.
 *
 * ## What that means for honesty
 *
 * Every other rate the planner quotes is computed against the market as it
 * stands this second. A combat rate is not: it is a measurement taken at some
 * point in the past, in whatever gear was worn then, against whatever the drops
 * were worth then. So it is never quoted bare — the age is part of the label,
 * the gear is checked, and both a run older than {@link STALE_AFTER_MS} and a
 * run in different gear are still offered but say so.
 *
 * Offered rather than withheld, because a week-old combat figure is a far
 * better answer to "how do I make 40M" than pretending combat earns nothing —
 * which is what the planner said before this file existed. Withholding is
 * reserved for the case where there is nothing at all: no snapshot means no
 * combat rate and a note telling you which button produces one.
 *
 * ## "Different gear" means the combat loadout, not what you have on
 *
 * This used to compare the run's gear signature against the gear worn *right
 * now*, which is the wrong question for anyone who skills. Half the day you are
 * in a chef's hat, and a chef's hat is not evidence that your combat numbers
 * have moved — it is evidence that you are cooking. Every refresh in skilling
 * gear said "taken in different gear, re-run the sim", which is a warning that
 * fires on the wrong thing and is therefore a warning nobody reads.
 *
 * What matters is the loadout you *fight* in: the default loadout for
 * `/action_types/combat`, or whichever one you picked when several are combat
 * loadouts and none is the default. {@link combatLoadoutSignature} signs that,
 * and the flag means what it says — your combat loadout no longer matches the
 * one the run was measured under.
 *
 * ### Measured against a baseline, because the run does not keep its gear
 *
 * The all-zones snapshot stores an opaque digest of the party's equipment, and
 * the function that produces it lives in the simulator bundle and is not
 * reachable from here. So the comparison is not "sign the loadout and compare
 * digests" — it is "the loadout now, against the loadout when this run was
 * first seen", which the planner records itself the first time it meets a run.
 * That is a weaker claim and an honest one: a loadout edited between the run
 * finishing and the planner's next refresh is missed, and everything after that
 * is caught.
 *
 * ## Experience is carried but not offered
 *
 * The snapshot's `xpPerHour` is the *total* across every combat skill —
 * `buildAllZonesSnapshot` sums `experienceGained` over the skills before it
 * stores it. There is no way back from that to "attack experience per hour", so
 * these rates are not wired into the planner's per-skill experience lookup;
 * quoting a total against a single skill's goal would overstate it several
 * times over. The figure rides on each rate for anything that wants to show it.
 */

// The default export, not the named ones. The planner is in the actions bundle
// and the simulator is its own, so rollup turns an import of this module into a
// property read off `Toolasha.Sim.combatSimUI` — which is the panel instance,
// with these two functions hung off it for exactly this reason. A named import
// would work in the dev standalone and read `undefined` in production.
import combatSimUI from '../combat-sim/combat-sim-ui.js';
import dataManager from '../../core/data-manager.js';
import bundledLoadoutSnapshot from '../combat/loadout-snapshot.js';
import { loadCombatGear, saveCombatGear } from './goal-planner-store.js';
import { loadoutSnapshot } from '../../utils/bundle-bridge.js';

/** Older than this and a snapshot is still used, but flagged */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** The action type a combat loadout is filed under */
export const COMBAT_ACTION_TYPE = '/action_types/combat';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** What the planner shows when there is nothing to read */
export const NO_SNAPSHOT_NOTE =
    'Combat is not ranked — run an all-zones sim in the Combat Simulator to add combat rates.';

/**
 * How long ago, said the way a sentence says it.
 * @param {number} ageMs - Milliseconds since the run
 * @returns {string} e.g. "3d ago"
 */
export function ageLabel(ageMs) {
    if (!Number.isFinite(ageMs) || ageMs < 0) return 'at an unknown time';
    if (ageMs < 60_000) return 'just now';
    if (ageMs < HOUR_MS) return `${Math.floor(ageMs / 60_000)}m ago`;
    if (ageMs < DAY_MS) return `${Math.floor(ageMs / HOUR_MS)}h ago`;
    return `${Math.floor(ageMs / DAY_MS)}d ago`;
}

/**
 * The loadout store that actually has the loadouts in it.
 *
 * In the multi-bundle build every bundle that imports the module gets its own
 * copy of the singleton and only the Combat one is ever initialised, so the
 * others answer "no loadout" to everything. The global is the initialised one;
 * the bundled copy is the dev build, where there is only one. The same idiom
 * `utils/action-context.js` uses, for the same reason.
 *
 * @returns {Object} The snapshot store
 */
function loadouts() {
    return loadoutSnapshot() || bundledLoadoutSnapshot;
}

/**
 * Every loadout the character keeps for fighting.
 *
 * An "All Skills" loadout counts, because a character with one loadout for
 * everything fights in it — but it sorts below a loadout filed under combat,
 * which is a deliberate statement about fighting and a general one is not.
 *
 * @returns {Array<Object>} Combat-applicable loadouts, most specific first
 */
export function combatLoadouts() {
    let all = [];
    try {
        all = loadouts().getAllSnapshots() || [];
    } catch (error) {
        console.error('[GoalPlanner] Reading loadouts failed:', error);
        return [];
    }

    return all
        .filter((snapshot) => snapshot?.actionTypeHrid === COMBAT_ACTION_TYPE || snapshot?.actionTypeHrid === '')
        .sort((a, b) => {
            const specific = (snapshot) => (snapshot.actionTypeHrid === COMBAT_ACTION_TYPE ? 0 : 1);
            if (specific(a) !== specific(b)) return specific(a) - specific(b);
            if (Boolean(b.isDefault) !== Boolean(a.isDefault)) return b.isDefault ? 1 : -1;
            return (a.ordinal || 0) - (b.ordinal || 0);
        });
}

/**
 * Which loadout the combat rates are judged against.
 *
 * The player's own pick wins when they have made one, because the resolution
 * order below is a guess and a choice is not. Otherwise: a loadout filed under
 * combat and marked default, then any combat loadout, then the all-skills one —
 * the same priority `loadout-snapshot.js` uses everywhere else, so the planner
 * and the profit calculators are looking at the same gear.
 *
 * @param {string|null} [preferred] - A loadout name the player chose
 * @returns {Object|null} The loadout, or null when the character keeps none
 */
export function chooseCombatLoadout(preferred = null) {
    const candidates = combatLoadouts();
    if (!candidates.length) return null;
    if (preferred) {
        const picked = candidates.find((snapshot) => snapshot.name === preferred);
        if (picked) return picked;
    }
    return candidates[0];
}

/**
 * A loadout's equipment, written down the same way every time.
 *
 * Sorted, so slot order cannot make an unchanged loadout look changed, and read
 * through `resolveEquipment` so that a loadout which wears "the best copy you
 * own" is signed at the level it would actually wear rather than at whatever
 * level was stored the last time the loadouts tab was open.
 *
 * @param {Object|null} loadout - From {@link chooseCombatLoadout}
 * @returns {string|null} A signature, or null when there is nothing to sign
 */
export function combatLoadoutSignature(loadout) {
    if (!loadout) return null;
    let equipment = [];
    try {
        equipment = loadouts().resolveEquipment(loadout) || [];
    } catch (error) {
        console.error('[GoalPlanner] Resolving a loadout failed:', error);
        equipment = loadout.equipment || [];
    }

    const parts = equipment
        .filter((slot) => slot?.itemHrid)
        .map((slot) => `${slot.itemLocationHrid}=${slot.itemHrid}+${slot.enhancementLevel || 0}`)
        .sort();
    return parts.length ? parts.join(',') : null;
}

/**
 * The gear worn this second, signed the same way a loadout is.
 *
 * The fallback for a character who keeps no loadouts at all: without one there
 * is no "combat loadout" to compare, and comparing what is worn is the only
 * signal left. It is the old, wrong-for-skillers test, so it is used only when
 * the right one is unavailable and the note says which was used.
 *
 * @returns {string|null} A signature, or null when equipment is unavailable
 */
export function wornSignature() {
    const equipment = dataManager.getEquipment?.();
    if (!equipment) return null;
    const parts = [];
    for (const [location, item] of equipment) {
        if (!item?.itemHrid) continue;
        parts.push(`${item.itemLocationHrid || location}=${item.itemHrid}+${item.enhancementLevel || 0}`);
    }
    return parts.length ? parts.sort().join(',') : null;
}

/**
 * What the gear check has to work with, resolved once.
 * @param {string|null} [preferred] - A loadout name the player chose
 * @returns {{name: string|null, signature: string|null, source: string, choices: Array<string>}}
 *   The loadout used, its signature, whether it came from a loadout or from
 *   what is worn, and the names a picker could offer
 */
export function readCombatLoadout(preferred = null) {
    const choices = combatLoadouts()
        .map((snapshot) => snapshot.name)
        .filter(Boolean);
    const loadout = chooseCombatLoadout(preferred);
    if (loadout) {
        return {
            name: loadout.name || 'your combat loadout',
            signature: combatLoadoutSignature(loadout),
            source: 'loadout',
            choices,
        };
    }
    return { name: null, signature: wornSignature(), source: 'worn', choices };
}

/**
 * A zone's name, with its tier when it has one.
 * @param {Object} zone - A zone row from the snapshot
 * @returns {string} e.g. "Aqua Planet T2"
 */
function zoneLabel(zone) {
    const name = zone.zoneName || zone.zoneHrid.split('/').pop().replace(/_/g, ' ');
    return zone.difficultyTier > 0 ? `${name} T${zone.difficultyTier}` : name;
}

/**
 * Turn a stored all-zones run into gold rates the planner can rank.
 *
 * Pure on purpose: everything that decides whether a rate is offered, what it
 * is called and how old it is claiming to be is arithmetic over a plain object,
 * so a test can set the clock and the gear and read the sentence back.
 *
 * @param {Object|null} snapshot - From `loadAllZonesSnapshot`
 * @param {Object} [options] - Options
 * @param {number} [options.now=Date.now()] - The clock
 * @param {Object|null} [options.loadout=null] - From {@link readCombatLoadout}
 * @param {Object|null} [options.baseline=null] - `{savedAt, signature}` recorded when this run was first seen
 * @returns {{rates: Array<Object>, best: Object|null, status: Object}} Rates best first, and why
 */
export function combatRatesFromSnapshot(snapshot, { now = Date.now(), loadout = null, baseline = null } = {}) {
    const absent = {
        rates: [],
        best: null,
        status: {
            hasSnapshot: false,
            savedAt: null,
            ageMs: null,
            ageLabel: null,
            stale: false,
            gearChanged: false,
            loadoutName: loadout?.name || null,
            loadoutSource: loadout?.source || null,
            note: NO_SNAPSHOT_NOTE,
        },
    };

    if (!snapshot || !Array.isArray(snapshot.zones) || !snapshot.zones.length) return absent;

    const savedAt = Number.isFinite(snapshot.savedAt) ? snapshot.savedAt : null;
    const ageMs = savedAt === null ? null : Math.max(0, now - savedAt);
    const age = ageMs === null ? 'at an unknown time' : ageLabel(ageMs);
    const stale = ageMs === null || ageMs > STALE_AFTER_MS;

    // Only a baseline taken against *this* run says anything. One recorded
    // against an older run is a fact about that run, and reading it here would
    // report a change the current snapshot already contains.
    const comparable = Boolean(baseline && savedAt !== null && baseline.savedAt === savedAt && baseline.signature);
    const gearChanged = Boolean(comparable && loadout?.signature && baseline.signature !== loadout.signature);
    const gearLabel = loadout?.source === 'loadout' ? `your ${loadout.name} loadout` : 'the gear you wear';

    const flags = [];
    if (stale) flags.push('stale');
    if (gearChanged) flags.push('gear changed');
    const suffix = flags.length ? ` (${flags.join(', ')})` : '';

    const rates = snapshot.zones
        .filter((zone) => zone?.zoneHrid && Number.isFinite(zone.profitPerHour) && zone.profitPerHour > 0)
        .map((zone) => ({
            actionHrid: zone.zoneHrid,
            label: `${zoneLabel(zone)} — from your all-zones run ${age}${suffix}`,
            goldPerHour: zone.profitPerHour,
            kind: 'combat',
            zoneHrid: zone.zoneHrid,
            zoneName: zone.zoneName || '',
            difficultyTier: zone.difficultyTier ?? 0,
            // Total combat experience across every skill — see the module doc
            // for why this is not offered as a per-skill rate
            xpPerHour: Number.isFinite(zone.xpPerHour) ? zone.xpPerHour : 0,
            source: 'all-zones-sim',
            savedAt,
            ageMs,
            ageLabel: age,
            stale,
            gearChanged,
            // Combat consumes nothing you own that the profit figure has not
            // already paid for, so there is no ceiling on how long it can be run
            sustainable: { unbounded: true },
        }))
        .sort((a, b) => b.goldPerHour - a.goldPerHour);

    const status = {
        hasSnapshot: true,
        savedAt,
        ageMs,
        ageLabel: age,
        stale,
        gearChanged,
        gearComparable: comparable,
        loadoutName: loadout?.name || null,
        loadoutSource: loadout?.source || null,
        loadoutChoices: loadout?.choices || [],
    };

    if (!rates.length) {
        return {
            rates: [],
            best: null,
            status: {
                ...status,
                note: `Your all-zones run from ${age} found no zone that turns a profit, so combat is not ranked.`,
            },
        };
    }

    let note = null;
    if (stale && gearChanged) {
        note =
            `Combat rates are from an all-zones run ${age}, and ${gearLabel} has changed since — still ranked, ` +
            'but re-run the all-zones sim before trusting them.';
    } else if (stale) {
        note = `Combat rates are from an all-zones run ${age} — over a week old, so still ranked but worth re-running.`;
    } else if (gearChanged) {
        note =
            `Combat rates are from an all-zones run ${age}, and ${gearLabel} has changed since — ` +
            're-run the all-zones sim to re-rank them against it.';
    }

    return { rates, best: rates[0], status: { ...status, note } };
}

/**
 * The same thing, having gone and read the snapshot and the loadout.
 *
 * Recording the baseline is the side effect that makes the gear check possible
 * at all, and it is deliberately one-way: a baseline is written for a run the
 * planner has not seen before, and never rewritten for a run it has. Rewriting
 * would quietly erase the very change the flag exists to report.
 *
 * @param {Object} [options] - Options
 * @param {number} [options.now=Date.now()] - The clock
 * @param {boolean} [options.compareGear=true] - Whether to check the combat loadout at all
 * @returns {Promise<{rates: Array<Object>, best: Object|null, status: Object}>} As above
 */
export async function loadCombatRates({ now = Date.now(), compareGear = true } = {}) {
    let snapshot = null;
    try {
        snapshot = await combatSimUI.loadAllZonesSnapshot();
    } catch (error) {
        console.error('[GoalPlanner] Reading the all-zones snapshot failed:', error);
    }

    if (!compareGear) return combatRatesFromSnapshot(snapshot, { now });

    let stored = { preferred: null, baseline: null };
    try {
        stored = await loadCombatGear();
    } catch (error) {
        console.error('[GoalPlanner] Reading the combat gear record failed:', error);
    }

    const loadout = readCombatLoadout(stored.preferred);
    const result = combatRatesFromSnapshot(snapshot, { now, loadout, baseline: stored.baseline });

    const savedAt = result.status.savedAt;
    const unseen = savedAt !== null && stored.baseline?.savedAt !== savedAt;
    if (unseen && loadout.signature) {
        await saveCombatGear({ baseline: { savedAt, signature: loadout.signature, name: loadout.name } });
    }

    return result;
}

export default {
    combatRatesFromSnapshot,
    loadCombatRates,
    combatLoadouts,
    chooseCombatLoadout,
    combatLoadoutSignature,
    readCombatLoadout,
    ageLabel,
    COMBAT_ACTION_TYPE,
    STALE_AFTER_MS,
    NO_SNAPSHOT_NOTE,
};
