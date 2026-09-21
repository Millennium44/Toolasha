/**
 * The choice of which recorded cohorts a replay runs, on its own.
 *
 * The end-to-end behaviour is pinned in `labyrinth-sim-cache.test.js`; what is
 * here is the two things that decide whether a stored choice survives the day
 * it was made: the key it is stored against, and the rule that refuses it.
 */

import { describe, test, expect, vi } from 'vitest';

vi.mock('../../core/storage.js', () => ({ default: { get: async () => null, set: async () => true } }));
vi.mock('../../core/data-manager.js', () => ({ default: { getCurrentCharacterId: () => 'me' } }));

const { replayCohortKey, describeReplayCohorts, applyReplayCohortSelection } =
    await import('./labyrinth-replay-selection.js');

/** One `replayCandidates` entry, keyed apart by its attack level */
const candidate = (attackLevel, over = {}) => ({
    group: { monsterHrid: '/monsters/fly', bucket: 10, roomLevel: 10, levelLow: 10, levelHigh: 10, fights: 5, ...over },
    inputs: {
        version: 1,
        playerDTO: { hrid: 'player1', attackLevel },
        crates: [],
        communityBuffs: {},
        labyrinthCombatBuffs: [],
        fullAbilities: true,
    },
    exploratory: false,
});

describe('replayCohortKey', () => {
    test('survives the level median drifting as more fights land', () => {
        // `roomLevel` is the median of the levels recorded so far and moves on
        // its own; the bucket is the group identity and does not. A key built
        // on the median would make every stored choice stale by tomorrow.
        const before = replayCohortKey(candidate(10, { roomLevel: 10, levelHigh: 10 }));
        const after = replayCohortKey(candidate(10, { roomLevel: 13, levelHigh: 14, fights: 9 }));
        expect(after).toBe(before);
    });

    test('tells two builds on the same room apart', () => {
        expect(replayCohortKey(candidate(10))).not.toBe(replayCohortKey(candidate(11)));
    });

    test('keys a legacy cohort with no saved inputs under the current build', () => {
        const key = replayCohortKey({ group: { monsterHrid: '/monsters/fly', bucket: 20 }, inputs: null });
        expect(key).toBe('current|/monsters/fly|20');
    });
});

describe('describeReplayCohorts', () => {
    test('carries the build label and the fight count the picker tells cohorts apart by', () => {
        const [described] = describeReplayCohorts([candidate(10)], {});
        expect(described.buildLabel).toMatch(/^Build [0-9a-f]{8} /);
        expect(described).toMatchObject({ monsterHrid: '/monsters/fly', roomLevel: 10, fights: 5, exploratory: false });
    });

    test('says outright that a legacy cohort has no saved inputs', () => {
        const [described] = describeReplayCohorts([
            { group: { monsterHrid: '/monsters/fly', bucket: 10 }, inputs: null },
        ]);
        expect(described.buildLabel).toBe('Current build (no saved inputs)');
        expect(described.inputSource).toBe('current');
    });
});

describe('applyReplayCohortSelection', () => {
    const candidates = [candidate(10), candidate(11), candidate(12), candidate(13)];
    const keys = candidates.map((entry) => replayCohortKey(entry));

    test('no selection is the old default: the first three, untouched', () => {
        for (const empty of [null, undefined, []]) {
            const { chosen, selection } = applyReplayCohortSelection(candidates, empty);
            expect(chosen).toEqual(candidates.slice(0, 3));
            expect(selection).toEqual({ applied: false, requested: 0, reason: 'empty' });
        }
    });

    test('a valid selection runs exactly those cohorts', () => {
        const { chosen, selection } = applyReplayCohortSelection(candidates, [keys[3]]);
        expect(chosen).toEqual([candidates[3]]);
        expect(selection).toMatchObject({ applied: true, requested: 1 });
    });

    test('an over-cap selection is refused rather than cut down to three', () => {
        const { chosen, selection } = applyReplayCohortSelection(candidates, keys);
        expect(chosen).toEqual(candidates.slice(0, 3));
        expect(selection).toMatchObject({ applied: false, reason: 'overCap', requested: 4 });
    });

    test('a selection naming a cohort that no longer exists is dropped whole', () => {
        // Not run as "the ones that survived": a choice about a pool that has
        // regrouped is not a smaller choice, it is a choice about nothing
        const { chosen, selection } = applyReplayCohortSelection(candidates, [keys[0], 'evicted|/monsters/fly|10']);
        expect(chosen).toEqual(candidates.slice(0, 3));
        expect(selection).toMatchObject({ applied: false, reason: 'stale', requested: 2 });
    });

    test('duplicates in a stored selection do not count against the cap', () => {
        const { chosen, selection } = applyReplayCohortSelection(candidates, [keys[0], keys[0], keys[1]]);
        expect(chosen).toEqual([candidates[0], candidates[1]]);
        expect(selection).toMatchObject({ applied: true, requested: 2 });
    });
});
