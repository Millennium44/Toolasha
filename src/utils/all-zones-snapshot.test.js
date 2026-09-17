import { describe, test, expect, vi } from 'vitest';

vi.mock('../core/storage.js', () => ({ default: { setJSON: async () => true, getJSON: async () => null } }));
vi.mock('./character-key.js', () => ({
    characterKey: (key) => `${key}_char1`,
    readScoped: async () => null,
}));

import { bestSoloZone, zoneFromSnapshot, snapshotLoadout } from './all-zones-snapshot.js';

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
    test('finds the row for a zone at its tier, with the snapshot dating it', () => {
        const row = zoneFromSnapshot(snapshot, '/actions/combat/rat', 1);

        expect(row).toEqual({
            zoneName: 'Rat',
            zoneHrid: '/actions/combat/rat',
            difficultyTier: 1,
            profitPerHour: 400_000,
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
