import { describe, test, expect, vi } from 'vitest';

const memory = vi.hoisted(() => new Map());

vi.mock('../core/storage.js', () => ({
    default: {
        setJSON: async (key, value) => {
            memory.set(key, structuredClone(value));
            return true;
        },
        getJSON: async (key, _store, fallback) => (memory.has(key) ? structuredClone(memory.get(key)) : fallback),
    },
}));
vi.mock('./character-key.js', () => ({
    characterKey: (key) => `${key}_char1`,
    readScoped: async () => null,
}));

import {
    bestSoloZone,
    zoneFromSnapshot,
    snapshotLoadout,
    snapshotPartySize,
    zoneSimRatePartySize,
    zoneSimRateKey,
    zoneSimRateFor,
    loadoutSignature,
    saveZoneSimRate,
    loadZoneSimRates,
    ZONE_SIM_RATES_LIMIT,
} from './all-zones-snapshot.js';

const snapshot = {
    savedAt: 1_754_000_000_000,
    fingerprint: 'abc',
    loadout: { source: 'loadout', name: 'Fighting' },
    zones: [
        {
            zoneHrid: '/actions/combat/fly',
            zoneName: 'Fly',
            difficultyTier: 0,
            profitPerHour: 100_000,
            encountersPerHour: 240,
        },
        {
            zoneHrid: '/actions/combat/chimerical_den',
            zoneName: 'Chimerical Den',
            difficultyTier: 0,
            profitPerHour: 900_000,
        },
        {
            zoneHrid: '/actions/combat/rat',
            zoneName: 'Rat',
            difficultyTier: 1,
            profitPerHour: 400_000,
            encountersPerHour: 180,
        },
        { zoneHrid: '/actions/combat/gnome', zoneName: 'Gnome', difficultyTier: 0, profitPerHour: null },
    ],
};

describe('bestSoloZone', () => {
    test('picks the most profitable zone that is not a dungeon', () => {
        const best = bestSoloZone(snapshot, {
            isDungeonZone: (hrid) => hrid === '/actions/combat/chimerical_den',
        });

        expect(best).toMatchObject({ zoneName: 'Rat', profitPerHour: 400_000, savedAt: snapshot.savedAt });
    });

    test('without a predicate every zone competes', () => {
        // Most zones are not dungeons, and a caller without game data still
        // deserves an answer rather than a null
        expect(bestSoloZone(snapshot).zoneName).toBe('Chimerical Den');
    });

    test('a zone the predicate cannot classify is kept', () => {
        const best = bestSoloZone(snapshot, { isDungeonZone: () => undefined });
        expect(best.zoneName).toBe('Chimerical Den');
    });

    test('nothing stored is nothing to compare against', () => {
        expect(bestSoloZone(null)).toBeNull();
        expect(bestSoloZone({ zones: [] })).toBeNull();
        expect(bestSoloZone({ zones: [{ zoneHrid: '/a', profitPerHour: null }] })).toBeNull();
    });
});

describe('zoneFromSnapshot', () => {
    test('carries the run gross when the snapshot has one', () => {
        const withGross = {
            ...snapshot,
            zones: snapshot.zones.map((zone) => ({ ...zone, revenuePerHour: 520_000 })),
        };
        expect(zoneFromSnapshot(withGross, '/actions/combat/rat', 1).revenuePerHour).toBe(520_000);
    });

    test('finds the row for a zone at its tier, with the snapshot dating it', () => {
        const row = zoneFromSnapshot(snapshot, '/actions/combat/rat', 1);

        expect(row).toEqual({
            zoneName: 'Rat',
            zoneHrid: '/actions/combat/rat',
            difficultyTier: 1,
            profitPerHour: 400_000,
            // This fixture predates the gross, which is exactly what a snapshot on disk from
            // before it was kept looks like: no answer, rather than the net one repeated
            revenuePerHour: null,
            xpPerHour: null,
            encountersPerHour: 180,
            savedAt: snapshot.savedAt,
            fingerprint: snapshot.fingerprint,
            loadout: { source: 'loadout', name: 'Fighting' },
        });
    });

    /**
     * Snapshots are persisted per character, so runs written before the rate and
     * its provenance existed are still on disk. Neither may read as a figure: a
     * zero encounters-per-hour is a fight that never ends, and an invented
     * loadout is a match nobody can refute.
     */
    test('a run written before the encounter rate existed has no reading, not a zero', () => {
        const old = {
            savedAt: 1,
            fingerprint: 'abc',
            zones: [{ zoneHrid: '/a', zoneName: 'A', difficultyTier: 0, profitPerHour: 5 }],
        };
        const row = zoneFromSnapshot(old, '/a', 0);

        // Everything the old readers asked for is still answered
        expect(row.profitPerHour).toBe(5);
        expect(row.encountersPerHour).toBeNull();
        expect(row.loadout).toBeNull();
    });

    test('an encounter rate of zero is no reading either', () => {
        const zeroed = { zones: [{ zoneHrid: '/a', profitPerHour: 5, encountersPerHour: 0 }] };
        expect(zoneFromSnapshot(zeroed, '/a', 0).encountersPerHour).toBeNull();
    });
});

describe('snapshotLoadout', () => {
    test('says which gear a run was configured from', () => {
        expect(snapshotLoadout(snapshot)).toEqual({ source: 'loadout', name: 'Fighting' });
    });

    test('a run from worn gear names no loadout, and says so rather than guessing one', () => {
        expect(snapshotLoadout({ loadout: { source: 'worn', name: null } })).toEqual({ source: 'worn', name: null });
    });

    test('a run that never said is null, not a loadout that matches nothing', () => {
        expect(snapshotLoadout(null)).toBeNull();
        expect(snapshotLoadout({ savedAt: 1 })).toBeNull();
    });

    test('the tier must match — tier 1 of a zone is not tier 0 of it', () => {
        expect(zoneFromSnapshot(snapshot, '/actions/combat/rat', 0)).toBeNull();
        expect(zoneFromSnapshot(snapshot, '/actions/combat/rat', 2)).toBeNull();
    });

    test('an unstated tier is tier 0 on both sides', () => {
        expect(zoneFromSnapshot(snapshot, '/actions/combat/fly').zoneName).toBe('Fly');
        expect(zoneFromSnapshot({ zones: [{ zoneHrid: '/a', profitPerHour: 5 }] }, '/a', 0).profitPerHour).toBe(5);
    });

    test('a row without a profit figure is no answer, not a zero', () => {
        expect(zoneFromSnapshot(snapshot, '/actions/combat/gnome', 0)).toBeNull();
    });

    test('nothing stored, or a zone the sim never ran, is null', () => {
        expect(zoneFromSnapshot(null, '/actions/combat/rat', 1)).toBeNull();
        expect(zoneFromSnapshot({ zones: [] }, '/actions/combat/rat', 1)).toBeNull();
        expect(zoneFromSnapshot(snapshot, '/actions/combat/nowhere', 0)).toBeNull();
        expect(zoneFromSnapshot(snapshot, null, 0)).toBeNull();
    });
});

describe('single-zone rates', () => {
    const entry = (overrides = {}) => ({
        zoneHrid: '/actions/combat/fly',
        difficultyTier: 2,
        loadoutId: '41704',
        loadoutName: 'Combat',
        signature: 'sig',
        encountersPerHour: 300,
        profitPerHour: 5,
        xpPerHour: 7,
        hours: 24,
        savedAt: 100,
        ...overrides,
    });
    const FLY = '/actions/combat/fly';

    test('are filed by zone, tier and loadout id', () => {
        expect(zoneSimRateKey(FLY, 2, 41704)).toBe('/actions/combat/fly|2|41704');
        expect(zoneSimRateKey(FLY)).toBe('/actions/combat/fly|0|0');
    });

    test('are found only for the same zone, tier and loadout', () => {
        const rates = { [zoneSimRateKey(FLY, 2, 41704)]: entry() };
        expect(zoneSimRateFor(rates, FLY, 2, 41704)).toMatchObject({
            encountersPerHour: 300,
            loadoutId: '41704',
            loadoutName: 'Combat',
            hours: 24,
            savedAt: 100,
        });
        expect(zoneSimRateFor(rates, FLY, 2, 41705)).toBeNull();
        expect(zoneSimRateFor(rates, FLY, 1, 41704)).toBeNull();
        expect(zoneSimRateFor(null, FLY, 2, 41704)).toBeNull();
    });

    test('a rate of zero or none is no answer', () => {
        const key = zoneSimRateKey(FLY, 2, 41704);
        expect(zoneSimRateFor({ [key]: entry({ encountersPerHour: 0 }) }, FLY, 2, 41704)).toBeNull();
        expect(zoneSimRateFor({ [key]: entry({ encountersPerHour: null }) }, FLY, 2, 41704)).toBeNull();
    });

    test('a loadout signature changes with the gear, not with order or levels', () => {
        const base = {
            equipment: [
                { itemHrid: '/items/a', enhancementLevel: 1 },
                { itemHrid: '/items/b', enhancementLevel: 2 },
            ],
            abilities: [{ abilityHrid: '/abilities/x' }],
            food: [{ itemHrid: '/items/f' }, { itemHrid: '' }],
            drinks: [],
        };
        const reordered = {
            ...base,
            equipment: [...base.equipment].reverse().map((e) => ({ ...e, enhancementLevel: 9 })),
        };
        const swapped = { ...base, equipment: [{ itemHrid: '/items/a' }, { itemHrid: '/items/c' }] };
        expect(loadoutSignature(reordered)).toBe(loadoutSignature(base));
        expect(loadoutSignature(swapped)).not.toBe(loadoutSignature(base));
        expect(loadoutSignature(null)).toBeNull();
    });

    test('saving one writes its own key and leaves the all-zones snapshot untouched', async () => {
        memory.clear();
        const allZones = structuredClone(snapshot);
        memory.set('allZonesSnapshot_char1', allZones);

        const saved = await saveZoneSimRate('zoneSimRates_char1', entry({ loadoutName: 'Tank', loadoutId: '41705' }));

        expect(saved).toBe(true);
        expect(memory.get('allZonesSnapshot_char1')).toBe(allZones);
        expect(allZones).toEqual(snapshot);
        expect(Object.keys(await loadZoneSimRates())).toEqual(['/actions/combat/fly|2|41705']);
    });

    test('saving replaces the same key, and drops the oldest past the limit', async () => {
        memory.clear();
        for (let i = 0; i < ZONE_SIM_RATES_LIMIT + 5; i++) {
            await saveZoneSimRate('zoneSimRates_char1', entry({ loadoutId: String(i), savedAt: i }));
        }
        await saveZoneSimRate('zoneSimRates_char1', entry({ loadoutId: '104', savedAt: 999, encountersPerHour: 1 }));
        const rates = await loadZoneSimRates();
        expect(Object.keys(rates)).toHaveLength(ZONE_SIM_RATES_LIMIT);
        expect(rates['/actions/combat/fly|2|0']).toBeUndefined();
        expect(rates['/actions/combat/fly|2|104'].encountersPerHour).toBe(1);
    });

    test('saving without a key stores nothing', async () => {
        memory.clear();
        expect(await saveZoneSimRate(null, entry())).toBe(false);
        expect(memory.size).toBe(0);
    });
});

describe('the party a stored run was simulated with', () => {
    test('a recorded size is read back, solo included', () => {
        expect(snapshotPartySize({ partySize: 3 })).toBe(3);
        expect(snapshotPartySize({ partySize: 1 })).toBe(1);
    });

    test('a snapshot written before the field says nothing rather than saying solo', () => {
        expect(snapshotPartySize({ zones: [] })).toBeNull();
        expect(snapshotPartySize(null)).toBeNull();
        expect(snapshotPartySize({ partySize: 0 })).toBeNull();
        expect(snapshotPartySize({ partySize: 'three' })).toBeNull();
    });
});

describe('the party a stored single-zone rate was simulated with', () => {
    test('a recorded size is read back, solo included', () => {
        expect(zoneSimRatePartySize({ partySize: 3 })).toBe(3);
        expect(zoneSimRatePartySize({ partySize: 1 })).toBe(1);
    });

    test('an entry saved before the field existed says nothing rather than saying solo', () => {
        expect(zoneSimRatePartySize({ zoneHrid: '/actions/combat/fly' })).toBeNull();
        expect(zoneSimRatePartySize(null)).toBeNull();
        expect(zoneSimRatePartySize({ partySize: 0 })).toBeNull();
        expect(zoneSimRatePartySize({ partySize: 'three' })).toBeNull();
    });
});
