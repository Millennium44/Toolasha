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
 * the gear signature the run was taken under is compared with the gear worn
 * now, and both a run older than {@link STALE_AFTER_MS} and a run in different
 * gear are still offered but say so.
 *
 * Offered rather than withheld, because a week-old combat figure is a far
 * better answer to "how do I make 40M" than pretending combat earns nothing —
 * which is what the planner said before this file existed. Withholding is
 * reserved for the case where there is nothing at all: no snapshot means no
 * combat rate and a note telling you which button produces one.
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

/** Older than this and a snapshot is still used, but flagged */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

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
 * @param {string|null} [options.currentFingerprint=null] - Gear worn now, signed the way a run signs itself
 * @returns {{rates: Array<Object>, best: Object|null, status: Object}} Rates best first, and why
 */
export function combatRatesFromSnapshot(snapshot, { now = Date.now(), currentFingerprint = null } = {}) {
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
            note: NO_SNAPSHOT_NOTE,
        },
    };

    if (!snapshot || !Array.isArray(snapshot.zones) || !snapshot.zones.length) return absent;

    const savedAt = Number.isFinite(snapshot.savedAt) ? snapshot.savedAt : null;
    const ageMs = savedAt === null ? null : Math.max(0, now - savedAt);
    const age = ageMs === null ? 'at an unknown time' : ageLabel(ageMs);
    const stale = ageMs === null || ageMs > STALE_AFTER_MS;
    const gearChanged = Boolean(
        currentFingerprint && snapshot.fingerprint && currentFingerprint !== snapshot.fingerprint
    );

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
        }))
        .sort((a, b) => b.goldPerHour - a.goldPerHour);

    if (!rates.length) {
        return {
            rates: [],
            best: null,
            status: {
                hasSnapshot: true,
                savedAt,
                ageMs,
                ageLabel: age,
                stale,
                gearChanged,
                note: `Your all-zones run from ${age} found no zone that turns a profit, so combat is not ranked.`,
            },
        };
    }

    let note = null;
    if (stale && gearChanged) {
        note =
            `Combat rates are from an all-zones run ${age}, in different gear — still ranked, ` +
            'but re-run the all-zones sim before trusting them.';
    } else if (stale) {
        note = `Combat rates are from an all-zones run ${age} — over a week old, so still ranked but worth re-running.`;
    } else if (gearChanged) {
        note =
            `Combat rates are from an all-zones run ${age}, taken in different gear — ` +
            're-run the all-zones sim to re-rank them against what you wear now.';
    }

    return {
        rates,
        best: rates[0],
        status: { hasSnapshot: true, savedAt, ageMs, ageLabel: age, stale, gearChanged, note },
    };
}

/**
 * The same thing, having gone and read the snapshot.
 *
 * The gear comparison is best-effort: signing the gear worn now needs the
 * simulator's player builder, and a character the builder cannot describe is a
 * reason to skip the comparison, not a reason to withhold the rates.
 *
 * @param {Object} [options] - Options
 * @param {number} [options.now=Date.now()] - The clock
 * @param {boolean} [options.compareGear=true] - Whether to sign the gear worn now
 * @returns {Promise<{rates: Array<Object>, best: Object|null, status: Object}>} As above
 */
export async function loadCombatRates({ now = Date.now(), compareGear = true } = {}) {
    let snapshot = null;
    try {
        snapshot = await combatSimUI.loadAllZonesSnapshot();
    } catch (error) {
        console.error('[GoalPlanner] Reading the all-zones snapshot failed:', error);
    }

    let currentFingerprint = null;
    if (compareGear && snapshot?.fingerprint) {
        try {
            currentFingerprint = await combatSimUI.currentGearFingerprint();
        } catch (error) {
            console.error('[GoalPlanner] Signing the gear worn now failed:', error);
        }
    }

    return combatRatesFromSnapshot(snapshot, { now, currentFingerprint });
}

export default { combatRatesFromSnapshot, loadCombatRates, ageLabel, STALE_AFTER_MS, NO_SNAPSHOT_NOTE };
