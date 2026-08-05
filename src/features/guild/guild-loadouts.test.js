/**
 * Loadout snapshots.
 *
 * The two things worth asserting: that a payload with no stat sheet on it
 * produces nothing at all — `battle_unit_fetched` arrives at the end of every
 * combat session carrying loot totals, and a record written from one would
 * replace a real sheet with an empty one dated now — and that the record keeps
 * the moment each sighting happened, because that is the whole honesty of the
 * feature.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    clientData: {},
    store: {},
}));

vi.mock('../../core/data-manager.js', () => ({
    default: { getInitClientData: () => game.clientData },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) => (key in game.store ? game.store[key] : fallback),
        set: async (key, value) => {
            game.store[key] = value;
            return true;
        },
    },
}));

const {
    buildLoadoutRows,
    describeLoadoutAge,
    extractLoadout,
    extractPartyLoadouts,
    foldLoadout,
    guildLoadoutsStorageKey,
    loadLoadouts,
    loadoutList,
    MAX_LOADOUTS,
    readAbilities,
    saveLoadouts,
} = await import('./guild-loadouts.js');

const now = Date.parse('2026-08-04T12:00:00Z');

/**
 * A unit as `battle_unit_fetched` carries one.
 * @param {Object} overrides - Fields to override
 * @returns {Object} The message
 */
function unitMessage(overrides = {}) {
    return {
        unit: {
            character: { id: 'char-1', name: 'Tib' },
            combatDetails: {
                combatLevel: 150,
                maxHitpoints: 4120,
                totalArmor: 62,
                magicEvasionRating: 1240,
                combatStats: { combatRareFind: 0.12, criticalRate: 0.05, curse: 0 },
            },
            combatAbilities: [{ abilityHrid: '/abilities/fireball', level: 40 }],
            ...overrides,
        },
    };
}

describe('buildLoadoutRows', () => {
    test('keeps a flat rating of zero and drops a ratio of zero', () => {
        const rows = buildLoadoutRows({ totalArmor: 0 }, { curse: 0, criticalRate: 0.05 });
        const labels = rows.map((entry) => entry.label);

        expect(labels).toContain('Armor');
        expect(labels).not.toContain('Curse');
        expect(rows.find((entry) => entry.label === 'Crit rate').value).toBe('5.0%');
    });

    test('absent fields are absent rather than nought', () => {
        expect(buildLoadoutRows({}, {})).toEqual([]);
    });
});

describe('readAbilities', () => {
    test('names abilities through client data, and falls back to the hrid', () => {
        game.clientData = { abilityDetailMap: { '/abilities/fireball': { name: 'Fireball' } } };
        expect(readAbilities([{ abilityHrid: '/abilities/fireball', level: 40 }])).toEqual([
            { hrid: '/abilities/fireball', level: 40, label: 'Fireball' },
        ]);

        game.clientData = {};
        expect(readAbilities([{ abilityHrid: '/abilities/frost_surge' }])[0]).toMatchObject({
            label: 'frost surge',
            level: null,
        });
    });

    test('tolerates anything that is not a list', () => {
        expect(readAbilities(null)).toEqual([]);
        expect(readAbilities([{}, { abilityHrid: '' }])).toEqual([]);
    });
});

describe('extractLoadout', () => {
    beforeEach(() => {
        game.clientData = {};
    });

    test('reads a stat sheet off a fetched unit', () => {
        const loadout = extractLoadout(unitMessage(), { at: now });

        expect(loadout.name).toBe('Tib');
        expect(loadout.characterId).toBe('char-1');
        expect(loadout.level).toBe(150);
        expect(loadout.abilities).toHaveLength(1);
        expect(loadout.rows.map((entry) => entry.label)).toContain('Magic evasion');
        expect(loadout.stats.combatRareFind).toBeCloseTo(0.12);
        expect(loadout.at).toBe(now);
    });

    test('the end-of-session message carries no sheet and produces nothing', () => {
        const message = { unit: { character: { name: 'Tib' }, totalLootMap: { 0: { itemHrid: '/items/coin' } } } };
        expect(extractLoadout(message)).toBeNull();
    });

    test('a monster is not a guild member', () => {
        expect(
            extractLoadout({ unit: { name: 'Chimerical Beast', combatDetails: { maxHitpoints: 900_000 } } })
        ).toBeNull();
    });

    test('an explicit player without a character object still counts', () => {
        const loadout = extractLoadout({
            unit: { name: 'Moo', isPlayer: true, combatDetails: { maxHitpoints: 900 } },
        });
        expect(loadout?.name).toBe('Moo');
    });

    test('nonsense in, null out', () => {
        expect(extractLoadout(null)).toBeNull();
        expect(extractLoadout({})).toBeNull();
        expect(extractLoadout({ unit: {} })).toBeNull();
    });
});

describe('extractPartyLoadouts', () => {
    test('every player in a battle, and nothing else', () => {
        const loadouts = extractPartyLoadouts(
            {
                players: [
                    { character: { name: 'Tib' }, combatDetails: { maxHitpoints: 4120, combatStats: {} } },
                    { character: { name: 'Moo' } },
                ],
            },
            { at: now }
        );

        expect(loadouts).toHaveLength(1);
        expect(loadouts[0]).toMatchObject({ name: 'Tib', source: 'new_battle' });
    });
});

describe('foldLoadout', () => {
    test('the newest sighting wins, even when it is thinner', () => {
        const fat = { name: 'Tib', at: now, rows: [1, 2, 3], source: 'battle_unit_fetched' };
        const thin = { name: 'Tib', at: now + 1000, rows: [1], source: 'popup' };

        const record = foldLoadout(foldLoadout(null, fat), thin);
        expect(record.players.tib.source).toBe('popup');
    });

    test('an older sighting does not overwrite a newer one', () => {
        const newer = { name: 'Tib', at: now + 1000, rows: [1] };
        const older = { name: 'Tib', at: now, rows: [1, 2] };

        const record = foldLoadout(foldLoadout(null, newer), older);
        expect(record.players.tib.at).toBe(now + 1000);
    });

    test('the oldest sightings fall off the end', () => {
        let record = null;
        for (let index = 0; index < MAX_LOADOUTS + 5; index += 1) {
            record = foldLoadout(record, { name: `Player${index}`, at: now + index, rows: [1] });
        }

        expect(Object.keys(record.players)).toHaveLength(MAX_LOADOUTS);
        expect(record.players.player0).toBeUndefined();
    });

    test('a snapshot without a name changes nothing', () => {
        const record = foldLoadout({ players: { tib: { name: 'Tib', at: now } }, updatedAt: now }, null);
        expect(Object.keys(record.players)).toEqual(['tib']);
    });
});

describe('loadoutList', () => {
    test('most recently seen first', () => {
        const record = { players: { a: { name: 'A', at: 1 }, b: { name: 'B', at: 2 } } };
        expect(loadoutList(record).map((entry) => entry.name)).toEqual(['B', 'A']);
    });

    test('an empty record is an empty list, not a crash', () => {
        expect(loadoutList(null)).toEqual([]);
        expect(loadoutList({ players: 'nonsense' })).toEqual([]);
    });
});

describe('describeLoadoutAge', () => {
    test('says when, and says so even when it cannot', () => {
        expect(describeLoadoutAge(now - 60_000, now)).toMatch(/^seen /);
        expect(describeLoadoutAge(null)).toMatch(/unknown/);
    });
});

describe('storage', () => {
    beforeEach(() => {
        game.store = {};
    });

    test('round-trips under the viewing character’s key', async () => {
        const record = foldLoadout(null, { name: 'Tib', at: now, rows: [1] });
        await saveLoadouts('char-1', record);

        expect(game.store[guildLoadoutsStorageKey('char-1')]).toBeDefined();
        expect((await loadLoadouts('char-1')).players.tib.name).toBe('Tib');
    });

    test('an empty record is not written over a real one', async () => {
        await saveLoadouts('char-1', foldLoadout(null, { name: 'Tib', at: now, rows: [1] }));
        await saveLoadouts('char-1', { players: {}, updatedAt: 0 });

        expect((await loadLoadouts('char-1')).players.tib).toBeDefined();
    });

    test('an alt reads its own record, not this one’s', async () => {
        await saveLoadouts('char-1', foldLoadout(null, { name: 'Tib', at: now, rows: [1] }));
        expect(await loadLoadouts('char-2')).toEqual({ players: {}, updatedAt: 0 });
    });
});
