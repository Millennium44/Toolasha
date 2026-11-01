/**
 * A `characterActions` / `endCharacterAction(s)` entry. Captured on the test server,
 * 2026-11-01 (MillenniumTest, MillenniumIC3). `characterLoadoutID` is the
 * `characterLoadoutMap` key, `0` when the action runs with No Loadout.
 * `ordinal` orders the queue; the running action is the first by ordinal.
 */

export function buildCharacterAction(overrides = {}) {
    return {
        id: 900001,
        characterID: 900001,
        partyID: 0,
        actionHrid: '/actions/milking/cow',
        difficultyTier: 0,
        hasMaxCount: false,
        maxCount: 0,
        currentCount: 0,
        wave: 0,
        primaryItemHash: '',
        secondaryItemHash: '',
        enhancingMaxLevel: 0,
        characterLoadoutID: 0,
        ordinal: 1,
        isDone: false,
        createdAt: '2026-11-01T00:00:00.000000000Z',
        updatedAt: '2026-11-01T00:00:00.000000000Z',
        ...overrides,
    };
}
