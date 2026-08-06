import { describe, test, expect, vi } from 'vitest';

vi.mock('../core/storage.js', () => ({ default: { setJSON: async () => true, getJSON: async () => null } }));
vi.mock('./character-key.js', () => ({
    characterKey: (key) => `${key}_char1`,
    readScoped: async () => null,
}));

import { bestSoloZone, zoneFromSnapshot } from './all-zones-snapshot.js';

const snapshot = {
    savedAt: 1_754_000_000_000,
    fingerprint: 'abc',
    zones: [
        { zoneHrid: '/actions/combat/fly', zoneName: 'Fly', difficultyTier: 0, profitPerHour: 100_000 },
        {
            zoneHrid: '/actions/combat/chimerical_den',
            zoneName: 'Chimerical Den',
            difficultyTier: 0,
            profitPerHour: 900_000,
        },
        { zoneHrid: '/actions/combat/rat', zoneName: 'Rat', difficultyTier: 1, profitPerHour: 400_000 },
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
            savedAt: snapshot.savedAt,
            fingerprint: snapshot.fingerprint,
        });
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
