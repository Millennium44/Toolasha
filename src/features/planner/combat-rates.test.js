/**
 * Combat income out of a saved all-zones run.
 *
 * The interesting behaviour is entirely about *trust*: a rate that was measured
 * some time ago, possibly in other gear, is still worth having as long as it
 * says so. So the tests move the clock and the gear and read the label and the
 * note back, rather than checking arithmetic — the only arithmetic here is
 * picking the largest number in a list.
 *
 * The gear half is now the interesting half. "Different gear" has to mean *your
 * combat loadout has changed*, not *you are dressed for cooking*, and the tests
 * below are mostly about that distinction: a character who puts on a chef's hat
 * must not be told to re-run a four-hour simulation.
 *
 * `combat-sim-ui.js` is mocked whole. It is a six-thousand-line panel that
 * builds workers and floating windows; what this module wants from it is one
 * stored object.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const sim = vi.hoisted(() => ({
    snapshot: null,
    loadThrows: false,
}));

const game = vi.hoisted(() => ({
    /** Loadouts as `loadout-snapshot.js` keeps them */
    loadouts: [],
    /** Equipment worn this second */
    equipment: new Map(),
    /** The planner's own record of the loadout each run was first seen under */
    gear: { preferred: null, baseline: null },
    resolveThrows: false,
}));

// The default export, because that is what the module reads — see the note on
// its import for why a named import would only work in the dev build.
vi.mock('../combat-sim/combat-sim-ui.js', () => ({
    default: {
        loadAllZonesSnapshot: async () => {
            if (sim.loadThrows) throw new Error('storage is unhappy');
            return sim.snapshot;
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getEquipment: () => game.equipment },
}));
vi.mock('../combat/loadout-snapshot.js', () => ({
    default: {
        getAllSnapshots: () => game.loadouts,
        resolveEquipment: (snapshot) => {
            if (game.resolveThrows) throw new Error('no inventory');
            return snapshot.equipment;
        },
    },
}));
vi.mock('./goal-planner-store.js', () => ({
    loadCombatGear: async () => game.gear,
    saveCombatGear: async (patch) => {
        game.gear = { ...game.gear, ...patch };
        return game.gear;
    },
}));

const {
    combatRatesFromSnapshot,
    loadCombatRates,
    combatLoadouts,
    chooseCombatLoadout,
    combatLoadoutSignature,
    readCombatLoadout,
    ageLabel,
    STALE_AFTER_MS,
    NO_SNAPSHOT_NOTE,
} = await import('./combat-rates.js');

/**
 * A loadout as the snapshot store keeps them.
 * @param {string} name - Its name
 * @param {Object} [fields] - `actionTypeHrid`, `isDefault`, `ordinal`, `equipment`
 * @returns {Object} A loadout
 */
function loadout(name, fields = {}) {
    return {
        name,
        actionTypeHrid: '/action_types/combat',
        isDefault: false,
        ordinal: 0,
        equipment: [{ itemLocationHrid: '/item_locations/main_hand', itemHrid: '/items/sword', enhancementLevel: 5 }],
        ...fields,
    };
}

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * A saved run with two zones, the second one richer.
 * @param {Object} [overrides] - Snapshot fields to replace
 * @returns {Object} A snapshot
 */
function snapshot(overrides = {}) {
    return {
        version: 1,
        savedAt: NOW - 3 * DAY,
        hours: 24,
        fingerprint: 'gear-a',
        zones: [
            {
                zoneHrid: '/actions/combat/bee',
                zoneName: 'Bee Hive',
                difficultyTier: 0,
                profitPerHour: 900_000,
                xpPerHour: 120_000,
            },
            {
                zoneHrid: '/actions/combat/fly',
                zoneName: 'Fly Zone',
                difficultyTier: 2,
                profitPerHour: 2_100_000,
                xpPerHour: 300_000,
            },
        ],
        ...overrides,
    };
}

/** The signature `readCombatLoadout` produces for the fixture loadout above */
const SWORD_5 = '/item_locations/main_hand=/items/sword+5';

beforeEach(() => {
    sim.snapshot = null;
    sim.loadThrows = false;
    game.loadouts = [loadout('Fighting', { isDefault: true })];
    game.equipment = new Map();
    game.gear = { preferred: null, baseline: null };
    game.resolveThrows = false;
});

describe('ageLabel', () => {
    test('says how long ago in the largest unit that is not a fraction', () => {
        expect(ageLabel(30_000)).toBe('just now');
        expect(ageLabel(20 * 60_000)).toBe('20m ago');
        expect(ageLabel(5 * HOUR)).toBe('5h ago');
        expect(ageLabel(3 * DAY)).toBe('3d ago');
        expect(ageLabel(45 * DAY)).toBe('45d ago');
    });

    test('does not invent an age it does not have', () => {
        expect(ageLabel(NaN)).toBe('at an unknown time');
        expect(ageLabel(-1)).toBe('at an unknown time');
    });
});

describe('combatRatesFromSnapshot — a run that exists', () => {
    test('offers every profitable zone, best first, and names the winner', () => {
        const { rates, best } = combatRatesFromSnapshot(snapshot(), { now: NOW });

        expect(rates.map((rate) => rate.zoneName)).toEqual(['Fly Zone', 'Bee Hive']);
        expect(best.goldPerHour).toBe(2_100_000);
        expect(best.kind).toBe('combat');
        expect(best.actionHrid).toBe('/actions/combat/fly');
    });

    test('the label says where the number came from and how old it is', () => {
        const { best } = combatRatesFromSnapshot(snapshot(), { now: NOW });
        expect(best.label).toBe('Fly Zone T2 — from your all-zones run 3d ago');
        expect(best.ageLabel).toBe('3d ago');
        expect(best.source).toBe('all-zones-sim');
    });

    test('a fresh run in the same loadout has nothing to warn about', () => {
        const { status } = combatRatesFromSnapshot(snapshot(), {
            now: NOW,
            loadout: { name: 'Fighting', signature: SWORD_5, source: 'loadout' },
            baseline: { savedAt: NOW - 3 * DAY, signature: SWORD_5 },
        });
        expect(status).toMatchObject({ hasSnapshot: true, stale: false, gearChanged: false, note: null });
    });

    test('combat is unbounded — nothing it consumes runs out', () => {
        const { best } = combatRatesFromSnapshot(snapshot(), { now: NOW });
        expect(best.sustainable).toEqual({ unbounded: true });
    });

    test('carries the run’s experience, which is every combat skill at once', () => {
        const { best } = combatRatesFromSnapshot(snapshot(), { now: NOW });
        expect(best.xpPerHour).toBe(300_000);
    });

    test('a zone that loses money is not an earning rate', () => {
        const losing = snapshot({
            zones: [
                {
                    zoneHrid: '/actions/combat/bee',
                    zoneName: 'Bee Hive',
                    difficultyTier: 0,
                    profitPerHour: -50,
                    xpPerHour: 10,
                },
                {
                    zoneHrid: '/actions/combat/fly',
                    zoneName: 'Fly Zone',
                    difficultyTier: 0,
                    profitPerHour: 5,
                    xpPerHour: 10,
                },
            ],
        });
        const { rates } = combatRatesFromSnapshot(losing, { now: NOW });
        expect(rates.map((rate) => rate.zoneName)).toEqual(['Fly Zone']);
    });

    test('a zone whose profit was never measured is skipped, not treated as zero', () => {
        const partial = snapshot({
            zones: [{ zoneHrid: '/actions/combat/bee', zoneName: 'Bee Hive', profitPerHour: null, xpPerHour: 10 }],
        });
        const { rates, status } = combatRatesFromSnapshot(partial, { now: NOW });
        expect(rates).toEqual([]);
        expect(status.hasSnapshot).toBe(true);
        expect(status.note).toContain('no zone that turns a profit');
    });
});

describe('combatRatesFromSnapshot — a run that is old', () => {
    test('older than a week is still offered, and says so in the label and the note', () => {
        const old = snapshot({ savedAt: NOW - 9 * DAY });
        const { best, status } = combatRatesFromSnapshot(old, { now: NOW });

        expect(best.goldPerHour).toBe(2_100_000);
        expect(best.stale).toBe(true);
        expect(best.label).toBe('Fly Zone T2 — from your all-zones run 9d ago (stale)');
        expect(status.stale).toBe(true);
        expect(status.note).toContain('over a week old');
    });

    test('the line between fresh and stale is a week, not a guess', () => {
        const justInside = snapshot({ savedAt: NOW - STALE_AFTER_MS + 1000 });
        const justOutside = snapshot({ savedAt: NOW - STALE_AFTER_MS - 1000 });
        expect(combatRatesFromSnapshot(justInside, { now: NOW }).status.stale).toBe(false);
        expect(combatRatesFromSnapshot(justOutside, { now: NOW }).status.stale).toBe(true);
    });

    test('a run with no timestamp is treated as stale rather than as new', () => {
        const undated = snapshot({ savedAt: undefined });
        const { status, best } = combatRatesFromSnapshot(undated, { now: NOW });
        expect(status.stale).toBe(true);
        expect(best.label).toContain('at an unknown time');
    });
});

describe('combatRatesFromSnapshot — a loadout that has moved on', () => {
    const fighting = (signature) => ({ name: 'Fighting', signature, source: 'loadout' });

    test('a changed combat loadout is flagged without withholding the rate', () => {
        const { best, status } = combatRatesFromSnapshot(snapshot(), {
            now: NOW,
            loadout: fighting('/item_locations/main_hand=/items/sword+10'),
            baseline: { savedAt: NOW - 3 * DAY, signature: SWORD_5 },
        });

        expect(best.goldPerHour).toBe(2_100_000);
        expect(best.gearChanged).toBe(true);
        expect(best.label).toBe('Fly Zone T2 — from your all-zones run 3d ago (gear changed)');
        // Named, so the warning is about a thing the player can go and look at
        expect(status.note).toContain('your Fighting loadout has changed');
    });

    test('old and re-geared says both, once', () => {
        const old = snapshot({ savedAt: NOW - 30 * DAY });
        const { best, status } = combatRatesFromSnapshot(old, {
            now: NOW,
            loadout: fighting('/item_locations/main_hand=/items/sword+10'),
            baseline: { savedAt: NOW - 30 * DAY, signature: SWORD_5 },
        });
        expect(best.label).toBe('Fly Zone T2 — from your all-zones run 30d ago (stale, gear changed)');
        expect(status.note).toContain('your Fighting loadout has changed');
        expect(status.note).toContain('30d ago');
    });

    test('a baseline taken against a different run says nothing about this one', () => {
        const { status } = combatRatesFromSnapshot(snapshot(), {
            now: NOW,
            loadout: fighting('/item_locations/main_hand=/items/sword+10'),
            baseline: { savedAt: NOW - 20 * DAY, signature: SWORD_5 },
        });
        expect(status.gearChanged).toBe(false);
        expect(status.gearComparable).toBe(false);
    });

    test('with no baseline there is nothing to compare, and no warning is invented', () => {
        const { status } = combatRatesFromSnapshot(snapshot(), { now: NOW, loadout: fighting(SWORD_5) });
        expect(status.gearChanged).toBe(false);
        expect(status.note).toBeNull();
    });

    test('the note says so when the check fell back to what is worn', () => {
        const { status } = combatRatesFromSnapshot(snapshot(), {
            now: NOW,
            loadout: { name: null, signature: 'worn-b', source: 'worn' },
            baseline: { savedAt: NOW - 3 * DAY, signature: 'worn-a' },
        });
        expect(status.note).toContain('the gear you wear has changed');
        expect(status.loadoutSource).toBe('worn');
    });
});

describe('which loadout the rates are judged against', () => {
    test('a combat loadout beats an all-skills one, and a default beats the rest', () => {
        game.loadouts = [
            loadout('Everything', { actionTypeHrid: '', isDefault: true, ordinal: 0 }),
            loadout('Spare', { ordinal: 2 }),
            loadout('Fighting', { isDefault: true, ordinal: 1 }),
        ];
        expect(combatLoadouts().map((entry) => entry.name)).toEqual(['Fighting', 'Spare', 'Everything']);
        expect(chooseCombatLoadout().name).toBe('Fighting');
    });

    test('a loadout for a skill is not a combat loadout, however default it is', () => {
        game.loadouts = [loadout('Cooking', { actionTypeHrid: '/action_types/cooking', isDefault: true })];
        expect(combatLoadouts()).toEqual([]);
        expect(chooseCombatLoadout()).toBeNull();
    });

    test('the player’s own pick wins over the resolution order', () => {
        game.loadouts = [loadout('Fighting', { isDefault: true }), loadout('Ranged')];
        expect(chooseCombatLoadout('Ranged').name).toBe('Ranged');
        // A pick naming a loadout that no longer exists falls back rather than
        // leaving the rates unjudged
        expect(chooseCombatLoadout('Deleted').name).toBe('Fighting');
    });

    test('the signature is the loadout’s resolved equipment, order-independent', () => {
        const two = loadout('Fighting', {
            equipment: [
                { itemLocationHrid: '/item_locations/head', itemHrid: '/items/hat', enhancementLevel: 0 },
                { itemLocationHrid: '/item_locations/main_hand', itemHrid: '/items/sword', enhancementLevel: 5 },
            ],
        });
        const reversed = { ...two, equipment: [...two.equipment].reverse() };
        expect(combatLoadoutSignature(two)).toBe(combatLoadoutSignature(reversed));
        expect(combatLoadoutSignature(two)).toContain('/items/sword+5');
    });

    test('with no loadouts at all it falls back to what is worn, and says which', () => {
        game.loadouts = [];
        game.equipment = new Map([['/item_locations/main_hand', { itemHrid: '/items/spear', enhancementLevel: 2 }]]);
        const read = readCombatLoadout();
        expect(read.source).toBe('worn');
        expect(read.signature).toBe('/item_locations/main_hand=/items/spear+2');
    });

    test('a loadout store that throws costs the signature, not the rates', () => {
        game.resolveThrows = true;
        vi.spyOn(console, 'error').mockImplementation(() => {});
        // Falls back to the stored equipment rather than giving up on the check
        expect(combatLoadoutSignature(loadout('Fighting'))).toBe(SWORD_5);
        vi.restoreAllMocks();
    });
});

describe('combatRatesFromSnapshot — no run at all', () => {
    test('offers nothing, and says which button produces some', () => {
        const { rates, best, status } = combatRatesFromSnapshot(null, { now: NOW });
        expect(rates).toEqual([]);
        expect(best).toBeNull();
        expect(status.hasSnapshot).toBe(false);
        expect(status.note).toBe(NO_SNAPSHOT_NOTE);
        expect(status.note).toContain('all-zones');
    });

    test('an empty run is the same as no run', () => {
        expect(combatRatesFromSnapshot({ zones: [] }, { now: NOW }).status.note).toBe(NO_SNAPSHOT_NOTE);
        expect(combatRatesFromSnapshot({}, { now: NOW }).status.note).toBe(NO_SNAPSHOT_NOTE);
    });
});

describe('loadCombatRates', () => {
    test('the first sight of a run records the loadout it is judged against', async () => {
        sim.snapshot = snapshot();

        const { best, status } = await loadCombatRates({ now: NOW });
        expect(best.zoneName).toBe('Fly Zone');
        expect(status.gearChanged).toBe(false);
        expect(game.gear.baseline).toEqual({ savedAt: NOW - 3 * DAY, signature: SWORD_5, name: 'Fighting' });
    });

    test('changing the combat loadout afterwards is what raises the flag', async () => {
        sim.snapshot = snapshot();
        await loadCombatRates({ now: NOW });

        game.loadouts = [
            loadout('Fighting', {
                isDefault: true,
                equipment: [
                    { itemLocationHrid: '/item_locations/main_hand', itemHrid: '/items/axe', enhancementLevel: 0 },
                ],
            }),
        ];

        const { status } = await loadCombatRates({ now: NOW });
        expect(status.gearChanged).toBe(true);
        // And the baseline is not quietly rewritten to the new gear, which
        // would clear the warning on the very next refresh
        expect(game.gear.baseline.signature).toBe(SWORD_5);
    });

    test('putting on skilling gear is not a reason to re-run a four-hour simulation', async () => {
        sim.snapshot = snapshot();
        await loadCombatRates({ now: NOW });

        game.equipment = new Map([['/item_locations/head', { itemHrid: '/items/chefs_hat', enhancementLevel: 0 }]]);

        const { status } = await loadCombatRates({ now: NOW });
        expect(status.gearChanged).toBe(false);
        expect(status.note).toBeNull();
    });

    test('a newer run starts a new baseline rather than inheriting the old one', async () => {
        sim.snapshot = snapshot();
        await loadCombatRates({ now: NOW });

        game.loadouts = [
            loadout('Fighting', {
                isDefault: true,
                equipment: [
                    { itemLocationHrid: '/item_locations/main_hand', itemHrid: '/items/axe', enhancementLevel: 0 },
                ],
            }),
        ];
        sim.snapshot = snapshot({ savedAt: NOW - HOUR });

        const { status } = await loadCombatRates({ now: NOW });
        expect(status.gearChanged).toBe(false);
        expect(game.gear.baseline.savedAt).toBe(NOW - HOUR);
    });

    test('skips the gear comparison when asked to', async () => {
        sim.snapshot = snapshot();
        game.gear = { preferred: null, baseline: { savedAt: NOW - 3 * DAY, signature: 'something-else' } };

        const { status } = await loadCombatRates({ now: NOW, compareGear: false });
        expect(status.gearChanged).toBe(false);
        expect(status.loadoutName).toBeNull();
    });

    test('the stored pick is what the check uses', async () => {
        sim.snapshot = snapshot();
        game.loadouts = [loadout('Fighting', { isDefault: true }), loadout('Ranged')];
        game.gear = { preferred: 'Ranged', baseline: null };

        const { status } = await loadCombatRates({ now: NOW });
        expect(status.loadoutName).toBe('Ranged');
        expect(game.gear.baseline.name).toBe('Ranged');
    });

    test('a storage failure reads as "no run", not as a crash', async () => {
        sim.loadThrows = true;
        vi.spyOn(console, 'error').mockImplementation(() => {});

        const { rates, status } = await loadCombatRates({ now: NOW });
        expect(rates).toEqual([]);
        expect(status.note).toBe(NO_SNAPSHOT_NOTE);

        vi.restoreAllMocks();
    });
});
