import { describe, test, expect, vi } from 'vitest';

vi.mock('../core/storage.js', () => ({ default: { setJSON: async () => true, getJSON: async () => null } }));
vi.mock('./character-key.js', () => ({
    characterKey: (key) => `${key}_char1`,
    readScoped: async () => null,
}));

import { bestSoloZone } from './all-zones-snapshot.js';

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
